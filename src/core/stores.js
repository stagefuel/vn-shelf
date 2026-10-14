'use strict';
// Storage back-ends for the manifest sync engine. Each game is a "container" holding a few named
// files (game.json, cover, state.json, history.json, lock.json) and content-addressed save blobs
// (b-<sha1>). Two implementations share this interface:
//   DriveStore – Google Drive (one "VN Shelf" folder, one subfolder per game)
//   DirStore   – a plain local folder (used by tests; same layout on disk)

const fsp = require('fs').promises;
const path = require('path');
const fsu = require('./fsutil');
const { DriveError, FOLDER, q } = require('./gdrive');

class BaseStore {
  async readJson(gameId, name, opts = {}) { // eslint-disable-line no-unused-vars
    const buf = await this.getFile(gameId, name);
    if (!buf) return null;
    try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
  }

  async writeJson(gameId, name, obj) {
    await this.putFile(gameId, name, Buffer.from(JSON.stringify(obj, null, 2)), 'application/json');
  }

  async listBlobs(gameId) {
    const out = new Map();
    for (const f of await this.list(gameId)) {
      if (f.name.startsWith('b-')) out.set(f.name.slice(2), f);
    }
    return out;
  }

  putBlob(gameId, hash, buf) { return this.putFile(gameId, `b-${hash}`, buf); }

  getBlob(gameId, hash) { return this.getFile(gameId, `b-${hash}`); }

  deleteBlob(gameId, hash) { return this.deleteFile(gameId, `b-${hash}`); }
}

// --------------------------------------------------------------------------------- local folder

class DirStore extends BaseStore {
  constructor(rootDir) {
    super();
    this.root = rootDir;
    this.kind = 'folder';
  }

  dir(gameId) { return path.join(this.root, 'games', gameId); }

  async available() { return fsu.isDir(this.root); }

  async listGames() {
    try {
      return (await fsp.readdir(path.join(this.root, 'games'), { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch { return []; }
  }

  async createGame(gameId) { await fsp.mkdir(this.dir(gameId), { recursive: true }); }

  async removeGame(gameId) {
    await fsu.moveDir(this.dir(gameId), path.join(this.root, 'games', '.removed', `${gameId}-${fsu.timestamp()}`));
  }

  async getFile(gameId, name) {
    try { return await fsp.readFile(path.join(this.dir(gameId), name)); } catch { return null; }
  }

  async putFile(gameId, name, buf) {
    const p = path.join(this.dir(gameId), name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, p);
  }

  async deleteFile(gameId, name) { await fsp.rm(path.join(this.dir(gameId), name), { force: true }); }

  async list(gameId) {
    let names;
    try { names = await fsp.readdir(this.dir(gameId)); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      try {
        const st = await fsp.stat(path.join(this.dir(gameId), name));
        if (st.isFile()) out.push({ name, size: st.size, modified: st.mtimeMs });
      } catch { /* gone */ }
    }
    return out;
  }

  /** Read one named JSON file from every game (e.g. all game.json). */
  async readAll(name) {
    const out = new Map();
    for (const id of await this.listGames()) {
      const j = await this.readJson(id, name);
      if (j) out.set(id, j);
    }
    return out;
  }
}

// --------------------------------------------------------------------------------- Google Drive

const CHILD_TTL_MS = 15000;
// The small per-game files the library and the sync badges need, read for every game in one query.
const SNAPSHOT_NAMES = ['game.json', 'state.json', 'lock.json'];

class DriveStore extends BaseStore {
  /** @param {import('./gdrive').DriveClient} client */
  /**
   * @param {object} [o]
   * @param {string} [o.cacheFile]  where to keep downloaded JSON (game.json…) between runs, so a start
   *   only downloads what changed on Drive. Entries are keyed by Drive file id + content MD5.
   */
  constructor(client, { rootName = 'VN Shelf', cacheFile = null } = {}) {
    super();
    this.client = client;
    this.rootName = rootName;
    this.kind = 'gdrive';
    this.rootId = null;
    this.folders = null; // gameId -> folderId
    this.children = new Map(); // gameId -> { at, files: Map(name -> file) }
    this.jsonCache = new Map(); // fileId:md5:modifiedTime -> parsed JSON
    this.snap = null; // { at, games: Set(gameId), files: Map(gameId -> Map(name -> key)) }
    this.cacheFile = cacheFile;
    if (cacheFile) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(require('fs').readFileSync(cacheFile, 'utf8')))) this.jsonCache.set(k, v);
      } catch { /* no cache yet */ }
    }
  }

