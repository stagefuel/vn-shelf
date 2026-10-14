'use strict';
// Game records live in the shared folder (games/<id>/game.json) so every PC sees the
// same library. Where each game is installed is per-PC and lives in LocalConfig.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fsu = require('./fsutil');

function slug(s) {
  const ascii = String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase()
    .replace(/[\s_-]+/g, '-').slice(0, 32);
  return ascii || 'game';
}

function newRuleId() { return crypto.randomBytes(3).toString('hex'); }

class Library {
  constructor(cloudDir) { this.cloudDir = cloudDir; }

  dir(id) { return path.join(this.cloudDir, 'games', id); }

  async list() {
    const root = path.join(this.cloudDir, 'games');
    let names;
    try { names = await fsp.readdir(root); } catch { return []; }
    // Read in parallel (a shared folder can be slow), and only folders whose name is the game's id:
    // a sync app's copy of a folder ("abc (1)", "abc (conflicted copy)") would otherwise show twice.
    const found = await Promise.all(names.filter((id) => !id.startsWith('.')).map((id) => fsu.readJson(path.join(root, id, 'game.json')).then((g) => [id, g])));
    const games = found.filter(([id, g]) => g && !g.removed && g.id === id).map(([, g]) => g);
    return games.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }

  async get(id, opts = {}) { // eslint-disable-line no-unused-vars
    return fsu.readJson(path.join(this.dir(id), 'game.json'));
  }

  /** Add a play session to this PC's total. Each PC keeps its own entry, so they never overwrite each other. */
  async recordPlay(id, deviceId, { seconds, deviceName, at = new Date().toISOString() }) {
    const game = await this.get(id);
    if (!game) return null;
    const all = { ...(game.playtime || {}) };
    const mine = all[deviceId] || { seconds: 0 };
    all[deviceId] = { seconds: Math.max(0, Math.round((mine.seconds || 0) + seconds)), lastPlayed: at, deviceName };
    await fsu.writeJson(path.join(this.dir(id), 'game.json'), { ...game, playtime: all });
    return { ...game, playtime: all };
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
    await fsu.writeJson(path.join(this.dir(id), 'game.json'), game);
    return game;
  }

  async update(id, patch) {
    const game = await this.get(id);
    if (!game) throw new Error(`Unknown game ${id}`);
    const next = { ...game, ...patch, id };
    if (patch.launch) next.launch = { ...game.launch, ...patch.launch };
    await fsu.writeJson(path.join(this.dir(id), 'game.json'), next);
    return next;
  }

  async addSaveRule(id, rule) {
    const game = await this.get(id);
    const r = { id: newRuleId(), path: rule.path, include: rule.include || [], exclude: rule.exclude || [] };
    if ((game.saves || []).some((s) => s.path === r.path && JSON.stringify(s.include) === JSON.stringify(r.include))) {
      return game;
    }
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
    const name = `cover${ext}`;
    await fsu.copyFile(srcFile, path.join(this.dir(id), name));
    return this.update(id, { cover: name, coverVersion: Date.now() });
  }

  async setCoverBuffer(id, buf, ext = '.jpg') {
    const name = `cover${ext}`;
    await fsp.mkdir(this.dir(id), { recursive: true });
    await fsp.writeFile(path.join(this.dir(id), name), buf);
    return this.update(id, { cover: name, coverVersion: Date.now() });
  }

  coverPath(game) { return game.cover ? path.join(this.dir(game.id), game.cover) : null; }

  /**
   * Remove from the library. The folder (saves and history included) is moved to
   * games/.removed/ rather than deleted, so it can be recovered by hand.
   */
  async remove(id) {
    const dest = path.join(this.cloudDir, 'games', '.removed', `${id}-${fsu.timestamp()}`);
    await fsu.moveDir(this.dir(id), dest);
  }
}

/** Per-PC settings file. */
class LocalConfig {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  async load() {
    this.data = (await fsu.readJson(this.file)) || {};
    const d = this.data;
    if (!d.deviceId) d.deviceId = crypto.randomUUID();
    d.deviceName = d.deviceName || '';
    d.cloudDir = d.cloudDir || '';
    d.historyDepth = d.historyDepth || 10;
    d.liveMode = !!d.liveMode;
    d.localeEmulatorPath = d.localeEmulatorPath || '';
    d.games = d.games || {}; // id -> { installDir, lastSync, pending, lastPlayed, tools: [toolId] }
    d.tools = d.tools || []; // companion programs on this PC: { id, name, path, args, delaySec, closeWithGame, allGames }
    d.categories = d.categories || []; // categories created on this PC that no game uses yet
    d.language = d.language || 'auto'; // 'auto' | 'en' | 'ja'
    d.sort = d.sort || 'title';
    d.autoUpdate = d.autoUpdate !== false;
    d.background = d.background || null; // { file, dim, blur } — an image shown behind the app, per PC
    d.startWithSystem = !!d.startWithSystem; // start quietly in the tray when the user signs in
    d.closeToTray = d.closeToTray !== false; // the window's X hides VN Shelf to the tray instead of quitting
    d.trayHintShown = !!d.trayHintShown;
    d.allowUmineko = !!d.allowUmineko;
    await this.save();
    return d;
  }

  async save() { await fsu.writeJson(this.file, this.data); }

  game(id) {
    if (!this.data.games[id]) this.data.games[id] = {};
    return this.data.games[id];
  }

  async setGame(id, patch) {
    Object.assign(this.game(id), patch);
    await this.save();
  }

  async set(patch) {
    Object.assign(this.data, patch);
    await this.save();
  }
}

module.exports = { Library, LocalConfig, slug, newRuleId };
