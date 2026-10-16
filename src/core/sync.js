'use strict';
// The save sync engine. Pure Node, no Electron, so it can be tested on its own.
//
// Shared folder layout, per game:
//   games/<id>/state.json   { generation, hashes, deviceId, deviceName, pushedAt }
//   games/<id>/current/<ruleId>/<relative file path>
//   games/<id>/history/<timestamp>-<pc>[-kind]/{meta.json, files/<ruleId>/...}
//   games/<id>/lock.json    present while the game is open on some PC
//
// "lastSync" is what THIS PC last agreed with the shared folder: { generation, hashes }.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fsu = require('./fsutil');
const { expand } = require('./paths');
const limits = require('./limits');
const { HashCache } = require('./hashcache');
const reg = require('./registry');
const os = require('os');

/** The pretend file a registry save rule syncs as (see core/registry.js). */
const REGISTRY_FILE = '__registry__.json';
const isRegistryRule = (rule) => rule && rule.kind === 'registry';

// One sync at a time per game, across every engine in the program (a new engine is made whenever
// settings change): the startup upload, Play, Sync now, a restore or an import of the same game must
// never copy the same files at the same moment. Different games don't wait for each other.
const gameLocks = new Map(); // gameId -> promise of the work in progress

function exclusive(gameId, fn) {
  const prev = gameLocks.get(gameId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  gameLocks.set(gameId, tail);
  tail.then(() => { if (gameLocks.get(gameId) === tail) gameLocks.delete(gameId); });
  return run;
}

/** Ids of games with a sync (or restore/import) running or waiting right now. */
function busyGames() { return [...gameLocks.keys()]; }

class SyncError extends Error {
  constructor(code, message, info) {
    super(message);
    this.code = code;
    this.info = info;
  }
}

function sameHashes(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Decide what to do. Returns one of:
 *   'nothing'  – both sides match what we last synced
 *   'push'     – only this PC changed
 *   'pull'     – only the shared folder changed
 *   'adopt'    – both changed but ended up identical; just record it
 *   'conflict' – both changed differently; the user must choose
 * An empty save folder is never uploaded over saves in the cloud: those come down instead.
 */
function decide(localHashes, cloudState, lastSync) {
  const hasLocal = Object.keys(localHashes).length > 0;
  if (!cloudState) return hasLocal ? 'push' : 'nothing';
  // No saves here but some in the cloud: bring them down, never "upload" the emptiness. A save folder
  // that's missing for a moment (a drive not plugged in, a game reinstalled) must not wipe the cloud copy.
  if (!hasLocal) return Object.keys(cloudState.hashes || {}).length ? 'pull' : 'nothing';
  if (!lastSync) return sameHashes(localHashes, cloudState.hashes) ? 'adopt' : 'conflict';
  const localChanged = !sameHashes(localHashes, lastSync.hashes);
  const cloudChanged = cloudState.generation !== lastSync.generation;
  // The version this PC last agreed on isn't among the uploads the cloud copy grew from: another PC
  // uploaded without having seen it (both uploaded at the same moment, so one replaced the other).
  // That's a conflict to choose, not a download that would quietly bury this PC's saves in History.
  const skipped = cloudChanged && Array.isArray(cloudState.lineage) && !!lastSync.generation && !cloudState.lineage.includes(lastSync.generation);
  if (!localChanged && !cloudChanged) return 'nothing';
  if (localChanged && !cloudChanged) return 'push';
  if (!localChanged && cloudChanged && !skipped) return 'pull';
  return sameHashes(localHashes, cloudState.hashes) ? 'adopt' : 'conflict';
}

/** How many earlier uploads a sync record remembers (to notice an upload that was replaced). */
const LINEAGE = 100;
function lineageAfter(prev) { return prev ? [prev.generation, ...(prev.lineage || [])].filter(Boolean).slice(0, LINEAGE) : []; }

/**
 * Counts the files (and bytes) one step of a sync has copied, and reports them through
 * onProgress({ phase, done, total, bytes, totalBytes }). Does nothing without a callback.
 * phase: 'upload' | 'backup' | 'download'.
 */
class Progress {
  constructor(onProgress, phase, total, totalBytes = 0) {
    Object.assign(this, { cb: onProgress, phase, total, totalBytes, done: 0, bytes: 0 });
    this.report();
  }

  step(bytes = 0) {
    this.done++;
    this.bytes += bytes || 0;
    this.report();
  }

  report() {
    if (!this.cb) return;
    try {
      this.cb({ phase: this.phase, done: this.done, total: this.total, bytes: this.bytes, totalBytes: this.totalBytes });
    } catch { /* a broken listener must never break a sync */ }
  }
}

function totalSize(local, keys) {
  return keys.reduce((n, k) => n + ((local.sizes && local.sizes[k]) || 0), 0);
}

class SyncEngine {
  /**
   * @param {object} o
   * @param {string} o.cloudDir     the shared folder
   * @param {string} o.deviceId
   * @param {string} o.deviceName
   * @param {object} o.roots        from paths.defaultRoots()
   * @param {number} [o.historyDepth=10]
   * @param {string} [o.platform]
   * @param {HashCache} [o.hashCache]  remembers file hashes between checks (and runs, if it has a file)
   * @param {object} [o.registry]  registry access for registry save rules (Windows: WindowsRegistry)
   * @param {string} [o.stateDir]  a folder on this PC for working files (registry exports)
   */
  constructor(o) {
    this.cloudDir = o.cloudDir;
    this.deviceId = o.deviceId;
    this.deviceName = o.deviceName || 'PC';
    this.roots = o.roots;
    this.historyDepth = o.historyDepth || 10;
    this.platform = o.platform || process.platform;
    this.hashCache = o.hashCache || new HashCache(null);
    this.registry = o.registry !== undefined ? o.registry : (this.platform === 'win32' ? new reg.WindowsRegistry() : null);
    this.stateDir = o.stateDir || path.join(os.tmpdir(), 'vn-shelf-work');
    this.regCache = null; // { at, map } the last registry export, reused briefly by status checks
  }

  gameDir(id) { return path.join(this.cloudDir, 'games', id); }

  async cloudAvailable() { return fsu.isDir(this.cloudDir); }

  async requireCloud() {
    if (!(await this.cloudAvailable())) {
      throw new SyncError('cloud-unavailable', `The shared folder isn't reachable: ${this.cloudDir}`);
    }
  }

  /** Resolve each save rule to an absolute folder on this PC (registry rules: abs null, registry true). */
  resolveRules(game, installDir) {
    return (game.saves || []).map((rule) => {
      if (isRegistryRule(rule)) return { rule, abs: null, registry: true };
      try {
        return { rule, abs: expand(rule.path, { roots: this.roots, gameDir: installDir, platform: this.platform }) };
      } catch (e) {
        return { rule, abs: null, error: e.message };
      }
    });
  }

  /**
   * The files in one save location that would sync, after the safety filters (no programs, video,
   * archives, caches, logs or huge single files). Stops counting just past the hard limit.
   */
  async listRuleFiles(abs, rule) {
    const match = fsu.makeMatcher(rule.include, rule.exclude);
    const rels = await fsu.walk(abs, {
      filter: match, prune: (_r, name) => limits.skipDir(name), limit: limits.LIMITS.hardFiles * 2,
    });
    const files = [];
    const skipped = { type: 0, size: 0 };
    let bytes = 0;
    for (const rel of rels) {
      let st;
      try { st = await fsp.stat(path.join(abs, ...rel.split('/')), { bigint: true }); } catch { continue; }
      const size = Number(st.size);
      const why = limits.skipFile(rel, size);
      if (why) { skipped[why]++; continue; }
      files.push({ rel, size, mtimeNs: st.mtimeNs });
      bytes += size;
      if (files.length > limits.LIMITS.hardFiles || bytes > limits.LIMITS.hardBytes) break;
    }
    return { files, count: files.length, bytes, skipped };
  }

  /** Hash every save file on this PC. Returns { files: {key: abs}, hashes: {key: sha1}, sizes: {key: bytes} }. */
  async scanLocal(game, installDir, { fresh = true } = {}) {
    await this.hashCache.load();
    const files = {};
    const hashes = {};
    const sizes = {};
    await this.scanRegistry(game, { files, hashes, sizes }, { fresh });
    for (const { rule, abs } of this.resolveRules(game, installDir)) {
      if (!abs || !(await fsu.isDir(abs))) continue;
      const why = limits.rejectPath(rule.path, rule.include, { cloudDir: this.cloudDir, abs, platform: this.platform });
      if (why) throw new SyncError('bad-path', `Save location ${rule.path} isn't allowed: ${why}`, { rule: rule.id });
      const m = await this.listRuleFiles(abs, rule);
      if (limits.judge({ files: m.count, bytes: m.bytes }, { confirmed: true }) === 'refuse') {
        throw new SyncError('too-big',
          `The save location ${rule.path} has grown too big to sync (over ${limits.describeSize({ files: limits.LIMITS.hardFiles, bytes: limits.LIMITS.hardBytes })}). ` +
          'Narrow it to the actual save files on the game page.', { rule: rule.id });
      }
      for (const { rel, size, mtimeNs } of m.files) {
        const key = `${rule.id}/${rel}`;
        const p = path.join(abs, ...rel.split('/'));
        try {
          // Unchanged files (same size and modified time as last time) aren't read again.
          hashes[key] = await this.hashCache.hash(p, { size, mtimeNs });
          files[key] = p;
          sizes[key] = size;
        } catch (e) {
          // A file deleted mid-scan is gone. One we can't read (the game has it locked) must not be
          // left out: the next upload would then delete it on the other PC.
          if (e.code !== 'ENOENT') throw new SyncError('busy', `Couldn't read ${rel} (${e.code || e.message}). If the game is still open, close it and sync again.`, { rule: rule.id });
        }
      }
    }
    return { files, hashes, sizes };
  }

  /**
   * Registry save rules: export each key and stage it as a file (stateDir/<game>/<rule>.json), so it
   * syncs like one. Status checks (fresh: false) may reuse an export up to 20 s old.
   */
  async scanRegistry(game, out, { fresh = true } = {}) {
    const rules = (game.saves || []).filter(isRegistryRule);
    if (!rules.length) return;
    if (!this.registry) throw new SyncError('registry-unsupported', 'This game keeps saves in the Windows registry, which only syncs on Windows.');
    const keys = rules.map((r) => r.key);
    let map;
    const c = this.regCache;
    if (!fresh && c && Date.now() - c.at < 20000 && keys.every((k) => c.map.has(k))) map = c.map;
    else {
      map = await this.registry.exportKeys(keys);
      this.regCache = { at: Date.now(), map: new Map([...((c && c.map) || []), ...map]) };
    }
    for (const rule of rules) {
      const data = map.get(rule.key);
      if (!data) continue; // the key doesn't exist (yet) on this PC
      const text = reg.canonical(data);
      const file = path.join(this.stateDir, 'registry', game.id, `${rule.id}.json`);
      const old = await fsp.readFile(file, 'utf8').catch(() => null);
      if (old !== text) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, text); }
      const key = `${rule.id}/${REGISTRY_FILE}`;
      out.files[key] = file;
      out.hashes[key] = reg.sha1(text);
      out.sizes[key] = Buffer.byteLength(text);
    }
  }

  /** Put a registry export (text of a __registry__.json) back into the registry. */
  async applyRegistry(rule, text) {
    if (!this.registry) throw new SyncError('registry-unsupported', 'This game keeps saves in the Windows registry, which only syncs on Windows.');
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!reg.valid(data)) throw new SyncError('cloud-incomplete', 'This game\'s registry save in the cloud is damaged or incomplete, so it wasn\'t applied.');
    await fsp.mkdir(this.stateDir, { recursive: true });
    await this.registry.importKey(rule.key, data, path.join(this.stateDir, `import-${process.pid}-${Date.now()}.json`));
    this.regCache = null;
  }

  async readCloudState(id) {
    const file = path.join(this.gameDir(id), 'state.json');
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new SyncError('cloud-incomplete', `Couldn't read this game's sync record in the shared folder (${e.code}). Try again in a moment.`);
    }
    try { return JSON.parse(text); } catch {
      // Half-downloaded by the sync app, most likely. Treating it as "no cloud copy" would upload over it.
      throw new SyncError('cloud-incomplete', 'This game\'s sync record in the shared folder is incomplete (the sync app may still be downloading it). Try again in a moment.');
    }
  }

  /** Check that the files in a snapshot folder match the hashes it claims (i.e. the sync client has finished). */
  async verifySnapshot(dir, hashes) {
    await this.hashCache.load();
    const missing = [];
    for (const [key, h] of Object.entries(hashes || {})) {
      const p = path.join(dir, ...key.split('/'));
      try {
        if ((await this.hashCache.hash(p)) !== h) missing.push(key);
      } catch { missing.push(key); }
    }
    return missing;
  }

  /** Work out the sync status without changing anything. */
  async status(game, installDir, lastSync, opts = {}) { // eslint-disable-line no-unused-vars
    if (!(await this.cloudAvailable())) return { action: 'offline' };
    const local = await this.scanLocal(game, installDir, { fresh: false });
    const cloud = await this.readCloudState(game.id);
    return { action: decide(local.hashes, cloud, lastSync), local, cloud };
  }

  /**
   * Bring this PC and the shared folder in line.
   * @param {'local'|'cloud'} [resolution] how to settle a conflict
   * @param {function} [onProgress]       see Progress
   * @param {'push'} [only]                 only upload; anything else (download, conflict) is left alone
   * @param {function} [beforePull]         async () => false stops a download (e.g. the game is open)
   * @returns {Promise<{action:string, lastSync:object, cloud:object}>}
   */
  sync(game, installDir, lastSync, opts = {}) {
    return exclusive(game.id, () => this.syncNow(game, installDir, lastSync, opts));
  }

  async syncNow(game, installDir, lastSync, { resolution, onProgress, only, beforePull } = {}) {
    await this.requireCloud();
    const local = await this.scanLocal(game, installDir);
    const cloud = await this.readCloudState(game.id);
    let action = decide(local.hashes, cloud, lastSync);
    if (only === 'push' && action !== 'push') return { action: 'skipped', cloud, lastSync };

    if (action === 'conflict') {
      if (resolution === 'local') action = 'push';
      else if (resolution === 'cloud') action = 'pull';
      else {
        throw new SyncError('conflict', 'Saves changed on this PC and on another PC since the last sync.', {
          local: { files: Object.keys(local.hashes).length, deviceName: this.deviceName },
          cloud: { files: Object.keys(cloud.hashes || {}).length, deviceName: cloud.deviceName, pushedAt: cloud.pushedAt },
        });
      }
    }

    if (action === 'push') {
      const state = await this.push(game, local, { onProgress });
      return { action, cloud: state, lastSync: { generation: state.generation, hashes: state.hashes } };
    }
    if (action === 'pull') {
      if (beforePull && !(await beforePull())) {
        throw new SyncError('game-running', 'This game is open right now. Close it first, then try again: if saves came down now, the open game could write its older saves back over them.');
      }
      await this.pull(game, installDir, local, cloud, { onProgress });
      return { action, cloud, lastSync: { generation: cloud.generation, hashes: cloud.hashes } };
    }
    if (action === 'adopt') {
      return { action, cloud, lastSync: { generation: cloud.generation, hashes: cloud.hashes } };
    }
    // 'nothing'
    return { action, cloud, lastSync: cloud ? { generation: cloud.generation, hashes: cloud.hashes } : lastSync || null };
  }

  /** Copy this PC's saves into the shared folder as the new current version. */
  async push(game, local, { onProgress } = {}) {
    const gdir = this.gameDir(game.id);
    const stamp = fsu.timestamp();
    const tmp = path.join(gdir, `.incoming-${this.deviceId.slice(0, 8)}-${stamp}`);
    await this.cleanIncoming(gdir);
    await fsu.rmrf(tmp);
    await fsp.mkdir(tmp, { recursive: true });

    // Hash the copies, not the originals: the game may be writing while we copy.
    const hashes = {};
    const keys = Object.keys(local.files);
    const progress = new Progress(onProgress, 'upload', keys.length, totalSize(local, keys));
    for (const [key, src] of Object.entries(local.files)) {
      const dest = path.join(tmp, ...key.split('/'));
      try {
        await fsu.copyFile(src, dest);
        hashes[key] = await fsu.hashFile(dest);
      } catch (e) {
        // A file deleted since the scan is simply gone. Any other failure (the game has it locked,
        // a disk error) stops the upload: an upload missing files would delete them on the other PC.
        if (e.code !== 'ENOENT') {
          await fsu.rmrf(tmp).catch(() => {});
          throw new SyncError('busy', `Couldn't read ${path.basename(src)} (${e.code || e.message}). If the game is still open, close it and sync again.`);
        }
      }
      progress.step(local.sizes && local.sizes[key]);
    }
    if (!Object.keys(hashes).length) {
      // Every file vanished between the scan and the copy: nothing to upload, and an empty upload
      // would clear the other PC's saves.
      await fsu.rmrf(tmp).catch(() => {});
      throw new SyncError('busy', 'The save files disappeared while uploading. Try again in a moment.');
    }

    // Each upload gets its own folder, named after it, so two PCs uploading at the same moment through
    // a sync app can never end up with a mix of each other's files: the sync record says which folder
    // is current, and the other upload's folder is kept apart (and moved to History later).
    const generation = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = `current-${generation}`;
    const prev = await this.readCloudState(game.id);
    const prevDir = path.join(gdir, (prev && prev.dir) || 'current');
    if (await fsu.exists(prevDir)) {
      await this.archive(game.id, prevDir, prev, 'pushed', { move: true });
    }
    await fsu.moveDir(tmp, path.join(gdir, dir));

    const state = {
      generation,
      dir,
      lineage: lineageAfter(prev),
      hashes,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      pushedAt: new Date().toISOString(),
    };
    await fsu.writeJson(path.join(gdir, 'state.json'), state);
    await this.rotateHistory(game.id);
    return state;
  }

  /**
   * Housekeeping, at most once a day per folder: remove upload folders left by a push that never
   * finished (a crash, a power cut), and move uploads that another PC's upload replaced (their folder
   * isn't the current one any more) into History, where they can still be restored.
   */
  async cleanIncoming(gdir) {
    let names = [];
    try { names = await fsp.readdir(gdir); } catch { return; }
    const DAY = 24 * 3600 * 1000;
    const old = async (n) => { const st = await fsp.stat(path.join(gdir, n)).catch(() => null); return st && Date.now() - st.mtimeMs > DAY; };
    for (const n of names.filter((x) => x.startsWith('.incoming-'))) {
      if (await old(n)) await fsu.rmrf(path.join(gdir, n)).catch(() => {});
    }
    const id = path.basename(gdir);
    let state = null;
    try { state = await this.readCloudState(id); } catch { return; }
    if (!state) return;
    const current = state.dir || 'current';
    // Other copies of the sync record that sync apps made say whose upload a folder was.
    const copies = [];
    for (const n of names.filter((x) => x !== 'state.json' && /^state.*\.json$/.test(x) && fsu.isSyncDuplicate(x))) {
      const j = await fsu.readJson(path.join(gdir, n));
      if (j && j.generation) copies.push(j);
    }
    for (const n of names.filter((x) => (x === 'current' || x.startsWith('current-')) && x !== current)) {
      if (!(await old(n))) continue;
      const known = copies.find((c) => (c.dir || 'current') === n);
      const src = path.join(gdir, n);
      const hashes = known ? known.hashes : await this.hashTree(src);
      await this.archive(id, src, { ...(known || {}), deviceName: (known && known.deviceName) || 'another PC', pushedAt: (known && known.pushedAt) || new Date().toISOString(), hashes }, 'replaced', { move: true }).catch(() => {});
    }
  }

  /** {relative path: sha1} for every file under dir. */
  async hashTree(dir) {
    const out = {};
    for (const rel of await fsu.walk(dir)) out[rel] = await fsu.hashFile(path.join(dir, ...rel.split('/')));
    return out;
  }

  /** Copy the shared folder's current saves onto this PC, backing up what's here first. */
  async pull(game, installDir, local, cloud, { onProgress } = {}) {
    const current = path.join(this.gameDir(game.id), cloud.dir || 'current');
    const bad = await this.verifySnapshot(current, cloud.hashes);
    if (bad.length) {
      throw new SyncError('cloud-incomplete',
        `The shared folder hasn't finished syncing yet (${bad.length} file(s) missing or different). Try again in a moment.`,
        { files: bad.slice(0, 20) });
    }
    await this.backupLocal(game, local, 'before-pull', { onProgress });
    await this.apply(game, installDir, current, cloud.hashes, local, { onProgress });
  }

  /** Make the save folders on this PC match a snapshot folder exactly. */
  async apply(game, installDir, srcDir, hashes, local, { onProgress } = {}) {
    const changed = Object.entries(hashes).filter(([key, h]) => local.hashes[key] !== h).length;
    const progress = new Progress(onProgress, 'download', changed);
    for (const { rule, abs, error, registry } of this.resolveRules(game, installDir)) {
      if (registry) {
        // The registry key is replaced as a whole; a key missing on the other side is left alone.
        const key = `${rule.id}/${REGISTRY_FILE}`;
        if (key in hashes && local.hashes[key] !== hashes[key]) {
          await this.applyRegistry(rule, await fsp.readFile(path.join(srcDir, ...key.split('/')), 'utf8'));
          progress.step();
        }
        continue;
      }
      if (!abs) throw new SyncError('bad-path', `Can't resolve save location ${rule.path}: ${error}`);
      const prefix = `${rule.id}/`;
      // Remove files that no longer exist on the other side (they were backed up first).
      for (const [key, p] of Object.entries(local.files)) {
        if (key.startsWith(prefix) && !(key in hashes)) await fsp.rm(p, { force: true });
      }
      for (const [key, h] of Object.entries(hashes)) {
        if (!key.startsWith(prefix)) continue;
        if (local.hashes[key] === h) continue;
        const rel = key.slice(prefix.length).split('/');
        const dest = path.join(abs, ...rel);
        await fsu.copyFile(path.join(srcDir, ...key.split('/')), dest);
        progress.step(await fsp.stat(dest).then((st) => st.size, () => 0));
      }
    }
  }

  /** Copy this PC's current saves into history, so an overwrite can always be undone. */
  async backupLocal(game, local, kind, { onProgress } = {}) {
    if (!Object.keys(local.files).length) return null;
    const keys = Object.keys(local.files);
    const progress = new Progress(onProgress, 'backup', keys.length, totalSize(local, keys));
    let name = `${fsu.timestamp()}-${fsu.safeName(this.deviceName)}-${kind}`;
    if (await fsu.exists(path.join(this.gameDir(game.id), 'history', name))) name += `-${crypto.randomBytes(2).toString('hex')}`;
    const dir = path.join(this.gameDir(game.id), 'history', name);
    for (const [key, src] of Object.entries(local.files)) {
      await fsu.copyFile(src, path.join(dir, 'files', ...key.split('/')));
      progress.step(local.sizes && local.sizes[key]);
    }
    await fsu.writeJson(path.join(dir, 'meta.json'), {
      kind, deviceName: this.deviceName, at: new Date().toISOString(), hashes: local.hashes,
    });
    await this.rotateHistory(game.id);
    return name;
  }

  /** Move (or copy) a snapshot folder into history with its metadata. */
  async archive(id, srcDir, state, kind, { move } = {}) {
    const who = state ? state.deviceName : 'unknown';
    const when = state && state.pushedAt ? new Date(state.pushedAt) : new Date();
    let name = `${fsu.timestamp(when)}-${fsu.safeName(who)}`;
    const hist = path.join(this.gameDir(id), 'history');
    if (await fsu.exists(path.join(hist, name))) name += `-${crypto.randomBytes(2).toString('hex')}`;
    const dir = path.join(hist, name);
    if (move) await fsu.moveDir(srcDir, path.join(dir, 'files'));
    else await fsp.cp(srcDir, path.join(dir, 'files'), { recursive: true, preserveTimestamps: true });
    await fsu.writeJson(path.join(dir, 'meta.json'), {
      kind, deviceName: who, at: state ? state.pushedAt : when.toISOString(),
      generation: state ? state.generation : null, hashes: state ? state.hashes : {},
    });
    return name;
  }

  async listHistory(id) {
    const hist = path.join(this.gameDir(id), 'history');
    let names;
    try { names = await fsp.readdir(hist); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (fsu.isSyncDuplicate(name)) continue; // a sync app's copy of a backup folder
      const meta = await fsu.readJson(path.join(hist, name, 'meta.json'));
      if (!meta) continue;
      out.push({ name, ...meta, files: Object.keys(meta.hashes || {}).length });
    }
    return out.sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  async rotateHistory(id) {
    const all = await this.listHistory(id);
    for (const old of all.slice(this.historyDepth)) {
      await fsu.rmrf(path.join(this.gameDir(id), 'history', old.name));
    }
  }

  /** Put an old version back on this PC and make it the new shared version. */
  restore(game, installDir, name) {
    return exclusive(game.id, () => this.restoreNow(game, installDir, name));
  }

  async restoreNow(game, installDir, name) {
    await this.requireCloud();
    const dir = path.join(this.gameDir(game.id), 'history', name);
    const meta = await fsu.readJson(path.join(dir, 'meta.json'));
    if (!meta) throw new SyncError('not-found', `No such backup: ${name}`);
    const src = path.join(dir, 'files');
    const bad = await this.verifySnapshot(src, meta.hashes);
    if (bad.length) throw new SyncError('cloud-incomplete', 'That backup is incomplete in the shared folder.', { files: bad });
    const local = await this.scanLocal(game, installDir);
    await this.backupLocal(game, local, 'before-restore');
    await this.apply(game, installDir, src, meta.hashes, local);
    const fresh = await this.scanLocal(game, installDir);
    const state = await this.push(game, fresh);
    return { generation: state.generation, hashes: state.hashes };
  }

  // ---- "is it open on the other PC?" lock ----

  async readLock(id, opts = {}) { // eslint-disable-line no-unused-vars
    const lock = await fsu.readJson(path.join(this.gameDir(id), 'lock.json'));
    if (!lock) return null;
    const ageH = (Date.now() - new Date(lock.since).getTime()) / 3.6e6;
    return { ...lock, mine: lock.deviceId === this.deviceId, stale: ageH > 12 };
  }

  async takeLock(id) {
    await fsu.writeJson(path.join(this.gameDir(id), 'lock.json'), {
      deviceId: this.deviceId, deviceName: this.deviceName, since: new Date().toISOString(),
    });
  }

  async releaseLock(id) {
    const lock = await this.readLock(id);
    if (lock && lock.mine) await fsp.rm(path.join(this.gameDir(id), 'lock.json'), { force: true });
  }
}

module.exports = { SyncEngine, SyncError, Progress, decide, sameHashes, totalSize, exclusive, busyGames, REGISTRY_FILE, isRegistryRule, lineageAfter };