  async saveCache(keep) {
    if (!this.cacheFile) return;
    const obj = {};
    for (const k of keep) if (this.jsonCache.has(k)) obj[k] = this.jsonCache.get(k);
    await fsu.writeJson(this.cacheFile, obj).catch(() => {});
  }

  /**
   * Every "VN Shelf" root folder, oldest first. Normally there is one, but two PCs (or two calls at
   * once) signing in for the first time can each create one, so all of them are read.
   * Concurrent callers share one lookup, so this process never creates a second root itself.
   */
  async roots() {
    if (this.rootIds) return this.rootIds;
    if (!this.rootsPromise) {
      this.rootsPromise = (async () => {
        const found = await this.client.list(`appProperties has { key='vnshelf' and value='root' } and trashed = false and mimeType = '${FOLDER}'`, 'id,name,modifiedTime');
        if (!found.length) found.push(await this.client.createFolder(this.rootName, undefined, { vnshelf: 'root' }));
        found.sort((a, b) => String(a.modifiedTime || '').localeCompare(String(b.modifiedTime || '')) || String(a.id).localeCompare(String(b.id)));
        this.rootIds = found.map((f) => f.id);
        this.rootId = this.rootIds[0];
        return this.rootIds;
      })().finally(() => { this.rootsPromise = null; });
    }
    return this.rootsPromise;
  }

  /** The root new game folders go into: the oldest, so every PC picks the same one. */
  async root() { return (await this.roots())[0]; }

  async available() {
    try { await this.root(); return true; } catch (e) {
      this.lastError = e.message;
      if (e.code === 'signed-out') throw e; // the UI asks to sign in again, not "offline"
      if (e instanceof DriveError && e.status !== 0 && e.status !== 401) throw e;
      return false;
    }
  }

  async gameFolders(fresh = false) {
    if (this.folders && !fresh) return this.folders;
    if (!fresh && this.foldersPromise) return this.foldersPromise; // several status checks at once share one listing
    this.foldersPromise = this.listGameFolders().finally(() => { this.foldersPromise = null; });
    return this.foldersPromise;
  }

  async listGameFolders() {
    const folders = new Map();
    for (const root of await this.roots()) {
      const list = await this.client.list(`${q(root)} in parents and trashed = false and mimeType = '${FOLDER}'`, 'id,name,appProperties');
      for (const f of list) {
        const id = f.appProperties && f.appProperties.vnsGame;
        if (id && !folders.has(id)) folders.set(id, f.id);
      }
    }
    this.folders = folders;
    return this.folders;
  }

  async folderId(gameId, { create = false } = {}) {
    let folders = await this.gameFolders();
    if (!folders.has(gameId)) folders = await this.gameFolders(true);
    if (folders.has(gameId)) return folders.get(gameId);
    if (!create) return null;
    const f = await this.client.createFolder(gameId, await this.root(), { vnsGame: gameId });
    folders.set(gameId, f.id);
    this.children.set(gameId, { at: Date.now(), files: new Map() });
    return f.id;
  }

  async childMap(gameId, fresh = false) {
    const c = this.children.get(gameId);
    if (c && !fresh && Date.now() - c.at < CHILD_TTL_MS) return c.files;
    const fid = await this.folderId(gameId);
    const files = new Map();
    if (fid) {
      for (const f of await this.client.list(`${q(fid)} in parents and trashed = false`)) {
        // If a name appears twice (two PCs created it at once), keep the newest.
        const prev = files.get(f.name);
        if (!prev || prev.modifiedTime < f.modifiedTime) files.set(f.name, f);
      }
    }
    this.children.set(gameId, { at: Date.now(), files });
    return files;
  }

