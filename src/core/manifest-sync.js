'use strict';
// Sync engine for API-backed storage (Google Drive). Instead of copying folders around, each save
// file is stored once under its SHA-1 ("blob"), and a small manifest says which blob each save path
// uses:
//   state.json    { generation, hashes: {"<rule>/<path>": sha1}, deviceId, deviceName, pushedAt }
//   history.json  { entries: [ { name, kind, deviceName, at, generation, hashes } ] }   newest first
//   lock.json     present while the game is open on some PC
//   b-<sha1>      file contents
// A push uploads missing blobs first and writes state.json last, so another PC never sees a
// manifest that points at a blob that isn't there yet.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fsu = require('./fsutil');
const { SyncEngine, SyncError, decide } = require('./sync');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class ManifestSyncEngine extends SyncEngine {
  /**
   * @param {object} o  same as SyncEngine, plus:
   * @param {import('./stores').BaseStore} o.store
   * @param {string} [o.label]        how to name the storage in messages ("Google Drive")
   * @param {number} [o.gcGraceMs]    unreferenced blobs younger than this are kept (another PC may be mid-push)
   */
  constructor(o) {
    super({ ...o, cloudDir: '' });
    this.store = o.store;
    this.label = o.label || 'Google Drive';
    this.gcGraceMs = o.gcGraceMs === undefined ? 3600 * 1000 : o.gcGraceMs;
  }

  async cloudAvailable() { return this.store.available(); }

  async requireCloud() {
    if (!(await this.cloudAvailable())) throw new SyncError('cloud-unavailable', `Can't reach ${this.label} right now.`);
  }

  async readCloudState(id) {
    if (this.store.refresh) this.store.refresh(id);
    return this.store.readJson(id, 'state.json');
  }

  async sync(game, installDir, lastSync, { resolution } = {}) {
    await this.requireCloud();
    const local = await this.scanLocal(game, installDir);
    const cloud = await this.readCloudState(game.id);
    let action = decide(local.hashes, cloud, lastSync);
    if (action === 'conflict') {
      if (resolution === 'local') action = 'push';
      else if (resolution === 'cloud') action = 'pull';
      else throw this.conflictError(local, cloud);
    }
    const expected = cloud ? cloud.generation : null;
    if (action === 'push') {
      const state = await this.push(game, local, { expected });
      return { action, cloud: state, lastSync: { generation: state.generation, hashes: state.hashes } };
    }
    if (action === 'pull') {
      await this.pull(game, installDir, local, cloud);
      return { action, cloud, lastSync: { generation: cloud.generation, hashes: cloud.hashes } };
    }
    return { action, cloud, lastSync: cloud ? { generation: cloud.generation, hashes: cloud.hashes } : lastSync || null };
  }

  conflictError(local, cloud) {
    return new SyncError('conflict', 'Saves changed on this PC and on another PC since the last sync.', {
      local: { files: Object.keys(local.hashes).length, deviceName: this.deviceName },
      cloud: { files: Object.keys((cloud && cloud.hashes) || {}).length, deviceName: cloud && cloud.deviceName, pushedAt: cloud && cloud.pushedAt },
    });
  }

  /** Upload any of this PC's save files the store doesn't have yet. Returns {key: sha1} of what was read. */
  async uploadBlobs(gameId, local) {
    await this.store.createGame(gameId);
    const blobs = await this.store.listBlobs(gameId);
    const hashes = {};
    for (const [key, p] of Object.entries(local.files)) {
      let buf;
      try { buf = await fsp.readFile(p); } catch { continue; } // vanished since the scan
      const h = sha1(buf); // hash what we actually read; the game may have written since the scan
      hashes[key] = h;
      if (!blobs.has(h)) {
        await this.store.putBlob(gameId, h, buf);
        blobs.set(h, { modified: Date.now() });
      }
    }
    return hashes;
  }

  /**
   * Make this PC's saves the new current version.
   * @param {object} [o]
   * @param {string|null} [o.expected]  generation we based the decision on; if the store moved on
   *                                    meanwhile (another PC pushed), refuse instead of overwriting
   */
  async push(game, local, { expected } = {}) {
    const id = game.id;
    const hashes = await this.uploadBlobs(id, local);
    if (this.store.refresh) this.store.refresh(id);
    const prev = await this.store.readJson(id, 'state.json');
    if (expected !== undefined && (prev ? prev.generation : null) !== expected) {
      throw this.conflictError({ hashes }, prev);
    }
    if (prev) await this.addHistory(id, { ...prev, kind: 'pushed', at: prev.pushedAt });
    const state = {
      generation: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      hashes,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      pushedAt: new Date().toISOString(),
    };
    await this.store.writeJson(id, 'state.json', state);
    await this.gc(id).catch(() => {}); // housekeeping only; never fail a push over it
    return state;
  }

  async pull(game, installDir, local, cloud) {
    await this.requireBlobs(game.id, cloud.hashes);
    await this.backupLocal(game, local, 'before-pull');
    await this.applyFromStore(game, installDir, cloud.hashes, local);
  }

  async requireBlobs(gameId, hashes) {
    const blobs = await this.store.listBlobs(gameId);
    const missing = Object.entries(hashes || {}).filter(([, h]) => !blobs.has(h)).map(([k]) => k);
    if (missing.length) {
      throw new SyncError('cloud-incomplete',
        `${missing.length} save file(s) are missing from ${this.label}. Another PC may still be uploading; try again in a moment.`,
        { files: missing.slice(0, 20) });
    }
  }

  /** Make this PC's save folders match a manifest exactly. */
  async applyFromStore(game, installDir, hashes, local) {
    for (const { rule, abs, error } of this.resolveRules(game, installDir)) {
      if (!abs) throw new SyncError('bad-path', `Can't resolve save location ${rule.path}: ${error}`);
      const prefix = `${rule.id}/`;
      for (const [key, p] of Object.entries(local.files)) {
        if (key.startsWith(prefix) && !(key in hashes)) await fsp.rm(p, { force: true });
      }
      for (const [key, h] of Object.entries(hashes)) {
        if (!key.startsWith(prefix) || local.hashes[key] === h) continue;
        const buf = await this.store.getBlob(game.id, h);
        if (!buf || sha1(buf) !== h) {
          throw new SyncError('cloud-incomplete', `A save file in ${this.label} is missing or damaged (${key}).`);
        }
        const dest = path.join(abs, ...key.slice(prefix.length).split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.vns-tmp`;
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, dest);
      }
    }
  }

  /** Keep a copy of this PC's current saves in history before anything overwrites them. */
  async backupLocal(game, local, kind) {
    if (!Object.keys(local.files).length) return null;
    const hashes = await this.uploadBlobs(game.id, local);
    return this.addHistory(game.id, {
      kind, deviceName: this.deviceName, at: new Date().toISOString(), generation: null, hashes,
    });
  }

  async readHistory(id) {
    const h = await this.store.readJson(id, 'history.json');
    return h && Array.isArray(h.entries) ? h.entries : [];
  }

  async addHistory(id, e) {
    const entries = await this.readHistory(id);
    const who = fsu.safeName(e.deviceName || 'unknown');
    let name = `${fsu.timestamp(e.at ? new Date(e.at) : new Date())}-${who}${e.kind && e.kind !== 'pushed' ? `-${e.kind}` : ''}`;
    if (entries.some((x) => x.name === name)) name += `-${crypto.randomBytes(2).toString('hex')}`;
    entries.push({ name, kind: e.kind, deviceName: e.deviceName, at: e.at, generation: e.generation || null, hashes: e.hashes || {} });
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    await this.store.writeJson(id, 'history.json', { entries: entries.slice(0, this.historyDepth) });
    return name;
  }

  async listHistory(id) {
    if (this.store.refresh) this.store.refresh(id);
    return (await this.readHistory(id)).map((e) => ({ ...e, files: Object.keys(e.hashes || {}).length }));
  }

  async rotateHistory() { /* addHistory already trims */ }

  /** Delete blobs nothing refers to any more (older than the grace period). */
  async gc(id) {
    const state = await this.store.readJson(id, 'state.json');
    const keep = new Set(Object.values((state && state.hashes) || {}));
    for (const e of await this.readHistory(id)) for (const h of Object.values(e.hashes || {})) keep.add(h);
    const now = Date.now();
    for (const [h, f] of await this.store.listBlobs(id)) {
      if (!keep.has(h) && now - (f.modified || now) > this.gcGraceMs) await this.store.deleteBlob(id, h);
    }
  }

  async restore(game, installDir, name) {
    await this.requireCloud();
    const entry = (await this.readHistory(game.id)).find((e) => e.name === name);
    if (!entry) throw new SyncError('not-found', `No such backup: ${name}`);
    await this.requireBlobs(game.id, entry.hashes);
    const local = await this.scanLocal(game, installDir);
    await this.backupLocal(game, local, 'before-restore');
    await this.applyFromStore(game, installDir, entry.hashes, local);
    const fresh = await this.scanLocal(game, installDir);
    const state = await this.push(game, fresh);
    return { generation: state.generation, hashes: state.hashes };
  }

  // ---- "is it open on the other PC?" lock

  async readLock(id) {
    if (this.store.refresh) this.store.refresh(id);
    const lock = await this.store.readJson(id, 'lock.json');
    if (!lock) return null;
    const ageH = (Date.now() - new Date(lock.since).getTime()) / 3.6e6;
    return { ...lock, mine: lock.deviceId === this.deviceId, stale: ageH > 12 };
  }

  async takeLock(id) {
    await this.store.writeJson(id, 'lock.json', { deviceId: this.deviceId, deviceName: this.deviceName, since: new Date().toISOString() });
  }

  async releaseLock(id) {
    const lock = await this.readLock(id);
    if (lock && lock.mine) await this.store.deleteFile(id, 'lock.json');
  }
}

module.exports = { ManifestSyncEngine, sha1 };
