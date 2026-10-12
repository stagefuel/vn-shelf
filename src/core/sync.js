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
 */
function decide(localHashes, cloudState, lastSync) {
  const hasLocal = Object.keys(localHashes).length > 0;
  if (!cloudState) return hasLocal ? 'push' : 'nothing';
  if (!lastSync) {
    if (!hasLocal) return 'pull';
    return sameHashes(localHashes, cloudState.hashes) ? 'adopt' : 'conflict';
  }
  const localChanged = !sameHashes(localHashes, lastSync.hashes);
  const cloudChanged = cloudState.generation !== lastSync.generation;
  if (!localChanged && !cloudChanged) return 'nothing';
  if (localChanged && !cloudChanged) return 'push';
  if (!localChanged && cloudChanged) return 'pull';
  return sameHashes(localHashes, cloudState.hashes) ? 'adopt' : 'conflict';
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
   */
  constructor(o) {
    this.cloudDir = o.cloudDir;
    this.deviceId = o.deviceId;
    this.deviceName = o.deviceName || 'PC';
    this.roots = o.roots;
    this.historyDepth = o.historyDepth || 10;
    this.platform = o.platform || process.platform;
  }

  gameDir(id) { return path.join(this.cloudDir, 'games', id); }

  async cloudAvailable() { return fsu.isDir(this.cloudDir); }

  async requireCloud() {
    if (!(await this.cloudAvailable())) {
      throw new SyncError('cloud-unavailable', `The shared folder isn't reachable: ${this.cloudDir}`);
    }
  }

  /** Resolve each save rule to an absolute folder on this PC. */
  resolveRules(game, installDir) {
    return (game.saves || []).map((rule) => {
      try {
        return { rule, abs: expand(rule.path, { roots: this.roots, gameDir: installDir, platform: this.platform }) };
      } catch (e) {
        return { rule, abs: null, error: e.message };
      }
    });
  }

  /** Hash every save file on this PC. Returns { files: {key: abs}, hashes: {key: sha1} }. */
  async scanLocal(game, installDir) {
    const files = {};
    const hashes = {};
    for (const { rule, abs } of this.resolveRules(game, installDir)) {
      if (!abs || !(await fsu.isDir(abs))) continue;
      const match = fsu.makeMatcher(rule.include, rule.exclude);
      for (const rel of await fsu.walk(abs, { filter: match })) {
        const key = `${rule.id}/${rel}`;
        const p = path.join(abs, ...rel.split('/'));
        try {
          hashes[key] = await fsu.hashFile(p);
          files[key] = p;
        } catch { /* file vanished mid-scan; ignore */ }
      }
    }
    return { files, hashes };
  }

  async readCloudState(id) {
    return fsu.readJson(path.join(this.gameDir(id), 'state.json'));
  }

  /** Check that the files in a snapshot folder match the hashes it claims (i.e. the sync client has finished). */
  async verifySnapshot(dir, hashes) {
    const missing = [];
    for (const [key, h] of Object.entries(hashes || {})) {
      const p = path.join(dir, ...key.split('/'));
      try {
        if ((await fsu.hashFile(p)) !== h) missing.push(key);
      } catch { missing.push(key); }
    }
    return missing;
  }

  /** Work out the sync status without changing anything. */
  async status(game, installDir, lastSync) {
    if (!(await this.cloudAvailable())) return { action: 'offline' };
    const local = await this.scanLocal(game, installDir);
    const cloud = await this.readCloudState(game.id);
    return { action: decide(local.hashes, cloud, lastSync), local, cloud };
  }

  /**
   * Bring this PC and the shared folder in line.
   * @param {'local'|'cloud'} [resolution] how to settle a conflict
   * @returns {Promise<{action:string, lastSync:object, cloud:object}>}
   */
  async sync(game, installDir, lastSync, { resolution } = {}) {
    await this.requireCloud();
    const local = await this.scanLocal(game, installDir);
    const cloud = await this.readCloudState(game.id);
    let action = decide(local.hashes, cloud, lastSync);

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
      const state = await this.push(game, local);
      return { action, cloud: state, lastSync: { generation: state.generation, hashes: state.hashes } };
    }
    if (action === 'pull') {
      await this.pull(game, installDir, local, cloud);
      return { action, cloud, lastSync: { generation: cloud.generation, hashes: cloud.hashes } };
    }
    if (action === 'adopt') {
      return { action, cloud, lastSync: { generation: cloud.generation, hashes: cloud.hashes } };
    }
    // 'nothing'
    return { action, cloud, lastSync: cloud ? { generation: cloud.generation, hashes: cloud.hashes } : lastSync || null };
  }

  /** Copy this PC's saves into the shared folder as the new current version. */
  async push(game, local) {
    const gdir = this.gameDir(game.id);
    const stamp = fsu.timestamp();
    const tmp = path.join(gdir, `.incoming-${this.deviceId.slice(0, 8)}-${stamp}`);
    await fsu.rmrf(tmp);
    await fsp.mkdir(tmp, { recursive: true });

    // Hash the copies, not the originals: the game may be writing while we copy.
    const hashes = {};
    for (const [key, src] of Object.entries(local.files)) {
      const dest = path.join(tmp, ...key.split('/'));
      try {
        await fsu.copyFile(src, dest);
        hashes[key] = await fsu.hashFile(dest);
      } catch { /* vanished; skip */ }
    }

    const current = path.join(gdir, 'current');
    const prev = await this.readCloudState(game.id);
    if (await fsu.exists(current)) {
      await this.archive(game.id, current, prev, 'pushed', { move: true });
    }
    await fsu.moveDir(tmp, current);

    const state = {
      generation: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      hashes,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      pushedAt: new Date().toISOString(),
    };
    await fsu.writeJson(path.join(gdir, 'state.json'), state);
    await this.rotateHistory(game.id);
    return state;
  }

  /** Copy the shared folder's current saves onto this PC, backing up what's here first. */
  async pull(game, installDir, local, cloud) {
    const current = path.join(this.gameDir(game.id), 'current');
    const bad = await this.verifySnapshot(current, cloud.hashes);
    if (bad.length) {
      throw new SyncError('cloud-incomplete',
        `The shared folder hasn't finished syncing yet (${bad.length} file(s) missing or different). Try again in a moment.`,
        { files: bad.slice(0, 20) });
    }
    await this.backupLocal(game, local, 'before-pull');
    await this.apply(game, installDir, current, cloud.hashes, local);
  }

  /** Make the save folders on this PC match a snapshot folder exactly. */
  async apply(game, installDir, srcDir, hashes, local) {
    for (const { rule, abs, error } of this.resolveRules(game, installDir)) {
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
        await fsu.copyFile(path.join(srcDir, ...key.split('/')), path.join(abs, ...rel));
      }
    }
  }

  /** Copy this PC's current saves into history, so an overwrite can always be undone. */
  async backupLocal(game, local, kind) {
    if (!Object.keys(local.files).length) return null;
    let name = `${fsu.timestamp()}-${fsu.safeName(this.deviceName)}-${kind}`;
    if (await fsu.exists(path.join(this.gameDir(game.id), 'history', name))) name += `-${crypto.randomBytes(2).toString('hex')}`;
    const dir = path.join(this.gameDir(game.id), 'history', name);
    for (const [key, src] of Object.entries(local.files)) {
      await fsu.copyFile(src, path.join(dir, 'files', ...key.split('/')));
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
  async restore(game, installDir, name) {
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

  async readLock(id) {
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

module.exports = { SyncEngine, SyncError, decide, sameHashes };