  /**
   * One listing of game.json, state.json and lock.json for every game, downloading only files whose
   * content changed since they were last seen (on this run or a previous one: see cacheFile).
   * About 3 requests for the whole library when nothing changed. Concurrent callers share one.
   */
  snapshot() {
    if (!this.snapPromise) {
      this.snapPromise = this.takeSnapshot().finally(() => { this.snapPromise = null; });
    }
    return this.snapPromise;
  }

  /** A snapshot no older than maxAge ms (taking a new one if needed). */
  async freshSnapshot(maxAge) {
    if (this.snap && Date.now() - this.snap.at < maxAge) return this.snap;
    return this.snapshot();
  }

  async takeSnapshot() {
    const startedAt = Date.now();
    this.rootIds = null; // another PC may have created a duplicate root since we last looked
    const folders = await this.gameFolders(true);
    const byFolder = new Map([...folders].map(([g, f]) => [f, g]));
    const files = await this.client.list(`(${SNAPSHOT_NAMES.map((n) => `name = ${q(n)}`).join(' or ')}) and trashed = false`,
      'id,name,parents,md5Checksum,modifiedTime');
    const map = new Map([...folders.keys()].map((g) => [g, new Map()]));
    const newest = new Map(); // gameId/name -> modifiedTime of the copy kept
    for (const f of files) {
      const gameId = (f.parents || []).map((p) => byFolder.get(p)).find(Boolean);
      if (!gameId) continue;
      const k = `${gameId}/${f.name}`;
      if (newest.has(k) && newest.get(k) >= f.modifiedTime) continue; // two copies of one name: keep the newest
      newest.set(k, f.modifiedTime);
      map.get(gameId).set(f.name, { key: `${f.id}:${f.md5Checksum}:${f.modifiedTime}`, id: f.id });
    }
    const missing = [];
    for (const names of map.values()) for (const e of names.values()) if (!this.jsonCache.has(e.key)) missing.push(e);
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const e = missing[next++];
        try { this.jsonCache.set(e.key, JSON.parse((await this.client.download(e.id)).toString('utf8'))); } catch { /* skip unreadable */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
    // Writes made while this was running are newer than what it saw: keep those.
    if (this.snap && this.snap.writes) {
      for (const [gameId, names] of this.snap.writes) {
        if (!map.has(gameId)) map.set(gameId, new Map());
        for (const [name, e] of names) if (e.at >= startedAt) { if (e.key) map.get(gameId).set(name, e); else map.get(gameId).delete(name); }
      }
    }
    this.snap = { at: startedAt, games: new Set(map.keys()), files: map, writes: new Map() };
    const keep = [];
    for (const names of map.values()) for (const e of names.values()) keep.push(e.key);
    if (missing.length || this.cacheFile) await this.saveCache(keep);
    return this.snap;
  }

  /** Record our own write (or deletion: key null) of a snapshot file, so the snapshot stays current. */
  noteWrite(gameId, name, key, json) {
    if (!SNAPSHOT_NAMES.includes(name)) return;
    if (key && json !== undefined) this.jsonCache.set(key, json);
    const snap = this.snap;
    if (!snap) return;
    const e = { key, at: Date.now() };
    if (!snap.files.has(gameId)) { snap.files.set(gameId, new Map()); snap.games.add(gameId); }
    if (key) snap.files.get(gameId).set(name, e); else snap.files.get(gameId).delete(name);
    if (!snap.writes.has(gameId)) snap.writes.set(gameId, new Map());
    snap.writes.get(gameId).set(name, e);
  }

  /**
   * With maxAge: answer game.json / state.json / lock.json from a snapshot at most that old, with no
   * request of its own. Without: read the file from Drive now.
   */
  async readJson(gameId, name, { maxAge } = {}) {
    if (maxAge && SNAPSHOT_NAMES.includes(name)) {
      const snap = await this.freshSnapshot(maxAge);
      if (snap.games.has(gameId)) {
        const e = snap.files.get(gameId).get(name);
        if (!e) return null;
        if (this.jsonCache.has(e.key)) return this.jsonCache.get(e.key);
      }
    }
    return super.readJson(gameId, name);
  }

  /**
   * Files changed on Drive since `sinceIso` (by any PC), as gameId -> Set(names). One request.
   * Used to notice the other PC's changes without re-reading the library.
   */
  async changedSince(sinceIso) {
    const folders = await this.gameFolders();
    const byFolder = new Map([...folders].map(([g, f]) => [f, g]));
    const files = await this.client.list(`modifiedTime > ${q(sinceIso)}`, 'id,name,mimeType,parents,md5Checksum,modifiedTime,trashed');
    const out = { games: new Map(), unknownFolder: false, newest: sinceIso };
    for (const f of files) {
      if (f.modifiedTime > out.newest) out.newest = f.modifiedTime;
      const gameId = (f.parents || []).map((p) => byFolder.get(p)).find(Boolean);
      if (!gameId) {
        // A game folder we haven't seen (another PC added a game), or something in one.
        if (!(this.rootIds || []).includes(f.id)) out.unknownFolder = true;
        continue;
      }
      // Our own writes are already known (same id, content and time): not a change.
      const e = this.snap && this.snap.files.get(gameId) && this.snap.files.get(gameId).get(f.name);
      if (e && e.key === `${f.id}:${f.md5Checksum}:${f.modifiedTime}`) continue;
      if (!out.games.has(gameId)) out.games.set(gameId, new Set());
      out.games.get(gameId).add(f.name);
    }
    return out;
  }

  /** Forget cached listings so the next read sees other PCs' changes. */
  refresh(gameId) {
    if (gameId) this.children.delete(gameId); else this.children.clear();
    this.folders = null;
  }

  async listGames() { return [...(await this.gameFolders(true)).keys()]; }

  async createGame(gameId) { await this.folderId(gameId, { create: true }); }

  async removeGame(gameId) {
    const fid = await this.folderId(gameId);
    if (fid) await this.client.trash(fid);
    if (this.folders) this.folders.delete(gameId);
    this.children.delete(gameId);
    if (this.snap) { this.snap.files.delete(gameId); this.snap.games.delete(gameId); }
  }

  async getFile(gameId, name) {
    const f = (await this.childMap(gameId)).get(name);
    if (!f) return null;
    try { return await this.client.download(f.id); } catch (e) {
      if (e.status === 404) { this.children.delete(gameId); return null; }
      throw e;
    }
  }

  async putFile(gameId, name, buf, mime = 'application/octet-stream') {
    const files = await this.childMap(gameId);
    const existing = files.get(name);
    let f;
    if (existing) {
      try { f = await this.client.updateFile(existing.id, buf, mime); } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    if (!f) f = await this.client.createFile(name, await this.folderId(gameId, { create: true }), buf, mime);
    files.set(name, { ...f, name, modifiedTime: f.modifiedTime || new Date().toISOString() });
    if (SNAPSHOT_NAMES.includes(name)) {
      let json;
      try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
      this.noteWrite(gameId, name, f.md5Checksum && f.modifiedTime ? `${f.id}:${f.md5Checksum}:${f.modifiedTime}` : `local:${f.id}:${Date.now()}`, json);
    }
  }

  async deleteFile(gameId, name) {
    const files = await this.childMap(gameId);
    const f = files.get(name);
    if (!f) return;
    try { await this.client.remove(f.id); } catch (e) { if (e.status !== 404) throw e; }
    files.delete(name);
    this.noteWrite(gameId, name, null);
  }

  async list(gameId) {
    return [...(await this.childMap(gameId, true)).values()].map((f) => ({
      name: f.name, size: Number(f.size || 0), modified: Date.parse(f.modifiedTime || 0) || 0, md5: f.md5Checksum,
    }));
  }

  /**
   * Every game's copy of `name` (e.g. game.json), from a fresh snapshot (or one at most maxAge ms old).
   */
  async readAll(name, { maxAge } = {}) {
    if (!SNAPSHOT_NAMES.includes(name)) throw new Error(`readAll only covers ${SNAPSHOT_NAMES.join(', ')}`);
    const snap = maxAge ? await this.freshSnapshot(maxAge) : await this.snapshot();
    const out = new Map();
    for (const [gameId, names] of snap.files) {
      const e = names.get(name);
      if (e && this.jsonCache.has(e.key)) out.set(gameId, this.jsonCache.get(e.key));
    }
    return out;
  }

}

module.exports = { DirStore, DriveStore, BaseStore };
