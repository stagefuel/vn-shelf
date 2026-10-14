'use strict';
// The game library on top of a store (Google Drive). Same interface as Library (folder mode);
// covers are cached on this PC so the UI can show them as local files.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fsu = require('./fsutil');
const { slug, newRuleId } = require('./library');

const DEVICES = '__devices__';

class StoreLibrary {
  /**
   * @param {import('./stores').BaseStore} store
   * @param {string} cacheDir  where covers are cached on this PC
   */
  constructor(store, cacheDir) {
    this.store = store;
    this.cacheDir = cacheDir;
  }

  /** @param {object} [o]  maxAge: accept a listing up to this many ms old (no requests if it's that fresh) */
  async list({ maxAge } = {}) {
    const all = await this.store.readAll('game.json', { maxAge });
    const games = [...all.entries()].filter(([folder, g]) => g && g.id && !g.removed && g.id === folder).map(([, g]) => g);
    return games.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }

  /** @param {object} [o]  maxAge: as in list(); without it the game is read from Drive now */
  async get(id, { maxAge } = {}) {
    if (maxAge) return this.store.readJson(id, 'game.json', { maxAge });
    if (this.store.refresh) this.store.refresh(id);
    return this.store.readJson(id, 'game.json');
  }

  /** Add a play session to this PC's total. Each PC keeps its own entry, so they never overwrite each other. */
  async recordPlay(id, deviceId, { seconds, deviceName, at = new Date().toISOString() }) {
    const game = await this.get(id);
    if (!game) return null;
    const all = { ...(game.playtime || {}) };
    const mine = all[deviceId] || { seconds: 0 };
    all[deviceId] = { seconds: Math.max(0, Math.round((mine.seconds || 0) + seconds)), lastPlayed: at, deviceName };
    return this.save({ ...game, playtime: all });
  }

  async save(game) {
    await this.store.writeJson(game.id, 'game.json', game);
    return game;
  }

  async create(fields) {
    const id = `${slug(fields.title)}-${crypto.randomBytes(3).toString('hex')}`;
    const game = {
      id,
      title: fields.title || 'Untitled',
      titleAlt: fields.titleAlt || '',
      developer: fields.developer || '',
      vndbId: fields.vndbId || null,
      cover: null,
      exe: fields.exe || null,
      engine: fields.engine || null,
      saves: [],
      launch: { useLocaleEmulator: false, args: '' },
      titleSource: fields.titleSource || 'user', // 'folder' | 'window' | 'vndb' | 'user'
      status: '', // reading status (see STATUSES in main.js)
      addedAt: new Date().toISOString(),
    };
    await this.store.createGame(id);
    return this.save(game);
  }

  async update(id, patch) {
    const game = await this.get(id);
    if (!game) throw new Error(`Unknown game ${id}`);
    const next = { ...game, ...patch, id };
    if (patch.launch) next.launch = { ...game.launch, ...patch.launch };
    return this.save(next);
  }

  async addSaveRule(id, rule) {
    const game = await this.get(id);
    if (rule.kind === 'registry') {
      const key = require('./registry').normalizeKey(rule.key);
      if ((game.saves || []).some((s) => s.kind === 'registry' && s.key.toLowerCase() === key.toLowerCase())) return game;
      return this.update(id, { saves: [...(game.saves || []), { id: newRuleId(), kind: 'registry', key }] });
    }
    const r = { id: newRuleId(), path: rule.path, include: rule.include || [], exclude: rule.exclude || [] };
    if ((game.saves || []).some((s) => s.path === r.path && JSON.stringify(s.include) === JSON.stringify(r.include))) return game;
    return this.update(id, { saves: [...(game.saves || []), r] });
  }

  async updateSaveRule(id, ruleId, patch) {
    const game = await this.get(id);
    return this.update(id, { saves: game.saves.map((s) => (s.id === ruleId ? { ...s, ...patch, id: ruleId } : s)) });
  }

  async removeSaveRule(id, ruleId) {
    const game = await this.get(id);
    return this.update(id, { saves: game.saves.filter((s) => s.id !== ruleId) });
  }

  async setCover(id, srcFile) {
    const ext = (path.extname(srcFile) || '.jpg').toLowerCase();
    return this.setCoverBuffer(id, await fsp.readFile(srcFile), ext);
  }

  async setCoverBuffer(id, buf, ext = '.jpg') {
    const name = `cover${ext}`;
    await this.store.putFile(id, name, buf, ext === '.png' ? 'image/png' : 'image/jpeg');
    const game = await this.update(id, { cover: name, coverVersion: Date.now() });
    await this.writeCache(game, buf);
    return game;
  }

  cacheFile(game) {
    return game.cover ? path.join(this.cacheDir, `${game.id}-${game.coverVersion || 0}${path.extname(game.cover)}`) : null;
  }

  async writeCache(game, buf) {
    const p = this.cacheFile(game);
    if (!p) return;
    await fsp.mkdir(this.cacheDir, { recursive: true });
    await fsp.writeFile(p, buf);
  }

  /** Make sure the cover is cached on this PC; returns its path or null. */
  async ensureCover(game) {
    const p = this.cacheFile(game);
    if (!p) return null;
    if (await fsu.exists(p)) return p;
    try {
      const buf = await this.store.getFile(game.id, game.cover);
      if (!buf) return null;
      await this.writeCache(game, buf);
      return p;
    } catch { return null; }
  }

  coverPath(game) { return this.cacheFile(game); }

  // ---- each PC's shared look and preferences, for "Copy settings from another PC" (kept in a
  // container of their own, which has no game.json and so never shows up as a game)

  async putDeviceFile(name, buf) { await this.store.createGame(DEVICES); await this.store.putFile(DEVICES, name, buf); }

  async getDeviceFile(name) { if (this.store.refresh) this.store.refresh(DEVICES); return this.store.getFile(DEVICES, name); }

  async listDeviceFiles() { return (await this.store.list(DEVICES)).map((f) => f.name); }

  /** Remove from the library (the Drive folder goes to Drive's trash, so it can be recovered). */
  async remove(id) { await this.store.removeGame(id); }
}

module.exports = { StoreLibrary };
