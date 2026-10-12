'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const paths = require('../core/paths');
const fsu = require('../core/fsutil');
const { Library, LocalConfig } = require('../core/library');
const { SyncEngine } = require('../core/sync');
const detect = require('../core/detect');
const snapshot = require('../core/snapshot');
const providers = require('../core/providers');
const launcher = require('../core/launcher');
const vndb = require('../core/vndb');

let win = null;
let config = null;
let library = null;
let engine = null;
let roots = null;
const running = new Map(); // id -> { ev, watchers, liveTimer, mode }

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setState(id, state, extra = {}) {
  send('game-state', { id, state, ...extra });
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

function rebuild() {
  const d = config.data;
  library = d.cloudDir ? new Library(d.cloudDir) : null;
  engine = d.cloudDir ? new SyncEngine({
    cloudDir: d.cloudDir, deviceId: d.deviceId, deviceName: d.deviceName || os.hostname(),
    roots, historyDepth: d.historyDepth,
  }) : null;
}

function local(id) { return config.game(id); }

function installDir(id) { return local(id).installDir || null; }

function requireLibrary() {
  if (!library) throw new Error('Choose where to keep your saves first (Settings).');
}

async function getGame(id) {
  requireLibrary();
  const g = await library.get(id);
  if (!g) throw new Error('That game is no longer in the library.');
  return g;
}

function coverUrl(game) {
  const p = library && library.coverPath(game);
  return p ? `${pathToFileURL(p).href}?v=${game.coverVersion || 0}` : null;
}

async function decorate(game) {
  const l = local(game.id);
  const exeOk = !!(l.exePath && (await fsu.exists(l.exePath)));
  return {
    ...game,
    coverUrl: coverUrl(game),
    installed: exeOk,
    exePath: l.exePath || null,
    installDir: l.installDir || null,
    lastPlayed: l.lastPlayed || null,
    playMinutes: l.playMinutes || 0,
    pending: !!l.pending,
    running: running.has(game.id) ? running.get(game.id).mode : null,
  };
}

// ---------------------------------------------------------------- sync glue

/** Run a sync and translate outcomes the UI must act on into { needs } answers. */
async function runSync(game, opts = {}) {
  const dir = installDir(game.id);
  try {
    const r = await engine.sync(game, dir, local(game.id).lastSync || null, opts);
    await config.setGame(game.id, { lastSync: r.lastSync, pending: false });
    return { ok: true, action: r.action };
  } catch (e) {
    if (e.code === 'conflict') return { needs: 'conflict', info: e.info };
    if (e.code === 'cloud-unavailable') {
      await config.setGame(game.id, { pending: true });
      return { needs: 'offline', message: e.message };
    }
    if (e.code === 'cloud-incomplete') return { needs: 'incomplete', message: e.message };
    throw e;
  }
}

async function pushPending() {
  if (!engine || !(await engine.cloudAvailable())) return;
  for (const [id, l] of Object.entries(config.data.games)) {
    if (!l.pending || running.has(id)) continue;
    const game = await library.get(id).catch(() => null);
    if (!game) continue;
    const r = await runSync(game).catch((e) => ({ error: e.message }));
    if (r.needs === 'conflict') setState(id, 'conflict', { info: r.info });
    send('games-changed');
  }
}

function startLive(game) {
  const entry = running.get(game.id);
  if (!entry || !config.data.liveMode) return;
  const dir = installDir(game.id);
  for (const { abs } of engine.resolveRules(game, dir)) {
    if (!abs || !fs.existsSync(abs)) continue;
    try {
      const w = fs.watch(abs, { recursive: true }, () => {
        clearTimeout(entry.liveTimer);
        entry.liveTimer = setTimeout(async () => {
          const st = await engine.status(game, dir, local(game.id).lastSync).catch(() => null);
          if (st && st.action === 'push') {
            const r = await runSync(game).catch(() => null);
            if (r && r.ok) setState(game.id, 'running', { message: `Saved to the cloud at ${new Date().toLocaleTimeString()}` });
          }
        }, 10000);
      });
      entry.watchers.push(w);
    } catch { /* fs.watch unsupported here */ }
  }
}

function stopLive(id) {
  const entry = running.get(id);
  if (!entry) return;
  clearTimeout(entry.liveTimer);
  for (const w of entry.watchers) try { w.close(); } catch { /* ignore */ }
}

function startGame(game, mode, onExit) {
  const l = local(game.id);
  const ev = launcher.launch({
    exePath: l.exePath,
    installDir: l.installDir,
    args: (game.launch && game.launch.args) || '',
    useLocaleEmulator: !!(game.launch && game.launch.useLocaleEmulator),
    localeEmulatorPath: config.data.localeEmulatorPath,
  });
  const entry = { ev, watchers: [], liveTimer: null, mode, startedAt: Date.now() };
  running.set(game.id, entry);
  ev.on('exit', async (info) => {
    stopLive(game.id);
    running.delete(game.id);
    const minutes = Math.round((Date.now() - entry.startedAt) / 60000);
    await config.setGame(game.id, { lastPlayed: new Date().toISOString(), playMinutes: (local(game.id).playMinutes || 0) + minutes });
    try { await onExit(info); } catch (e) { setState(game.id, 'error', { message: e.message }); }
    send('games-changed');
  });
  return entry;
}

// ---------------------------------------------------------------- API

const api = {
  async getSetup() {
    return {
      configured: !!config.data.cloudDir,
      settings: {
        cloudDir: config.data.cloudDir,
        deviceName: config.data.deviceName || os.hostname(),
        historyDepth: config.data.historyDepth,
        liveMode: config.data.liveMode,
        localeEmulatorPath: config.data.localeEmulatorPath,
      },
      platform: process.platform,
      version: app.getVersion(),
    };
  },

  async detectProviders() { return providers.detect(); },

  async saveSettings(s) {
    const patch = {};
    if (s.cloudDir !== undefined) {
      await fs.promises.mkdir(s.cloudDir, { recursive: true });
      patch.cloudDir = s.cloudDir;
    }
    if (s.deviceName !== undefined) patch.deviceName = String(s.deviceName).trim() || os.hostname();
    if (s.historyDepth !== undefined) patch.historyDepth = Math.max(1, Math.min(100, Number(s.historyDepth) || 10));
    if (s.liveMode !== undefined) patch.liveMode = !!s.liveMode;
    if (s.localeEmulatorPath !== undefined) patch.localeEmulatorPath = s.localeEmulatorPath;
    await config.set(patch);
    rebuild();
    pushPending().catch(() => {});
    return api.getSetup();
  },

  async pickFolder(title, defaultPath) {
    const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },

  async pickFile(title, filters) {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  },

  async listGames() {
    if (!library) return [];
    return Promise.all((await library.list()).map(decorate));
  },

  async getGame(id) { return decorate(await getGame(id)); },

  async gameStatus(id) {
    const game = await getGame(id);
    if (running.has(id)) return { badge: 'running' };
    if (!(game.saves || []).length) return { badge: 'no-saves' };
    if (!local(id).exePath) return { badge: 'not-installed' };
    const st = await engine.status(game, installDir(id), local(id).lastSync || null);
    const lock = await engine.readLock(id);
    const cloud = st.cloud ? { deviceName: st.cloud.deviceName, pushedAt: st.cloud.pushedAt } : null;
    const badge = { nothing: 'synced', adopt: 'synced', push: 'upload', pull: 'download', conflict: 'conflict', offline: 'offline' }[st.action];
    return { badge, cloud, lock: lock && !lock.mine && !lock.stale ? lock : null };
  },

  async addGame(exePath) {
    requireLibrary();
    const dir = path.dirname(exePath);
    const title = path.basename(dir).replace(/[\[(【].*?[\])】]/g, ' ').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || path.basename(dir);
    const found = await detect.detectEngine(dir).catch(() => null);
    const game = await library.create({ title, exe: path.basename(exePath), engine: found ? found.engine.name : null });
    await config.setGame(game.id, { exePath, installDir: dir });
    send('games-changed');
    return decorate(game);
  },

  async updateGame(id, patch) {
    const allowed = {};
    for (const k of ['title', 'titleAlt', 'developer', 'launch']) if (patch[k] !== undefined) allowed[k] = patch[k];
    const g = await library.update(id, allowed);
    send('games-changed');
    return decorate(g);
  },

  async removeGame(id) {
    requireLibrary();
    if (running.has(id)) throw new Error('Close the game first.');
    await library.remove(id);
    delete config.data.games[id];
    await config.save();
    send('games-changed');
    return true;
  },

  async locateGame(id) {
    const game = await getGame(id);
    const exe = await api.pickFile(`Find ${game.exe || 'the game .exe'} for ${game.title} on this PC`,
      [{ name: 'Programs', extensions: ['exe', 'bat', 'lnk', 'sh', 'AppImage', '*'] }]);
    if (!exe) return null;
    await config.setGame(id, { exePath: exe, installDir: path.dirname(exe) });
    send('games-changed');
    return decorate(game);
  },

  async setGameFolder(id) {
    const l = local(id);
    const dir = await api.pickFolder('Choose the game\'s main folder', l.installDir || undefined);
    if (!dir) return null;
    if (l.exePath && paths.relativeInside(dir, l.exePath) === null) {
      throw new Error('The game folder must contain the game\'s .exe.');
    }
    await config.setGame(id, { installDir: dir });
    return api.getGame(id);
  },

  async searchVndb(q) { return vndb.search(q); },

  async applyVndb(id, v) {
    const g = await library.update(id, { title: v.title, titleAlt: v.titleAlt, developer: v.developer, vndbId: v.vndbId });
    if (v.image) {
      try {
        const { buf, ext } = await vndb.downloadImage(v.image);
        await library.setCoverBuffer(id, buf, ext);
      } catch (e) { /* keep metadata even if the cover fails */ }
    }
    send('games-changed');
    return decorate(await library.get(id) || g);
  },

  async setCustomCover(id) {
    const f = await api.pickFile('Choose a cover image', [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]);
    if (!f) return null;
    const g = await library.setCover(id, f);
    send('games-changed');
    return decorate(g);
  },

  // ---- save locations

  async describeSaves(id) {
    const game = await getGame(id);
    const dir = installDir(id);
    const out = [];
    for (const { rule, abs, error } of engine.resolveRules(game, dir)) {
      let exists = false;
      let fileCount = 0;
      if (abs && (await fsu.isDir(abs))) {
        exists = true;
        fileCount = (await fsu.walk(abs, { filter: fsu.makeMatcher(rule.include, rule.exclude), maxDepth: 8 })).length;
      }
      out.push({ ...rule, abs, error: error || null, exists, fileCount, portable: /^<[a-z]+>/.test(rule.path) });
    }
    return out;
  },

  async suggestSaves(id) {
    const game = await getGame(id);
    return detect.suggest(game, installDir(id), { roots });
  },

  async addSaveRule(id, { path: p, absPath, include }) {
    const game = await getGame(id);
    let rulePath = p;
    let portable = true;
    if (absPath) {
      const t = paths.tokenize(absPath, { roots, gameDir: installDir(id) });
      rulePath = t.path;
      portable = t.portable;
    }
    const inc = (include || []).map((s) => s.trim()).filter(Boolean);
    await library.addSaveRule(game.id, { path: rulePath, include: inc });
    return { portable, path: rulePath };
  },

  async addSaveFolder(id) {
    const dir = await api.pickFolder('Choose the folder this game saves into', installDir(id) || roots['<appdata>']);
    if (!dir) return null;
    return api.addSaveRule(id, { absPath: dir });
  },

  async updateSaveRule(id, ruleId, patch) {
    const clean = {};
    if (patch.include !== undefined) clean.include = patch.include.map((s) => s.trim()).filter(Boolean);
    if (patch.exclude !== undefined) clean.exclude = patch.exclude.map((s) => s.trim()).filter(Boolean);
    await library.updateSaveRule(id, ruleId, clean);
    return true;
  },

  async removeSaveRule(id, ruleId) {
    await library.removeSaveRule(id, ruleId);
    return true;
  },

  // ---- play

  async play(id, opts = {}) {
    const game = await getGame(id);
    if (running.has(id)) throw new Error('It\'s already running.');
    const l = local(id);
    if (!l.exePath || !(await fsu.exists(l.exePath))) return { needs: 'locate' };
    const hasSaves = (game.saves || []).length > 0;
    if (!hasSaves && !opts.noSaves) return { needs: 'no-saves' };

    if (hasSaves && !opts.offline) {
      if (!(await engine.cloudAvailable())) return { needs: 'offline', message: `Can't reach ${config.data.cloudDir}` };
      if (!opts.ignoreLock) {
        const lock = await engine.readLock(id);
        if (lock && !lock.mine && !lock.stale) return { needs: 'locked', lock };
      }
      setState(id, 'syncing', { message: 'Getting latest saves…' });
      const r = await runSync(game, { resolution: opts.resolution });
      if (!r.ok) { setState(id, 'idle'); return r; }
      await engine.takeLock(id).catch(() => {});
    }

    startGame(game, 'play', async (info) => {
      if (info.reason === 'failed') {
        await engine.releaseLock(id).catch(() => {});
        setState(id, 'error', { message: `Couldn't start the game: ${info.error}` });
        return;
      }
      if (!hasSaves) { setState(id, 'idle'); return; }
      setState(id, 'syncing', { message: 'Saving to the cloud…' });
      await new Promise((r) => setTimeout(r, 2000)); // let the game finish writing
      const fresh = await library.get(id);
      const r = await runSync(fresh).catch((e) => ({ error: e.message }));
      await engine.releaseLock(id).catch(() => {});
      if (r.ok) {
        setState(id, 'idle', { message: r.action === 'push' ? 'Saves uploaded' : 'No new saves' });
        if (r.action === 'push') notify(fresh.title, 'Saves uploaded.');
      } else if (r.needs === 'offline') {
        setState(id, 'idle', { message: 'Shared folder not reachable — will upload when it\'s back.' });
      } else if (r.needs === 'conflict') {
        setState(id, 'conflict', { info: r.info });
      } else {
        setState(id, 'error', { message: r.message || r.error });
      }
    });
    setState(id, 'running', { message: 'Playing' });
    startLive(game);
    return { started: true };
  },

  async syncNow(id, opts = {}) {
    const game = await getGame(id);
    if (running.has(id)) throw new Error('Close the game first.');
    setState(id, 'syncing', { message: 'Syncing…' });
    const r = await runSync(game, opts);
    setState(id, 'idle', r.ok ? { message: { push: 'Saves uploaded', pull: 'Saves downloaded' }[r.action] || 'Up to date' } : {});
    send('games-changed');
    return r;
  },

  async stopTracking(id) {
    const entry = running.get(id);
    if (entry) entry.ev.stop();
    return true;
  },

  // ---- save once

  async startSaveOnce(id) {
    const game = await getGame(id);
    const l = local(id);
    if (!l.exePath || !(await fsu.exists(l.exePath))) return { needs: 'locate' };
    if (running.has(id)) throw new Error('It\'s already running.');
    const since = Date.now() - 1000;
    startGame(game, 'saveonce', async () => {
      setState(id, 'scanning', { message: 'Looking for new save files…' });
      const changed = await snapshot.changedSince(roots, l.installDir, since, {
        extraSkip: [config.data.cloudDir, app.getPath('userData')],
      });
      const candidates = snapshot.rank(changed, { game, roots, gameDir: l.installDir });
      setState(id, 'idle');
      send('saveonce-result', { id, candidates: candidates.slice(0, 12) });
    });
    setState(id, 'running', { message: 'Make one save, then close the game' });
    return { started: true };
  },

  // ---- history

  async history(id) { requireLibrary(); return engine.listHistory(id); },

  async restore(id, name) {
    const game = await getGame(id);
    if (running.has(id)) throw new Error('Close the game first.');
    const last = await engine.restore(game, installDir(id), name);
    await config.setGame(id, { lastSync: last, pending: false });
    send('games-changed');
    return true;
  },

  // ---- misc

  async openPath(p) { if (p) await shell.openPath(p); return true; },
  async openExternal(url) { if (/^https:\/\//.test(url)) await shell.openExternal(url); return true; },
};

ipcMain.handle('api', async (_e, method, ...args) => {
  if (!Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`Unknown call ${method}`);
  return api[method](...args);
});

async function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 820, minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'VN Shelf',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => { api.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  roots = paths.defaultRoots({ documents: app.getPath('documents') });
  config = new LocalConfig(path.join(app.getPath('userData'), 'config.json'));
  await config.load();
  rebuild();
  await createWindow();
  pushPending().catch(() => {});
  setInterval(() => pushPending().catch(() => {}), 5 * 60 * 1000);
});

app.on('window-all-closed', () => {
  // Keep tracking a running game even if the window is closed? Simpler and safer: stay alive until it exits.
  if (running.size === 0) app.quit();
  else {
    const check = setInterval(() => { if (running.size === 0) { clearInterval(check); app.quit(); } }, 2000);
  }
});

module.exports = { api };
