'use strict';
// The game library on top of a store (Google Drive). Same interface as Library (folder mode);
// covers are cached on this PC so the UI can show them as local files.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fsu = require('./fsutil');
const { slug, newRuleId } = require('./library');

class StoreLibrary {
  /**
   * @param {import('./stores').BaseStore} store
   * @param {string} cacheDir  where covers are cached on this PC
   */
  constructor(store, cacheDir) {
    this.store = store;
    this.cacheDir = cacheDir;
  }

  async list() {
    const all = await this.store.readAll('game.json');
    const games = [...all.values()].filter((g) => g && g.id && !g.removed);
    return games.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }

  async get(id) {
    if (this.store.refresh) this.store.refresh(id);
    return this.store.readJson(id, 'game.json');
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

  /** Remove from the library (the Drive folder goes to Drive's trash, so it can be recovered). */
  async remove(id) { await this.store.removeGame(id); }
}

module.exports = { StoreLibrary };
