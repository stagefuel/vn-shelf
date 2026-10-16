'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, safeStorage, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
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
const luna = require('../core/luna');
const lnk = require('../core/lnk');
const vndb = require('../core/vndb');
const igdb = require('../core/igdb');
const limits = require('../core/limits');
const { ManifestSyncEngine } = require('../core/manifest-sync');
const { exclusive, busyGames, isRegistryRule } = require('../core/sync');
const registry = require('../core/registry');
const { cleanTitle } = require('../core/titles');
const vndbList = require('../core/vndb-list');

// Reading status. The values follow VNDB's list labels, so they can sync with a VNDB list later:
// playing = Playing (1), finished = Finished (2), stalled = Stalled (3), dropped = Dropped (4),
// wishlist = Wishlist (5); '' = none.
const STATUSES = ['', 'wishlist', 'playing', 'finished', 'stalled', 'dropped'];
const { HashCache } = require('../core/hashcache');
const { StoreLibrary } = require('../core/store-library');
const { DriveStore } = require('../core/stores');
const { DriveClient } = require('../core/gdrive');
const { GoogleAuth } = require('../core/google-oauth');
const importer = require('../core/importer');
const savesio = require('../core/savesio');
const tools = require('../core/tools');
const updater = require('../core/updater');
const archive = require('../core/archive');
const unpack = require('../core/unpack');

let win = null;
let config = null;
let library = null;
let engine = null;
let roots = null;
let googleAuth = null; // null when this build has no Google client ID
let updateInfo = null; // newest release found on GitHub, if any
let tray = null;
let lastSnapshotJson = null;
let lastFocusPoll = 0;
let hashCache = null; // file hashes remembered between checks and runs (see core/hashcache.js)
const STATUS_MAX_AGE = 20000; // badges and pages may use Drive data up to this old (no extra requests)
let quitting = false; // true once the user chose Quit (the window's X only hides it, by default)
const startHidden = process.argv.includes('--hidden'); // started with the computer: stay in the tray
const REPO_URL = 'https://github.com/stagefuel/vn-shelf';
const TOPBAR_HEIGHT = 52; // keep in step with .topbar in styles.css
const running = new Map(); // id -> { ev, watchers, liveTimer, mode }
let justUpdated = null; // the new version, on its first start after an update
const starting = new Set(); // ids whose Play is still checking saves

// Last line of defence: an error nothing else caught goes to error.log in the settings folder instead
// of crashing VN Shelf (and with it, a sync that's in progress).
function logError(kind, e) {
  try {
    const line = `${new Date().toISOString()} ${kind}: ${(e && e.stack) || e}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), line);
  } catch { /* nowhere to write */ }
}
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandled', e));

// Lets tests (and a future portable mode) keep settings somewhere other than %APPDATA%.
if (process.env.VNS_USER_DATA) app.setPath('userData', process.env.VNS_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setState(id, state, extra = {}) {
  send('game-state', { id, state, ...extra });
}

/** Sends sync progress for one game to the window, at most ~10 times a second (the last step always). */
function progressSender(id) {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (p.done > 0 && p.done < p.total && now - last < 100) return;
    last = now;
    send('sync-progress', { id, ...p });
  };
}

// ---------------------------------------------------------------- window, tray, start with the computer

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  if (running.size === 0) { app.quit(); return; }
  // A game is still open: its saves upload when it closes, then VN Shelf quits.
  if (win && !win.isDestroyed()) win.hide();
  const check = setInterval(() => { if (running.size === 0) { clearInterval(check); app.quit(); } }, 2000);
}

/** The few strings the main process shows itself (tray menu, tray notice), in the UI's language. */
function mainText(key) {
  const lang = config.data.language === 'auto' ? (app.getLocale().startsWith('ja') ? 'ja' : 'en') : config.data.language;
  const ja = {
    open: 'VN Shelf を開く', quit: '終了',
    archiveInstallBody: 'ダウンロード完了。ディスクイメージやインストーラーは、インストールしてから追加してください。', archiveReadyBody: 'ダウンロードしてライブラリに追加しました。',
    hiddenTitle: 'VN Shelf は実行中です', hiddenBody: 'トレイからセーブの同期を続けます。終了するにはトレイアイコンを右クリックしてください。',
  };
  const en = {
    open: 'Open VN Shelf', quit: 'Quit',
    archiveInstallBody: 'Downloaded. It\'s a disc image or installer: install it, then add the game.', archiveReadyBody: 'Downloaded and added to your library.',
    hiddenTitle: 'VN Shelf is still running', hiddenBody: 'It keeps your saves in sync from the tray. Right-click the tray icon to quit.',
  };
  return (lang === 'ja' ? ja : en)[key];
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: mainText('open'), click: () => showWindow() },
    { type: 'separator' },
    { label: mainText('quit'), click: () => quitApp() },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
  } catch { tray = null; return; } // no tray on this desktop
  tray.setToolTip('VN Shelf');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

/** The program to start when the user signs in: the portable .exe itself, not its unpacked copy. */
function startupCommand() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (process.env.APPIMAGE) return { exe: process.env.APPIMAGE, args: [] };
  return { exe: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
}

function linuxAutostartFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'vn-shelf.desktop');
}

/**
 * Register (or remove) VN Shelf as a program that starts with the computer, in the tray.
 * Called on every start too, so the entry follows the .exe when an update renames it.
 */
async function applyStartWithSystem(on) {
  const { exe, args } = startupCommand();
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (!on) { await fs.promises.rm(file, { force: true }).catch(() => {}); return; }
    const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, ['[Desktop Entry]', 'Type=Application', 'Name=VN Shelf',
      `Exec=${[exe, ...args, '--hidden'].map(quote).join(' ')}`, 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: [...args, '--hidden'] });
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// ---------------------------------------------------------------- Google sign-in

/** Client ID/secret are injected at build time (src/main/oauth-config.json), never committed. */
function loadOAuthConfig() {
  if (process.env.VNS_GOOGLE_CLIENT_ID && process.env.VNS_GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.VNS_GOOGLE_CLIENT_ID, clientSecret: process.env.VNS_GOOGLE_CLIENT_SECRET };
  }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth-config.json'), 'utf8'));
    if (c.clientId && c.clientSecret) return c;
  } catch { /* not bundled */ }
  return null;
}

/**
 * Tokens (Google, VNDB) live in userData on this PC only, encrypted with the OS's credential
 * protection when available. They are never put in shared storage or copied to another PC.
 */
function tokenStore(name = 'google-token.json') {
  const file = path.join(app.getPath('userData'), name);
  let cache;
  return {
    load() {
      if (cache !== undefined) return cache;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache = j.enc ? JSON.parse(safeStorage.decryptString(Buffer.from(j.enc, 'base64'))) : j.plain || null;
      } catch { cache = null; }
      return cache;
    },
    save(t) {
      cache = t;
      const body = safeStorage.isEncryptionAvailable()
        ? { enc: safeStorage.encryptString(JSON.stringify(t)).toString('base64') }
        : { plain: t };
      fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    },
    clear() { cache = null; fs.rmSync(file, { force: true }); },
  };
}

function backend() {
  const d = config.data;
  if (d.backend === 'gdrive') return googleAuth && googleAuth.signedIn() ? 'gdrive' : null;
  return d.cloudDir ? 'folder' : null;
}

function rebuild() {
  const d = config.data;
  if (!hashCache) hashCache = new HashCache(path.join(app.getPath('userData'), 'hash-cache.json'));
  const common = { deviceId: d.deviceId, deviceName: d.deviceName || os.hostname(), roots, historyDepth: d.historyDepth, hashCache,
    stateDir: path.join(app.getPath('userData'), 'work') };
  const b = backend();
  if (b === 'gdrive') {
    const client = new DriveClient({
      getAccessToken: () => googleAuth.getAccessToken(),
      refreshAccessToken: () => googleAuth.refreshAccessToken(),
      apiBase: process.env.VNS_DRIVE_API, uploadBase: process.env.VNS_DRIVE_UPLOAD, // test hooks
    });
    const store = new DriveStore(client, { cacheFile: path.join(app.getPath('userData'), 'drive-cache.json') });
    library = new StoreLibrary(store, path.join(app.getPath('userData'), 'covers'));
    engine = new ManifestSyncEngine({ ...common, store, label: 'Google Drive' });
  } else if (b === 'folder') {
    library = new Library(d.cloudDir);
    engine = new SyncEngine({ ...common, cloudDir: d.cloudDir });
  } else {
    library = null;
    engine = null;
  }
}

function local(id) { return config.game(id); }

function refuseBlocked(...names) {
  if (config.data.allowUmineko) return;
  if (names.flat().some((n) => /umineko|うみねこ/i.test(String(n || '')))) {
    throw new Error('Adding Umineko no Naku Koro ni is turned off in Settings.');
  }
}

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

/**
 * Another game on this PC that already syncs this folder (or one inside it, or around it), or this
 * registry key: two games syncing the same saves would overwrite each other's. Returns its title.
 */
async function sharedWith(id, { abs, key }) {
  const games = await library.list({ maxAge: STATUS_MAX_AGE }).catch(() => []);
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  for (const g of games) {
    if (g.id === id) continue;
    for (const r of g.saves || []) {
      if (key) {
        if (isRegistryRule(r) && r.key.toLowerCase() === key.toLowerCase()) return g.title;
        continue;
      }
      if (isRegistryRule(r) || !abs) continue;
      let other;
      try { other = paths.expand(r.path, { roots, gameDir: installDir(g.id) }); } catch { continue; }
      const x = norm(abs);
      const y = norm(other);
      if (inside(x, y) || inside(y, x)) return g.title;
    }
  }
  return null;
}

/** The game as last listed (at most STATUS_MAX_AGE old): for showing it, never for syncing it. */
async function peekGame(id) {
  requireLibrary();
  const g = await library.get(id, { maxAge: STATUS_MAX_AGE });
  if (!g) return getGame(id); // added since the last listing
  return g;
}

function coverUrl(game) {
  const p = library && library.coverPath(game);
  return p ? `${pathToFileURL(p).href}?v=${game.coverVersion || 0}` : null;
}

async function decorate(game, { offline = false } = {}) {
  const l = local(game.id);
  if (library && library.ensureCover && !offline) await library.ensureCover(game);
  const exeOk = !!(l.exePath && (await fsu.exists(l.exePath)));
  return {
    ...game,
    coverUrl: coverUrl(game),
    installed: exeOk,
    exePath: l.exePath || null,
    installDir: l.installDir || null,
    ...playInfo(game, l),
    pending: !!l.pending,
    running: running.has(game.id) ? running.get(game.id).mode : null,
    statuses: vndbList.statusesOf(game),
    descSegments: game.vndb && game.vndb.description ? vndb.parseDescription(game.vndb.description) : null,
  };
}

/**
 * Play time from every PC (each keeps its own total in the game's record) plus, until this PC's first
 * session with 0.6, the minutes it counted the old way. Last played = the latest on any PC.
 */
function playInfo(game, l) {
  const all = game.playtime || {};
  const mine = config.data.deviceId;
  let seconds = 0;
  let last = l.lastPlayed || null;
  const byDevice = [];
  for (const [dev, e] of Object.entries(all)) {
    seconds += e.seconds || 0;
    if (e.lastPlayed && (!last || e.lastPlayed > last)) last = e.lastPlayed;
    byDevice.push({ name: dev === mine ? (config.data.deviceName || os.hostname()) : e.deviceName || '?', seconds: e.seconds || 0, me: dev === mine });
  }
  if (!all[mine] && l.playMinutes) {
    seconds += l.playMinutes * 60;
    byDevice.push({ name: config.data.deviceName || os.hostname(), seconds: l.playMinutes * 60, me: true });
  }
  return { lastPlayed: last, playMinutes: Math.round(seconds / 60), playByDevice: byDevice.filter((x) => x.seconds > 0) };
}

// ---------------------------------------------------------------- background image

function backgroundInfo() {
  const b = config.data.background;
  if (!b || !b.file || !fs.existsSync(b.file)) return null;
  return { url: `${pathToFileURL(b.file).href}?v=${b.version || 0}`, dim: b.dim ?? 0.72, blur: b.blur ?? 0 };
}

// ---------------------------------------------------------------- sync glue

/** Run a sync and translate outcomes the UI must act on into { needs } answers. */
async function runSync(game, opts = {}) {
  const dir = installDir(game.id);
  // Never replace saves under a game that's open (started outside VN Shelf): it would write its old
  // saves back over them later. Only checked when saves are about to come down, so it's rarely paid.
  const beforePull = async () => running.has(game.id) || !(await launcher.isRunningFrom(dir).catch(() => false));
  try {
    const r = await engine.sync(game, dir, local(game.id).lastSync || null, { ...opts, beforePull, onProgress: progressSender(game.id) });
    await config.setGame(game.id, { lastSync: r.lastSync, pending: false });
    if (r.action === 'push' && r.lastSync) verifyLater(game.id, r.lastSync.generation);
    return { ok: true, action: r.action };
  } catch (e) {
    if (e.code === 'conflict') return { needs: 'conflict', info: e.info };
    if (e.code === 'cloud-unavailable') {
      await config.setGame(game.id, { pending: true });
      return { needs: 'offline', message: e.message };
    }
    if (e.code === 'cloud-incomplete') return { needs: 'incomplete', message: e.message };
    if (e.code === 'too-big' || e.code === 'bad-path') return { needs: 'too-big', message: e.message };
    if (e.code === 'signed-out') return { needs: 'signed-out', message: e.message };
    if (e.code === 'game-running') return { needs: 'game-running', message: e.message };
    throw e;
  }
}

/**
 * A little after an upload, check it's still the current one. If the other PC uploaded at the same
 * moment and replaced it, say so now (as a conflict to choose) instead of on the next sync.
 * Google Drive answers at once; a synced folder only shows the other PC's upload once the sync
 * app has delivered it, so it's checked twice.
 */
function verifyLater(id, generation) {
  for (const ms of backend() === 'gdrive' ? [5000] : [20000, 120000]) {
    setTimeout(async () => {
      if (!engine || running.has(id)) return;
      const l = local(id);
      if (!l.lastSync || l.lastSync.generation !== generation) return; // synced again since
      const cloud = await engine.readCloudState(id).catch(() => null);
      if (!cloud || cloud.generation === generation || (cloud.lineage || []).includes(generation)) return;
      const fresh = await library.get(id).catch(() => null);
      if (!fresh) return;
      const r = await runSync(fresh).catch(() => null);
      if (r && r.needs === 'conflict') setState(id, 'conflict', { info: r.info });
      send('games-changed');
    }, ms).unref?.();
  }
}

/** Run fn over items, at most `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Upload saves that changed on this PC since they last synced, for every game set up here: those
 * made while VN Shelf was closed or the game was started some other way, and uploads that had to
 * wait (offline). Upload only: it never downloads and never asks. Runs at start-up and every few minutes.
 */
let autoUploading = false;
async function autoUpload() {
  if (autoUploading || !engine || !library) return;
  autoUploading = true;
  try {
    if (!(await engine.cloudAvailable().catch(() => false))) return;
    const ids = Object.entries(config.data.games).filter(([id, l]) => l.exePath && !running.has(id) && !starting.has(id)).map(([id]) => id);
    const uploaded = [];
    await pool(ids, 2, async (id) => {
      const game = await library.get(id, { maxAge: 60000 }).catch(() => null);
      if (!game || !(game.saves || []).length) return;
      const l = local(id);
      if (!l.pending) {
        const st = await engine.status(game, installDir(id), l.lastSync || null, { maxAge: 60000 }).catch(() => null);
        if (!st || st.action !== 'push') return;
      }
      const fresh = await library.get(id).catch(() => null);
      if (!fresh) return;
      const r = await runSync(fresh, { only: 'push' }).catch(() => null);
      if (r && r.ok && r.action === 'push') uploaded.push(fresh.title);
    });
    if (uploaded.length) send('auto-uploaded', uploaded);
  } finally {
    autoUploading = false;
  }
}

// ---------------------------------------------------------------- noticing the other PC's changes

let lastPoll = null; // Drive: newest change time seen; folder: per-game fingerprints
let pollTimer = null;

/** Folder mode: a cheap fingerprint per game (sizes and times of its small files, nothing is read). */
async function folderFingerprints(cloudDir) {
  const root = path.join(cloudDir, 'games');
  let names = [];
  try { names = (await fs.promises.readdir(root)).filter((n) => !n.startsWith('.')); } catch { return new Map(); }
  const out = new Map();
  await Promise.all(names.map(async (id) => {
    const parts = await Promise.all(['game.json', 'state.json', 'lock.json'].map((f) => fs.promises.stat(path.join(root, id, f)).then((st) => `${st.size}:${st.mtimeMs}`, () => '-')));
    out.set(id, parts.join('|'));
  }));
  return out;
}

/** Look for changes made by another PC; tell the window which games changed. One request on Drive. */
async function pollChanges() {
  pollTimer = null;
  try {
    const b = backend();
    if (!library || !engine || !b) return;
    if (b === 'gdrive') {
      const store = engine.store;
      if (!lastPoll) { lastPoll = new Date(Date.now() - 2000).toISOString(); return; }
      const ch = await store.changedSince(lastPoll);
      lastPoll = ch.newest;
      if (!ch.unknownFolder && !ch.games.size) return;
      await store.snapshot(); // re-read only the changed records
      send('library-changed', { ids: [...ch.games.keys()].filter((g) => !g.startsWith('__')), added: ch.unknownFolder });
    } else {
      const now = await folderFingerprints(config.data.cloudDir);
      const prev = lastPoll instanceof Map ? lastPoll : null;
      lastPoll = now;
      if (!prev) return;
      const ids = [...now.keys()].filter((id) => prev.get(id) !== now.get(id));
      const added = ids.some((id) => !prev.has(id)) || [...prev.keys()].some((id) => !now.has(id));
      if (ids.length || added) send('library-changed', { ids, added });
    }
  } catch { /* offline: try again later */ } finally {
    schedulePoll();
  }
}

/** Every 20 s while the window is open, every 2 minutes while it's in the tray. */
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const visible = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  pollTimer = setTimeout(pollChanges, visible ? 20000 : 120000);
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

/** Tell the window (and the owner) how a sync after a game closed went. */
function reportSync(id, title, r) {
  if (r.ok) {
    setState(id, 'idle', { message: { push: 'Saves uploaded', pull: 'Saves downloaded' }[r.action] || 'No new saves' });
    if (r.action === 'push') notify(title, 'Saves uploaded.');
  } else if (r.needs === 'offline') {
    setState(id, 'idle', { message: 'Shared folder not reachable — will upload when it\'s back.' });
  } else if (r.needs === 'conflict') {
    setState(id, 'conflict', { info: r.info });
  } else {
    setState(id, 'error', { message: r.message || r.error });
  }
}

/**
 * The game's window gave its name. A game that isn't linked to VNDB and still has the title guessed
 * from its folder name takes it (cleaned up); a title you typed or one from VNDB is never replaced.
 */
async function takeWindowTitle(id, raw) {
  try {
    const game = await library.get(id);
    if (!game || game.vndbId || (game.titleSource && game.titleSource !== 'folder')) return;
    const title = cleanTitle(raw, { exe: game.exe });
    if (!title || title === game.title) return;
    await library.update(id, { title, titleSource: 'window' });
    send('title-taken', { id, title });
    send('games-changed');
  } catch { /* not important */ }
}

/**
 * Playing a game for the first time adds "Reading" (when it has no status, or only "Plan to read").
 * Like ticking a label on VNDB, it only adds: no other status is taken away.
 */
async function markReading(id) {
  try {
    const game = await library.get(id);
    const have = game ? vndbList.statusesOf(game) : null;
    if (have && have.every((s) => s === 'wishlist')) {
      const now = new Date().toISOString();
      const statuses = vndbList.cleanStatuses([...have, 'playing']);
      await library.update(id, { statuses, status: vndbList.primaryStatus(statuses), statusAt: now, listEditedAt: now, ...(game.started ? {} : { started: vndbList.today() }) });
      send('games-changed');
      vndbSyncSoon();
    }
  } catch { /* not important */ }
}

/**
 * Where did the game save? Everything created or changed since `since` in the usual save places,
 * grouped into ranked candidate folders, plus registry keys under HKCU\Software\<maker>\<game>
 * written since then that are named after the game. Nothing is set until the owner picks.
 */
async function detectSaves(game, l, since) {
  const changed = await snapshot.changedSince(roots, l.installDir, since, {
    extraSkip: [config.data.cloudDir, app.getPath('userData')],
  });
  const candidates = snapshot.rank(changed, { game, roots, gameDir: l.installDir })
    .filter((c) => !limits.rejectPath(c.path, c.include, { cloudDir: config.data.cloudDir, abs: c.abs }))
    .slice(0, 12);
  let reg = [];
  if (engine && engine.registry) {
    try {
      const terms = [game.title, game.titleAlt, game.developer, game.exe ? path.basename(game.exe, path.extname(game.exe)) : '', l.installDir ? path.basename(l.installDir) : '']
        .map(detect.normName).filter((t) => t.length >= 3);
      const keys = (await engine.registry.writtenSince(since)).filter((k) => {
        const [, maker, name] = k.split('\\');
        return [maker, name].some((part) => terms.some((t) => detect.namesMatch(detect.normName(part), t)));
      });
      const exports = await engine.registry.exportKeys(keys);
      reg = keys.filter((k) => exports.get(k) && registry.countValues(exports.get(k)) > 0)
        .map((k) => ({ key: k, display: registry.display(k), values: registry.countValues(exports.get(k)) }));
    } catch { /* registry not readable: files only */ }
  }
  return { candidates, registry: reg };
}

/**
 * Starting through Luna (game option "Start through LunaTranslator"): the way to start it, or null.
 * LunaTranslator starts a game it knows hooked from the start (--Exec). If it's already open, or it
 * doesn't know the game, or it's a standalone LunaHook, it's opened (if needed) and the game started
 * as usual; Luna attaches as it normally does.
 */
async function prepareLuna(game) {
  const exe = config.data.lunaPath;
  if (!(game.launch && game.launch.useLuna) || !exe || !(await fsu.exists(exe))) return null;
  const open = process.platform === 'win32' && (await launcher.isRunningFrom(path.dirname(exe)).catch(() => false));
  const plan = open ? { mode: 'alongside' } : await luna.plan(exe, local(game.id).exePath);
  if (plan.mode === 'alongside' && !open) {
    try { spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref(); } catch (e) { logError('luna', e); }
    await new Promise((r) => setTimeout(r, 1500)); // let it open before the game does
  }
  return plan;
}

/** A picked program, following shortcuts: { exePath, args, lunaPath } (lunaPath for Luna's own game shortcuts). */
async function resolveProgram(file) {
  if (!/\.lnk$/i.test(file)) return { exePath: file };
  const info = await lnk.read(file);
  if (!info || !info.target) throw new Error('Couldn\'t read where that shortcut points.');
  const m = /--Exec\s+"?([^"\s]+)"?/i.exec(info.args || '');
  if (luna.isTranslator(info.target) && m) {
    const gamePath = await luna.gameFor(info.target, m[1]);
    if (!gamePath) throw new Error('That LunaTranslator shortcut\'s game isn\'t in LunaTranslator\'s game list.');
    return { exePath: gamePath, lunaPath: info.target };
  }
  return { exePath: info.target, args: info.args || '' };
}

/** Store a resolved program for a game on this PC (and its shortcut's options in the game). */
async function useProgram(id, prog) {
  await config.setGame(id, { exePath: prog.exePath, installDir: path.dirname(prog.exePath) });
  if (prog.lunaPath && !config.data.lunaPath) await config.set({ lunaPath: prog.lunaPath });
  const g = await library.get(id);
  const launchPatch = { ...(g.launch || {}) };
  if (prog.lunaPath) launchPatch.useLuna = true;
  if (prog.args && !launchPatch.args) launchPatch.args = prog.args;
  if (prog.lunaPath || prog.args) await library.update(id, { launch: launchPatch });
}

/**
 * Add a session to this PC's play time in the game's shared record (so the other PC shows the total),
 * moving over the minutes counted the old way (on this PC only) the first time.
 */
async function recordPlay(id, seconds) {
  const l = local(id);
  const at = new Date().toISOString();
  const carry = l.playMinutes && !l.playMigrated ? l.playMinutes * 60 : 0;
  await config.setGame(id, { lastPlayed: at });
  try {
    const g = await library.recordPlay(id, config.data.deviceId, { seconds: seconds + carry, deviceName: config.data.deviceName || os.hostname(), at });
    if (g && carry) await config.setGame(id, { playMigrated: true });
  } catch {
    // Storage unreachable: keep it on this PC for now; it's carried over next time.
    await config.setGame(id, { playMinutes: (l.playMinutes || 0) + Math.round(seconds / 60), playMigrated: false });
  }
}

function startGame(game, mode, onExit, { lunaPlan = null } = {}) {
  const l = local(game.id);
  const ev = launcher.launch({
    exePath: l.exePath,
    installDir: l.installDir,
    args: (game.launch && game.launch.args) || '',
    useLocaleEmulator: !!(game.launch && game.launch.useLocaleEmulator),
    localeEmulatorPath: config.data.localeEmulatorPath,
    luna: lunaPlan && lunaPlan.mode === 'exec' ? lunaPlan : null,
    // The window title is only wanted for a game still named after its folder (see takeWindowTitle).
    wantTitle: !game.vndbId && !game.igdb && (!game.titleSource || game.titleSource === 'folder'),
  });
  const entry = { ev, watchers: [], liveTimer: null, mode, startedAt: Date.now(), tools: [] };
  running.set(game.id, entry);
  // Companion programs (text hooker, upscaler…) chosen for this game on this PC.
  const chosen = new Set(l.tools || []);
  const withGame = (config.data.tools || []).filter((t) => t.path && (t.allGames || chosen.has(t.id)));
  if (withGame.length) {
    entry.tools = tools.startTools(withGame, { gameExe: l.exePath, gameDir: l.installDir, title: game.title }, {
      onError: (t, e) => setState(game.id, 'running', { message: `Couldn't start ${t.name}: ${e.message}`, key: 'state.toolFailed', params: { name: t.name } }),
    });
  }
  ev.on('elevating', () => setState(game.id, 'running', { message: 'Waiting for permission to run as administrator…' }));
  ev.on('title', (t) => takeWindowTitle(game.id, t));
  ev.on('exit', async (info) => {
    stopLive(game.id);
    await tools.stopTools(entry.tools).catch(() => {});
    running.delete(game.id);
    if (info.reason !== 'failed' && info.reason !== 'declined') {
      await recordPlay(game.id, (info.playedMs || 0) / 1000);
      if (mode === 'play' && (info.playedMs || 0) >= 60000) await markReading(game.id);
    }
    try { await onExit(info); } catch (e) { setState(game.id, 'error', { message: e.message }); }
    send('games-changed');
  });
  return entry;
}

// ---------------------------------------------------------------- look: theme and fonts

const THEME_KEYS = ['bg', 'raised', 'line', 'text', 'dim', 'accent', 'play', 'warn', 'danger'];

/** Only known colour slots with #rrggbb values, so a bad file can't inject anything into the page. */
function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const colors = {};
  for (const k of THEME_KEYS) if (t.colors && /^#[0-9a-f]{6}$/i.test(t.colors[k] || '')) colors[k] = t.colors[k].toLowerCase();
  return { preset: String(t.preset || 'night').replace(/[^a-z0-9-]/gi, '').slice(0, 30), colors };
}

function fontsDir() { return path.join(app.getPath('userData'), 'fonts'); }

function fontsInfo() {
  const f = config.data.fonts || {};
  const custom = (f.custom || []).filter((c) => fs.existsSync(path.join(fontsDir(), c.file)))
    .map((c) => ({ family: c.family, file: c.file, url: pathToFileURL(path.join(fontsDir(), c.file)).href }));
  return { en: f.en || '', ja: f.ja || '', custom };
}

// ---------------------------------------------------------------- sharing this PC's look with the other PC

const SHARED_KEYS = ['language', 'sort', 'showStats', 'closeToTray', 'historyDepth', 'liveMode', 'autoUpdate', 'updateInstall', 'theme', 'categoryOrder', 'showListOnly', 'libraryView', 'sortBy', 'customOrder'];
let publishTimer = null;

function publishSettingsSoon() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => publishSettings().catch(() => {}), 3000);
}

/**
 * Put this PC's look and preferences (plus its background picture and added fonts) in the shared
 * storage, so another PC can copy them (Settings → General). Only what changed is uploaded.
 */
async function publishSettings() {
  if (!library || !library.putDeviceFile) return;
  const d = config.data;
  const id = d.deviceId;
  const files = {};
  const put = async (name, file) => {
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st) return null;
    const sig = `${st.size}:${st.mtimeMs}`;
    if ((d.publishedFiles || {})[name] !== sig) {
      await library.putDeviceFile(name, await fs.promises.readFile(file));
      await config.set({ publishedFiles: { ...(config.data.publishedFiles || {}), [name]: sig } });
    }
    return name;
  };
  const bg = d.background && d.background.file ? await put(`${id}-background${path.extname(d.background.file)}`, d.background.file) : null;
  if (bg) files.background = bg;
  files.fonts = [];
  for (const c of (d.fonts && d.fonts.custom) || []) {
    const name = await put(`${id}-font-${c.file}`, path.join(fontsDir(), c.file));
    if (name) files.fonts.push({ family: c.family, file: c.file, name });
  }
  const settings = Object.fromEntries(SHARED_KEYS.map((k) => [k, d[k]]));
  settings.fonts = { en: (d.fonts && d.fonts.en) || '', ja: (d.fonts && d.fonts.ja) || '' };
  settings.background = d.background ? { dim: d.background.dim, blur: d.background.blur } : null;
  const body = { settings, files };
  const sig = JSON.stringify(body);
  if (sig === d.publishedSettings) return;
  await library.putDeviceFile(`${id}.json`, Buffer.from(JSON.stringify({
    deviceId: id, deviceName: d.deviceName || os.hostname(), sharedAt: new Date().toISOString(), ...body,
  }, null, 2)));
  await config.set({ publishedSettings: sig });
}

// ---------------------------------------------------------------- VNDB list sync
// Reading status, categories with a matching label, your rating and dates sync both ways with the
// owner's VNDB list (core/vndb-list.js). The token stays on this PC, encrypted.

let vndbToken = null; // tokenStore('vndb-token.json'), set up when the app is ready
let vndbChain = Promise.resolve();
let vndbPending = null; // the run waiting to start, which later requests join
let vndbSoonTimer = null;
const VNDB_FULL_EVERY = 6 * 3600 * 1000; // re-read the whole list this often (finds removed entries)

function vndbCacheFile() { return path.join(app.getPath('userData'), 'vndb-list.json'); }
// The "Your VNDB list" page as last shown, so it appears at once next time.
function listOnlyFile() { return path.join(app.getPath('userData'), 'vndb-list-view.json'); }
let listOnlySaved = null;

function vndbClient(token) {
  return new vndbList.VndbListClient({ token, apiBase: process.env.VNS_VNDB_API || undefined, gapMs: process.env.VNS_VNDB_API ? 0 : 1000 });
}

function vndbInfo() {
  const v = config.data.vndb;
  if (!v || !vndbToken || !vndbToken.load()) return { connected: false };
  return {
    connected: true, username: v.username, userId: v.userId, canWrite: !!v.canWrite, labels: v.labels || [],
    lastSyncAt: v.lastSyncAt || null, lastError: v.lastError || null, syncing: !!vndbPending || vndbBusy,
  };
}

/** Run a sync after the ones already started; requests made while one is waiting share it. */
function vndbSync(opts = {}) {
  if (vndbPending) { if (opts.full) vndbPending.full = true; return vndbPending.promise; }
  const p = { full: !!opts.full };
  p.promise = vndbChain.catch(() => {}).then(() => { vndbPending = null; return vndbSyncOnce(p); });
  vndbPending = p;
  vndbChain = p.promise;
  return p.promise;
}

/** A change to a game's status, categories, rating or dates goes to VNDB 5 s later (changes in a row go together). */
function vndbSyncSoon() {
  if (!config.data.vndb) return;
  clearTimeout(vndbSoonTimer);
  vndbSoonTimer = setTimeout(() => vndbSync().catch(() => {}), 5000);
}

let vndbBusy = false;
async function vndbSyncOnce({ full }) {
  const v = config.data.vndb;
  const token = vndbToken && vndbToken.load();
  if (!v || !token || !library) return null;
  const cache = (await fsu.readJson(vndbCacheFile(), null)) || {};
  if (cache.user !== v.userId) Object.assign(cache, { user: v.userId, entries: {}, lastmod: 0, fullAt: null });
  if (!cache.fullAt || Date.now() - Date.parse(cache.fullAt) > VNDB_FULL_EVERY) full = true;
  vndbBusy = true;
  send('vndb-state', vndbInfo());
  try {
    const games = await library.list({ maxAge: 0 });
    const r = await vndbList.syncList({
      client: vndbClient(token), user: v.userId, canWrite: !!v.canWrite, games, cache, full,
      update: (id, patch) => library.update(id, patch).catch((e) => logError('vndb', e)),
      log: (e) => logError('vndb', e),
    });
    cache.customLabels = r.labels.map((l) => ({ id: l.id, label: l.label }));
    await fsu.writeJson(vndbCacheFile(), cache);
    if (config.data.vndb && config.data.vndb.userId === v.userId) {
      await config.set({ vndb: { ...config.data.vndb, lastSyncAt: new Date().toISOString(), lastError: r.errors.length ? `${r.errors[0].title}: ${r.errors[0].message}` : null, labels: r.labels.map((l) => l.label) } });
    }
    if (r.pulled) send('games-changed');
    return { pulled: r.pulled, pushed: r.pushed, errors: r.errors };
  } catch (e) {
    logError('vndb', e);
    if (config.data.vndb) await config.set({ vndb: { ...config.data.vndb, lastError: e.message } });
    throw e;
  } finally {
    vndbBusy = false;
    send('vndb-state', vndbInfo());
  }
}

// ---------------------------------------------------------------- VNDB extras cache
// Game-page extras from VNDB are kept on this PC for a week (never in shared storage). When VNDB
// can't be reached, the last copy is used however old it is.

const VNDB_EXTRAS_MAX_AGE = 7 * 24 * 3600 * 1000;

async function vndbCached(key, fetcher) {
  const file = path.join(app.getPath('userData'), 'vndb-extras', `${key.replace(/[^a-z0-9-]/gi, '_')}.json`);
  const cached = await fsu.readJson(file, null);
  if (cached && Date.now() - Date.parse(cached.at) < VNDB_EXTRAS_MAX_AGE) return cached.data;
  try {
    const data = await fetcher();
    fsu.writeJson(file, { at: new Date().toISOString(), data }).catch(() => {});
    return data;
  } catch (e) {
    if (cached) return cached.data;
    logError('vndb-extras', e);
    return null;
  }
}

/** The engines VNDB lists for a game's releases (cached on this PC), or null. */
function vndbEnginesFor(game) {
  if (!game || !game.vndbId) return null;
  return () => vndbCached(`engines-${game.vndbId}`, () => vndb.fetchEngines(game.vndbId));
}

/** A function telling, for a VN id, which library game has it and its statuses on the owner's VNDB list. */
async function vndbMarker() {
  const games = library ? await library.list({ maxAge: STATUS_MAX_AGE }).catch(() => []) : [];
  const byVid = new Map(games.filter((g) => g.vndbId).map((g) => [g.vndbId, g]));
  let entries = {};
  if (config.data.vndb) {
    const cache = (await fsu.readJson(vndbCacheFile(), null)) || {};
    if (cache.user === config.data.vndb.userId) entries = cache.entries || {};
  }
  return (vid) => {
    const g = byVid.get(vid);
    const e = entries[vid];
    return {
      gameId: g ? g.id : null,
      listStatuses: e ? vndbList.statusesOfLabels((e.labels || []).map((l) => l.id || l)) : g ? vndbList.statusesOf(g) : [],
      onList: !!e,
    };
  };
}

// ---------------------------------------------------------------- API

// ---- VN archive (a Filebrowser Quantum server with a VN index)
// Settings are per PC (config.data.archive); the API token is in archive-token.json, encrypted.

let archiveToken = null; // tokenStore('archive-token.json')
let archiveQueue = null;
let archiveIndexCache = null; // { at, index }
const ARCHIVE_INDEX_MAX_AGE = 10 * 60 * 1000;

function archiveFile(name) { return path.join(app.getPath('userData'), name); }

function archiveClient() {
  const a = config.data.archive;
  const tok = archiveToken && archiveToken.load();
  if (!a || !a.server || !tok) return null;
  return new archive.ArchiveClient({ server: a.server, token: tok.token });
}

function archiveDownloadDir() {
  const a = config.data.archive || {};
  return a.downloadDir || path.join(app.getPath('documents'), 'VN Shelf downloads');
}

function safeName(s) {
  return String(s || 'VN').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/[. ]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'VN';
}

async function archiveState() {
  const a = config.data.archive;
  const connected = !!archiveClient();
  return {
    connected,
    server: a && a.server, username: a && a.username,
    count: archiveIndexCache && archiveIndexCache.index ? (archiveIndexCache.index.items || []).length : (a && a.count) || 0,
    downloadDir: archiveDownloadDir(),
    sevenZip: await unpack.find7z(a && a.sevenZip).catch(() => null),
    keepArchives: !!(a && a.keepArchives),
    connectedAt: (a && a.connectedAt) || null,
  };
}

/**
 * The server refused the token (revoked, account gone, no access any more): this PC is signed out.
 * Everything about the archive disappears from the window until you sign in again.
 */
async function archiveSignedOut() {
  if (archiveQueue) for (const j of archiveQueue.jobs) if (j.abort) j.abort.abort();
  archiveToken.clear();
  archiveIndexCache = null;
  await fs.promises.rm(archiveFile('archive-index.json'), { force: true }).catch(() => {});
  await config.set({ archive: { ...(config.data.archive || {}), index: null, count: 0 } });
  archiveQueue = null;
  send('archive-state', { connected: false, count: 0 });
}

async function archiveIndex({ fresh = false } = {}) {
  const client = archiveClient();
  if (!client) return null;
  if (!archiveIndexCache) archiveIndexCache = await fsu.readJson(archiveFile('archive-index.json'), null);
  if (!fresh && archiveIndexCache && Date.now() - archiveIndexCache.at < ARCHIVE_INDEX_MAX_AGE) return archiveIndexCache.index;
  const a = config.data.archive;
  let where = a.index;
  let index;
  try {
    if (!where) throw Object.assign(new Error('find'), { code: 'find' });
    index = await client.fetchIndex(where);
  } catch (e) {
    if (e.code === 'denied') { await archiveSignedOut(); throw e; }
    try {
      where = await client.findIndex(); // moved, or not looked up yet
      index = await client.fetchIndex(where);
    } catch (e2) {
      if (e2.code === 'denied') await archiveSignedOut();
      throw e2;
    }
    await config.set({ archive: { ...config.data.archive, index: where } });
  }
  index.source = where.source;
  archiveIndexCache = { at: Date.now(), index };
  fsu.writeJson(archiveFile('archive-index.json'), archiveIndexCache).catch(() => {});
  if ((a.count || 0) !== (index.items || []).length) config.set({ archive: { ...config.data.archive, count: (index.items || []).length } }).catch(() => {});
  return index;
}

function jobChanged(j) {
  if (archiveQueue) archiveQueue.changed();
  return j;
}

/** After a download: extract it, then add the game to the library with its VNDB entry. */
async function installDownloaded(job) {
  const dir = job.dest;
  const p = unpack.plan(job.files.map((f) => f.rel));
  try {
    if (p.extract.length) {
      const sz = await unpack.find7z((config.data.archive || {}).sevenZip);
      if (!sz) { job.state = 'needs-7zip'; return jobChanged(job); }
      job.state = 'unpacking';
      jobChanged(job);
      for (const f of p.extract) {
        await unpack.extract(sz, path.join(dir, ...f.split('/')), dir, { onProgress: (pct) => { job.unpacked = pct; send('archive-downloads', archiveQueue.list()); } });
      }
      if (!(config.data.archive || {}).keepArchives) await unpack.removeArchives(dir, p.extract.map((f) => path.join(...f.split('/'))));
    }
    const found = await importer.scan(dir, { maxDepth: 4 });
    if (!found.length || (p.discs.length && !p.extract.length)) {
      job.state = 'needs-install';
      notify(job.title, mainText('archiveInstallBody'));
      return jobChanged(job);
    }
    found.sort((a, b) => b.score - a.score || a.dir.length - b.dir.length);
    const pick = found[0];
    const match = job.vids && job.vids[0] ? await vndb.bestMatch(job.vids[0]).catch(() => null) : null;
    const [r] = await api.importGames([{ exe: pick.exe, dir: pick.dir, title: job.title, match }]);
    if (!r || r.error) throw new Error((r && r.error) || 'Couldn\'t add the game.');
    await library.update(r.id, { archiveKey: job.key }); // so "In library" can be shown per version
    if (job.part) {
      // Parts released separately stay separate games, named with their part (VNDB has one title
      // for all of them). Set by hand-style, so a VNDB refresh leaves it.
      const g = await library.get(r.id);
      await library.update(r.id, {
        title: `${g.title} ${job.part}`, titleAlt: g.titleAlt ? `${g.titleAlt} ${job.part}` : '', titleSource: 'user',
      });
      send('games-changed');
    }
    job.state = 'installed';
    job.gameId = r.id;
    notify(job.title, mainText('archiveReadyBody'));
  } catch (e) {
    job.state = 'install-error';
    job.error = e.message;
  }
  return jobChanged(job);
}

async function setUpArchiveQueue() {
  const client = archiveClient();
  if (archiveQueue) { for (const j of archiveQueue.jobs) if (j.abort) j.abort.abort(); }
  archiveQueue = null;
  if (!client) return;
  archiveQueue = await new archive.DownloadQueue({
    client, file: archiveFile('archive-downloads.json'),
    onChange: (list) => send('archive-downloads', list),
    onDone: (job) => { installDownloaded(job).catch(() => {}); return Promise.resolve(); },
    onDenied: () => { archiveIndex({ fresh: true }).catch(() => {}); }, // signs out if the token is no good
  }).load();
}

const api = {
  async getSetup() {
    return {
      configured: !!backend(),
      backend: backend(),
      driveAvailable: !!googleAuth,
      googleSignedIn: !!(googleAuth && googleAuth.signedIn()),
      googleEmail: config.data.googleEmail || null,
      archive: { connected: !!archiveClient(), count: (config.data.archive || {}).count || 0, connectedAt: (config.data.archive || {}).connectedAt || null },
      settings: {
        cloudDir: config.data.cloudDir,
        deviceName: config.data.deviceName || os.hostname(),
        historyDepth: config.data.historyDepth,
        liveMode: config.data.liveMode,
        localeEmulatorPath: config.data.localeEmulatorPath,
        lunaPath: config.data.lunaPath || '',
        language: config.data.language,
        sort: config.data.sort,
        libraryView: config.data.libraryView || 'covers',
        sortBy: config.data.sortBy || {},
        customOrder: config.data.customOrder || [],
        autoUpdate: config.data.autoUpdate,
        updateInstall: config.data.updateInstall === 'auto' ? 'auto' : 'ask',
        justUpdated: justUpdated,
        tools: config.data.tools,
        categories: config.data.categories,
        categoryOrder: config.data.categoryOrder || [],
        background: backgroundInfo(),
        startWithSystem: config.data.startWithSystem,
        closeToTray: config.data.closeToTray,
        allowUmineko: config.data.allowUmineko,
        showStats: config.data.showStats,
        showListOnly: config.data.showListOnly !== false,
        theme: config.data.theme,
        fonts: fontsInfo(),
      },
      platform: process.platform,
      version: app.getVersion(),
      repoUrl: REPO_URL,
      portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
      update: updateInfo,
      vndb: vndbInfo(),
    };
  },

  async detectProviders() { return providers.detect(); },

  async googleSignIn() {
    if (!googleAuth) throw new Error('This build of VN Shelf has no Google sign-in configured.');
    await googleAuth.signIn();
    let email = null;
    try {
      const client = new DriveClient({
        getAccessToken: () => googleAuth.getAccessToken(), refreshAccessToken: () => googleAuth.refreshAccessToken(),
        apiBase: process.env.VNS_DRIVE_API, uploadBase: process.env.VNS_DRIVE_UPLOAD,
      });
      const about = await client.about();
      email = about && about.user ? about.user.emailAddress : null;
    } catch { /* not essential */ }
    await config.set({ googleEmail: email });
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    return { email };
  },

  async googleSignOut() {
    if (googleAuth) await googleAuth.signOut();
    await config.set({ googleEmail: null, backend: config.data.cloudDir ? 'folder' : null });
    rebuild();
    return api.getSetup();
  },

  async saveSettings(s) {
    const patch = {};
    if (s.cloudDir !== undefined) {
      await fs.promises.mkdir(s.cloudDir, { recursive: true });
      patch.cloudDir = s.cloudDir;
      patch.backend = 'folder';
    }
    if (s.backend === 'gdrive') {
      if (!googleAuth || !googleAuth.signedIn()) throw new Error('Sign in to Google first.');
      patch.backend = 'gdrive';
    }
    if (s.deviceName !== undefined) patch.deviceName = String(s.deviceName).trim() || os.hostname();
    if (s.historyDepth !== undefined) patch.historyDepth = Math.max(1, Math.min(100, Number(s.historyDepth) || 10));
    if (s.liveMode !== undefined) patch.liveMode = !!s.liveMode;
    if (s.localeEmulatorPath !== undefined) patch.localeEmulatorPath = s.localeEmulatorPath;
    if (s.lunaPath !== undefined) patch.lunaPath = String(s.lunaPath || '');
    if (s.language !== undefined) patch.language = ['auto', 'en', 'ja'].includes(s.language) ? s.language : 'auto';
    if (s.sort !== undefined) patch.sort = String(s.sort);
    if (s.sortBy !== undefined && s.sortBy && typeof s.sortBy === 'object') {
      patch.sortBy = Object.fromEntries(Object.entries(s.sortBy).slice(0, 500).map(([k, v]) => [String(k).slice(0, 200), String(v).slice(0, 30)]));
    }
    if (s.customOrder !== undefined) patch.customOrder = [...new Set((s.customOrder || []).map(String))].slice(0, 20000);
    if (s.libraryView !== undefined) patch.libraryView = ['covers', 'rows', 'list'].includes(s.libraryView) ? s.libraryView : 'covers';
    if (s.autoUpdate !== undefined) patch.autoUpdate = !!s.autoUpdate;
    if (s.updateInstall !== undefined) patch.updateInstall = s.updateInstall === 'auto' ? 'auto' : 'ask';
    if (s.startWithSystem !== undefined) patch.startWithSystem = !!s.startWithSystem;
    if (s.closeToTray !== undefined) patch.closeToTray = !!s.closeToTray;
    if (s.allowUmineko !== undefined) patch.allowUmineko = !!s.allowUmineko;
    if (s.showStats !== undefined) patch.showStats = !!s.showStats;
    if (s.showListOnly !== undefined) patch.showListOnly = !!s.showListOnly;
    if (s.theme !== undefined) patch.theme = cleanTheme(s.theme);
    if (s.fonts !== undefined) patch.fonts = { ...config.data.fonts, en: String(s.fonts.en || '').slice(0, 100), ja: String(s.fonts.ja || '').slice(0, 100) };
    if (s.categoryOrder !== undefined) patch.categoryOrder = [...new Set((s.categoryOrder || []).map((c) => String(c).trim()).filter(Boolean))].slice(0, 500);
    if (s.categories !== undefined) patch.categories = [...new Set(s.categories.map((c) => String(c).trim()).filter(Boolean))];
    if (s.tools !== undefined) {
      patch.tools = s.tools.filter((t) => t && t.path).map((t) => ({
        id: t.id || require('crypto').randomBytes(3).toString('hex'),
        name: String(t.name || path.basename(t.path)).trim(),
        path: t.path, args: String(t.args || ''), delaySec: Math.max(0, Math.min(120, Number(t.delaySec) || 0)),
        closeWithGame: t.closeWithGame !== false, allGames: !!t.allGames,
      }));
    }
    // Only a change of storage (or of what the sync engine is built with) restarts syncing and
    // re-shares everything; display and other preferences don't.
    const onlyLocal = !Object.keys(patch).some((k) => ['cloudDir', 'backend', 'deviceName', 'historyDepth', 'liveMode'].includes(k));
    await config.set(patch);
    publishSettingsSoon();
    if (patch.startWithSystem !== undefined) await applyStartWithSystem(patch.startWithSystem).catch(() => {});
    if (patch.language !== undefined && tray) tray.setContextMenu(trayMenu());
    if (onlyLocal) return api.getSetup();
    await config.set({ publishedFiles: {}, publishedSettings: null }); // new storage: share everything again
    rebuild();
    lastPoll = null;
    autoUpload().catch(() => {});
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

  /** With {cached:true}, returns the list saved by the last full listing (instant, may be stale). */
  async listGames({ cached = false, fresh = false } = {}) {
    if (!library) return [];
    const snap = path.join(app.getPath('userData'), 'library-snapshot.json');
    if (cached) {
      const s = await fsu.readJson(snap, null);
      return s && s.backend === backend() ? Promise.all(s.games.map((g) => decorate(g, { offline: true }))) : null;
    }
    const list = await library.list({ maxAge: fresh ? 0 : STATUS_MAX_AGE });
    const json = JSON.stringify(list);
    if (json !== lastSnapshotJson) { lastSnapshotJson = json; fsu.writeJson(snap, { backend: backend(), games: list }).catch(() => {}); }
    return Promise.all(list.map(decorate));
  },

  async getGame(id) { return decorate(await peekGame(id)); },

  /** The badge for one game. Uses the latest library-wide listing, so it costs no Drive requests of its own. */
  async gameStatus(id) {
    const game = await peekGame(id);
    if (running.has(id)) return { badge: 'running' };
    if (!(game.saves || []).length) return { badge: 'no-saves' };
    if (!local(id).exePath) return { badge: 'not-installed' };
    const st = await engine.status(game, installDir(id), local(id).lastSync || null, { maxAge: STATUS_MAX_AGE });
    const lock = await engine.readLock(id, { maxAge: STATUS_MAX_AGE });
    const cloud = st.cloud ? { deviceName: st.cloud.deviceName, pushedAt: st.cloud.pushedAt } : null;
    const badge = { nothing: 'synced', adopt: 'synced', push: 'upload', pull: 'download', conflict: 'conflict', offline: 'offline' }[st.action];
    return { badge, cloud, lock: lock && !lock.mine && !lock.stale ? lock : null };
  },

  /**
   * Add a game from its program (or a shortcut to it). If the other PC already added it (same .exe
   * name or title, not set up here yet), returns { existing } so it can be set up instead of added twice.
   */
  async addGame(file, { asNew = false } = {}) {
    requireLibrary();
    const prog = await resolveProgram(file);
    const exePath = prog.exePath;
    const dir = path.dirname(exePath);
    if (!asNew) {
      const exeName = path.basename(exePath).toLowerCase();
      const folderTitle = detect.normName(path.basename(dir));
      const games = await library.list({ maxAge: STATUS_MAX_AGE });
      const other = games.find((g) => !local(g.id).exePath && ((g.exe && g.exe.toLowerCase() === exeName && !detect.SHARED_EXE.test(exeName))
        || (folderTitle.length >= 3 && [g.title, g.titleAlt].some((x) => detect.normName(x) === folderTitle))));
      if (other) return { existing: { id: other.id, title: other.title }, file };
    }
    const title = path.basename(dir).replace(/[\[(【].*?[\])】]/g, ' ').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || path.basename(dir);
    refuseBlocked(title, path.basename(dir));
    const found = await detect.detectEngine(dir).catch(() => null);
    const game = await library.create({ title, exe: path.basename(exePath), engine: found ? found.engine.name : null, titleSource: 'folder' });
    await useProgram(game.id, prog);
    send('games-changed');
    return decorate(await library.get(game.id) || game);
  },

  /** Set up a game the other PC added, with its program on this PC. */
  async setUpHere(id, file) {
    const prog = await resolveProgram(file);
    await useProgram(id, prog);
    send('games-changed');
    return decorate(await library.get(id));
  },

  async updateGame(id, patch) {
    const allowed = {};
    for (const k of ['title', 'titleAlt', 'developer', 'launch', 'notes', 'categories']) if (patch[k] !== undefined) allowed[k] = patch[k];
    if (allowed.title !== undefined) allowed.titleSource = 'user';
    // Reading statuses work like VNDB's labels: a game can have several. `status` (one) is still accepted.
    const wanted = patch.statuses !== undefined ? patch.statuses : patch.status !== undefined ? (patch.status ? [patch.status] : []) : undefined;
    const before = wanted !== undefined ? await peekGame(id) : null;
    if (wanted !== undefined) {
      if (!Array.isArray(wanted) || wanted.some((x) => !STATUSES.includes(x) || !x)) throw new Error('Unknown reading status.');
      const had = vndbList.statusesOf(before);
      allowed.statuses = vndbList.cleanStatuses(wanted);
      allowed.status = vndbList.primaryStatus(allowed.statuses);
      allowed.statusAt = new Date().toISOString();
      // Dates fill themselves in the first time: started when reading begins, finished when finished.
      const added = (x) => allowed.statuses.includes(x) && !had.includes(x);
      if (added('playing') && !before.started && patch.started === undefined) allowed.started = vndbList.today();
      if (added('finished') && !before.finished && patch.finished === undefined) allowed.finished = vndbList.today();
    }
    if (patch.vote !== undefined) allowed.vote = patch.vote === null ? null : vndbList.cleanVote(patch.vote);
    if (patch.started !== undefined) allowed.started = vndbList.cleanDate(patch.started);
    if (patch.finished !== undefined) allowed.finished = vndbList.cleanDate(patch.finished);
    if (allowed.notes !== undefined) allowed.notes = String(allowed.notes).slice(0, 100000);
    if (allowed.categories !== undefined) allowed.categories = [...new Set((allowed.categories || []).map((c) => String(c).trim()).filter(Boolean))];
    const listChange = ['statuses', 'categories', 'vote', 'started', 'finished'].some((k) => allowed[k] !== undefined);
    if (listChange) allowed.listEditedAt = new Date().toISOString();
    const g = await library.update(id, allowed);
    send('games-changed');
    if (listChange && g.vndbId) vndbSyncSoon(); // games not on VNDB never sync
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
    await useProgram(id, await resolveProgram(exe));
    send('games-changed');
    return decorate(await library.get(id) || game);
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

  /** IGDB, for games VNDB doesn't have. Only from Find… (setting a game's identity by hand). */
  async searchIgdb(q) { return igdb.search(q); },

  async applyIgdb(id, v) {
    refuseBlocked(v.title, v.titleAlt);
    const info = { id: Number(v.igdbId), url: String(v.url || ''), summary: String(v.summary || '').slice(0, 20000), released: String(v.released || ''),
      platforms: (v.platforms || []).map(String).slice(0, 20), fetchedAt: new Date().toISOString() };
    // An IGDB game isn't a VNDB entry: drop any VNDB link (and so its list sync) for this game.
    const g = await library.update(id, { title: v.title, titleAlt: v.titleAlt || '', developer: v.developer || '', vndbId: null, vndb: null, igdb: info, titleSource: 'igdb' });
    if (v.image && String(v.image).startsWith(igdb.COVER_HOST)) {
      try {
        const { buf, ext } = await vndb.downloadImage(v.image);
        await library.setCoverBuffer(id, buf, ext);
      } catch { /* keep the details even if the cover fails */ }
    }
    send('games-changed');
    return decorate(await library.get(id) || g);
  },

  async applyVndb(id, v) {
    refuseBlocked(v.title, v.titleAlt);
    let full = v.info ? v : null;
    if (!full) full = await vndb.fetchInfo(v.vndbId).catch(() => null);
    const info = full ? full.info : null;
    refuseBlocked(info && info.aliases);
    const g = await library.update(id, { title: v.title, titleAlt: v.titleAlt, developer: v.developer, vndbId: v.vndbId, igdb: null, titleSource: 'vndb', ...(info ? { vndb: info } : {}) });
    if (v.image) {
      try {
        const { buf, ext } = await vndb.downloadImage(v.image);
        await library.setCoverBuffer(id, buf, ext);
      } catch (e) { /* keep metadata even if the cover fails */ }
    }
    send('games-changed');
    return decorate(await library.get(id) || g);
  },

  /** Covers on VNDB to choose from (cached on this PC for a week). */
  async vndbCovers(id) {
    const game = await peekGame(id);
    if (!game.vndbId) return [];
    return (await vndbCached(`covers-${game.vndbId}`, () => vndb.fetchCovers(game.vndbId))) || [];
  },

  async setCoverFromUrl(id, url) {
    if (!/^https:\/\/t\.vndb\.org\//.test(String(url))) throw new Error('Not a VNDB image.');
    const { buf, ext } = await vndb.downloadImage(url);
    const g = await library.setCoverBuffer(id, buf, ext);
    send('games-changed');
    return decorate(g);
  },

  /** Pick an image file to crop into a cover: its contents as a data: URL, or null. */
  async pickCoverImage() {
    const f = await api.pickFile('Choose a cover image', [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]);
    if (!f) return null;
    const buf = await fs.promises.readFile(f);
    if (buf.length > 40 * 1024 * 1024) throw new Error('That image is too big (over 40 MB).');
    const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext || 'jpeg'};base64,${buf.toString('base64')}`;
  },

  /** Save a cropped cover made in the window (a JPEG data: URL). */
  async setCoverData(id, dataUrl) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) throw new Error('Not a cover image.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 15 * 1024 * 1024) throw new Error('That cover is too big.');
    const g = await library.setCoverBuffer(id, buf, '.jpg');
    send('games-changed');
    return decorate(g);
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
    const game = await peekGame(id);
    const dir = installDir(id);
    const out = [];
    const regRules = (game.saves || []).filter(isRegistryRule);
    const regData = regRules.length && engine.registry ? await engine.registry.exportKeys(regRules.map((r) => r.key)).catch(() => new Map()) : new Map();
    for (const { rule, abs, error, registry: isReg } of engine.resolveRules(game, dir)) {
      if (isReg) {
        const data = regData.get(rule.key) || null;
        const n = registry.countValues(data);
        out.push({ ...rule, path: registry.display(rule.key), abs: null, registry: true, exists: !!data, fileCount: n,
          size: null, skipped: 0, portable: true,
          error: engine.registry ? null : 'Registry saves only sync on Windows.' });
        continue;
      }
      let exists = false;
      let fileCount = 0;
      let size = null;
      let skipped = 0;
      if (abs && (await fsu.isDir(abs))) {
        exists = true;
        const m = await engine.listRuleFiles(abs, rule);
        fileCount = m.count;
        size = limits.describeSize({ files: m.count, bytes: m.bytes });
        skipped = m.skipped.type + m.skipped.size;
      }
      const problem = limits.rejectPath(rule.path, rule.include, { cloudDir: config.data.cloudDir, abs });
      out.push({ ...rule, abs, error: error || problem || null, exists, fileCount, size, skipped, portable: /^<[a-z]+>/.test(rule.path) });
    }
    return out;
  },

  async suggestSaves(id) {
    const game = await getGame(id);
    const r = await detect.suggest(game, installDir(id), { roots, vndbEngines: vndbEnginesFor(game) });
    r.candidates = r.candidates.filter((c) => !limits.rejectPath(c.path, c.include, { cloudDir: config.data.cloudDir, abs: c.abs }));
    return r;
  },

  /**
   * Add a save location after the safety checks. Returns { refused } for locations that can't be
   * save folders, { needsConfirm, size } when it's unusually big (call again with confirmLarge),
   * or { portable, path } once added.
   */
  async addSaveRule(id, { path: p, absPath, include, confirmLarge, confirmShared, registryKey }) {
    const game = await getGame(id);
    if (registryKey) {
      let key;
      try { key = registry.normalizeKey(registryKey); } catch (e) { return { refused: e.message, path: String(registryKey) }; }
      if (!confirmShared) {
        const other = await sharedWith(id, { key });
        if (other) return { needsConfirm: true, shared: other, path: registry.display(key) };
      }
      await library.addSaveRule(game.id, { kind: 'registry', key });
      return { portable: true, path: registry.display(key) };
    }
    let rulePath = p;
    let portable = true;
    if (absPath) {
      const t = paths.tokenize(absPath, { roots, gameDir: installDir(id) });
      rulePath = t.path;
      portable = t.portable;
    }
    const inc = (include || []).map((s) => s.trim()).filter(Boolean);
    let abs = null;
    try { abs = paths.expand(rulePath, { roots, gameDir: installDir(id) }); } catch { /* checked at sync */ }
    const why = limits.rejectPath(rulePath, inc, { cloudDir: config.data.cloudDir, abs });
    if (why) return { refused: why, path: rulePath };
    if (abs && (await fsu.isDir(abs))) {
      const m = await engine.listRuleFiles(abs, { include: inc, exclude: [] });
      const measured = { files: m.count, bytes: m.bytes };
      const verdict = limits.judge(measured, { confirmed: !!confirmLarge });
      if (verdict === 'refuse') {
        return { refused: `That folder holds ${limits.describeSize(measured)} or more, far more than saves normally take. Pick the folder that holds just the saves, or limit it to the save files.`, path: rulePath };
      }
      if (verdict === 'confirm') return { needsConfirm: true, size: limits.describeSize(measured), path: rulePath };
    }
    if (!confirmShared) {
      const other = await sharedWith(id, { abs });
      if (other) return { needsConfirm: true, shared: other, path: rulePath };
    }
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
    if (running.has(id)) throw new Error('It\'s already running.');
    if (starting.has(id)) return { busy: true }; // a second click while saves are still being checked
    starting.add(id);
    // Show it straight away: right after start-up the first Drive calls can take a few seconds.
    setState(id, 'syncing', { message: 'Checking for newer saves…' });
    let r;
    try {
      r = await api.startPlay(id, opts);
      return r;
    } finally {
      starting.delete(id);
      if (!(r && r.started) && !running.has(id)) setState(id, 'idle');
    }
  },

  /** play() without the "checking" indicator around it. */
  async startPlay(id, opts = {}) {
    const game = await getGame(id);
    const l = local(id);
    if (!l.exePath || !(await fsu.exists(l.exePath))) return { needs: 'locate' };
    const hasSaves = (game.saves || []).length > 0;
    // No save folder yet: play anyway and work out where it saves from what changed (asked after).
    const detecting = !hasSaves && !opts.noSaves;
    const since = Date.now() - 1000;

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

    const lunaPlan = await prepareLuna(game);
    startGame(game, 'play', async (info) => {
      if (info.reason === 'failed' || info.reason === 'declined') {
        await engine.releaseLock(id).catch(() => {});
        setState(id, 'error', info.reason === 'declined'
          ? { message: 'This game needs administrator rights, and permission wasn\'t given, so it didn\'t start. Nothing was changed.' }
          : { message: `Couldn't start the game: ${info.error}` });
        return;
      }
      if (!hasSaves) {
        if (!detecting) { setState(id, 'idle'); return; }
        setState(id, 'scanning', { message: 'Looking for where it saves…' });
        const found = await detectSaves(game, l, since).catch(() => ({ candidates: [], registry: [] }));
        setState(id, 'idle');
        send('saveonce-result', { id, ...found, afterPlay: true });
        return;
      }
      setState(id, 'syncing', { message: 'Saving to the cloud…' });
      await new Promise((r) => setTimeout(r, 2000)); // let the game finish writing
      const fresh = await library.get(id);
      const r = await runSync(fresh).catch((e) => ({ error: e.message }));
      await engine.releaseLock(id).catch(() => {});
      reportSync(id, fresh.title, r);
    }, { lunaPlan });
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

  /**
   * The game is open (started outside VN Shelf): wait for it to close, then sync. Saves can't safely
   * come down while it runs, since it could write its older saves back over them.
   */
  async waitAndSync(id, opts = {}) {
    const game = await getGame(id);
    if (running.has(id)) throw new Error('It\'s already running.');
    const ev = launcher.launch({ exePath: null, installDir: installDir(id), graceMs: 4000 });
    running.set(id, { ev, watchers: [], liveTimer: null, mode: 'watch', startedAt: Date.now(), tools: [] });
    setState(id, 'running', { message: 'Waiting for the game to close…' });
    ev.on('exit', async (info) => {
      running.delete(id);
      if (info.reason === 'stopped') { setState(id, 'idle'); return; }
      await recordPlay(id, (info.playedMs || 0) / 1000);
      setState(id, 'syncing', { message: 'Syncing…' });
      await new Promise((r) => setTimeout(r, 2000)); // let the game finish writing
      const fresh = await library.get(id).catch(() => game);
      const r = await runSync(fresh, opts).catch((e) => ({ error: e.message }));
      reportSync(id, fresh.title, r);
      send('games-changed');
    });
    return { waiting: true };
  },

  async stopTracking(id) {
    const entry = running.get(id);
    if (entry) entry.ev.stop();
    return true;
  },

  /**
   * Stop: ask the game to close like its X button (it may ask "Quit?"). Resolves { closed } once it
   * has, or { stillOpen } after 6 s (then forceClose or keep it). Waiting for a game started
   * elsewhere just stops waiting.
   */
  async closeGame(id) {
    const entry = running.get(id);
    if (!entry) return { closed: true };
    if (entry.mode === 'watch') { entry.ev.stop(); return { closed: true }; }
    const asked = await entry.ev.close().catch(() => false);
    if (!asked) { entry.ev.stop(); return { closed: true, untracked: true } ; }
    const until = Date.now() + 6000;
    while (Date.now() < until && running.get(id) === entry) await new Promise((r) => setTimeout(r, 250));
    return running.get(id) === entry ? { stillOpen: true } : { closed: true };
  },

  async forceCloseGame(id) {
    const entry = running.get(id);
    if (entry) await entry.ev.kill().catch(() => {});
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
      const found = await detectSaves(game, l, since).catch(() => ({ candidates: [], registry: [] }));
      setState(id, 'idle');
      send('saveonce-result', { id, ...found });
    });
    setState(id, 'running', { message: 'Make one save, then close the game' });
    return { started: true };
  },

  // ---- history

  async history(id) { requireLibrary(); return engine.listHistory(id); },

  async restore(id, name) {
    const game = await getGame(id);
    if (running.has(id) || (await launcher.isRunningFrom(installDir(id)).catch(() => false))) throw new Error('Close the game first.');
    const last = await engine.restore(game, installDir(id), name);
    await config.setGame(id, { lastSync: last, pending: false });
    send('games-changed');
    return true;
  },

  // ---- VNDB info

  async refreshVndb(id) {
    const game = await getGame(id);
    if (!game.vndbId) throw new Error('This game isn\'t linked to VNDB yet. Use "Find on VNDB" first.');
    const full = await vndb.fetchInfo(game.vndbId);
    const g = await library.update(id, { vndb: full.info, developer: game.developer || full.developer });
    send('games-changed');
    return decorate(g);
  },

  async vndbBestMatch(q) { return vndb.bestMatch(q); },

  // ---- VNDB list

  async vndbConnect(token) {
    token = String(token || '').trim().replace(/^Token\s+/i, '');
    if (!token) throw new Error('Paste your VNDB token first.');
    const info = await vndbClient(token).authinfo();
    const perms = (info && info.permissions) || [];
    if (!perms.includes('listread')) throw new Error('This token can\'t read your list. Make a new one with "Access to my list" ticked.');
    vndbToken.save(token);
    const prev = config.data.vndb;
    if (prev && prev.userId !== info.id) await fs.promises.rm(vndbCacheFile(), { force: true });
    listOnlySaved = null;
    await config.set({ vndb: { userId: info.id, username: info.username, canWrite: perms.includes('listwrite'), labels: [], lastSyncAt: null, lastError: null } });
    vndbSync({ full: true }).catch(() => {});
    return api.getSetup();
  },

  async vndbDisconnect() {
    clearTimeout(vndbSoonTimer);
    vndbToken.clear();
    await config.set({ vndb: null });
    await fs.promises.rm(vndbCacheFile(), { force: true });
    await fs.promises.rm(listOnlyFile(), { force: true });
    listOnlySaved = null;
    send('vndb-state', vndbInfo());
    return api.getSetup();
  },

  async vndbSyncNow() {
    if (!config.data.vndb) throw new Error('Connect your VNDB account first (Settings → VNDB).');
    return vndbSync({ full: true });
  },

  /** List entries whose VN isn't in the library, each with an unlinked game of the same name if there is one. */
  /**
   * VNs on the VNDB list that aren't in the library. With { cached }, the copy saved last time
   * (instant, for showing straight away while the real one is worked out), or null.
   */
  async vndbListOnly({ cached } = {}) {
    if (!config.data.vndb) return { entries: [] };
    if (cached) {
      if (!listOnlySaved) listOnlySaved = await fsu.readJson(listOnlyFile(), null);
      return listOnlySaved && listOnlySaved.user === config.data.vndb.userId ? { ...listOnlySaved.view, cached: true } : null;
    }
    if (!library) return { entries: [] };
    const cache = (await fsu.readJson(vndbCacheFile(), null)) || {};
    if (cache.user !== config.data.vndb.userId) return { entries: [], loading: true };
    const games = await library.list({ maxAge: STATUS_MAX_AGE });
    const unlinked = games.filter((g) => !g.vndbId);
    const entries = vndbList.listOnly(cache, games).map((e) => {
      const names = [e.title, e.titleAlt].map(detect.normName).filter((n) => n.length >= 3);
      // Only near-identical names ("Muv-Luv" is not "Muv-Luv Tactics").
      const close = (n, m) => detect.namesMatch(n, m) && Math.min(n.length, m.length) / Math.max(n.length, m.length) >= 0.8;
      const match = unlinked.find((g) => [g.title, g.titleAlt].map(detect.normName).some((n) => n.length >= 3 && names.some((m) => close(n, m))));
      return { ...e, linkTo: match ? { id: match.id, title: match.title } : null };
    });
    const view = { entries, loading: !cache.fullAt };
    if (!view.loading) {
      listOnlySaved = { user: config.data.vndb.userId, view };
      fsu.writeJson(listOnlyFile(), listOnlySaved).catch(() => {});
    }
    return view;
  },

  /** Add a VN from the VNDB list to the library (not installed on this PC until its game is located). */
  async vndbAddFromList(vid) {
    requireLibrary();
    const full = await vndb.fetchInfo(vid);
    refuseBlocked(full.title, full.titleAlt, full.info && full.info.aliases);
    // Where the game is on this PC first; cancelling adds nothing.
    const file = await api.pickFile(`Find ${full.title} on this PC`, [{ name: 'Programs', extensions: ['exe', 'bat', 'lnk', 'sh', 'AppImage', '*'] }]);
    if (!file) return null;
    const prog = await resolveProgram(file);
    const game = await library.create({ title: full.title, titleAlt: full.titleAlt, developer: full.developer, vndbId: full.vndbId, titleSource: 'vndb', exe: path.basename(prog.exePath) });
    await useProgram(game.id, prog);
    const g = await api.applyVndb(game.id, full);
    vndbSync().catch(() => {}); // brings in its status, labels and rating
    return g;
  },

  /** Link a library game to a VN on the list (the same as picking it in "Find on VNDB"). */
  async vndbLink(id, vid) {
    const full = await vndb.fetchInfo(vid);
    const g = await api.applyVndb(id, full);
    vndbSync().catch(() => {});
    return g;
  },

  // ---- VNDB extras on a game's page: screenshots, related VNs, staff, characters; works by a person or brand

  async vndbExtras(id) {
    const game = await peekGame(id);
    if (!game.vndbId) return null;
    const x = await vndbCached(`vn-${game.vndbId}`, () => vndb.fetchExtras(game.vndbId));
    if (!x) return null;
    const mark = await vndbMarker();
    // VNDB's engine only matters when VN Shelf couldn't tell from the files.
    const engines = game.engine ? [] : (await vndbEnginesFor(game)()) || [];
    return { ...x, engines, relations: x.relations.map((r) => ({ ...r, ...mark(r.vndbId) })) };
  },

  async vndbCharacters(id) {
    const game = await peekGame(id);
    if (!game.vndbId) return [];
    const chars = (await vndbCached(`chars-${game.vndbId}`, () => vndb.fetchCharacters(game.vndbId))) || [];
    return chars.map((c) => ({ ...c, descSegments: c.description ? vndb.parseDescription(c.description) : null }));
  },

  /** Everything a person (s…) or brand (p…) worked on, each marked as in the library / on the VNDB list. */
  async vndbWorks(who) {
    const key = String(who || '').toLowerCase();
    if (!/^[sp]\d+$/.test(key)) throw new Error('Not a VNDB person or brand.');
    const [works, name] = await Promise.all([
      vndbCached(`works-${key}`, () => vndb.fetchWorks(key)),
      vndbCached(`name-${key}`, () => vndb.fetchName(key)),
    ]);
    if (!works) throw new Error('Couldn\'t load this from VNDB. Check your connection and try again.');
    const mark = await vndbMarker();
    return { id: key, kind: key.startsWith('s') ? 'staff' : 'producer', name: name ? name.name : key, original: name ? name.original : '', works: works.map((w) => ({ ...w, ...mark(w.vndbId) })) };
  },

  // ---- bulk import

  async scanImport(dir) {
    requireLibrary();
    const known = new Set(Object.values(config.data.games).map((l) => (l.exePath || '').toLowerCase()).filter(Boolean));
    const knownDirs = new Set(Object.values(config.data.games).map((l) => (l.installDir || '').toLowerCase()).filter(Boolean));
    const found = await importer.scan(dir, { onProgress: (p) => send('import-progress', { phase: 'scan', ...p }) });
    return found.map((f) => ({ ...f, already: known.has(f.exe.toLowerCase()) || knownDirs.has(f.dir.toLowerCase()) }));
  },

  /**
   * Add many games at once. items: [{ exe, dir, title, match }] where match is a VNDB result
   * (from vndbBestMatch) or null. Each game gets its most likely save folder when one with files
   * is found and it passes the safety checks; the rest can be set up on the game page.
   */
  async importGames(items) {
    requireLibrary();
    const results = [];
    let n = 0;
    for (const it of items) {
      n++;
      send('import-progress', { phase: 'add', done: n - 1, total: items.length, title: it.match ? it.match.title : it.title });
      try {
        refuseBlocked(it.title, it.match && [it.match.title, it.match.titleAlt]);
        const found = await detect.detectEngine(it.dir, roots).catch(() => null);
        let game = await library.create({ title: it.title, exe: path.basename(it.exe), engine: found ? found.engine.name : null, titleSource: 'folder' });
        await config.setGame(game.id, { exePath: it.exe, installDir: it.dir });
        if (it.match) {
          await api.applyVndb(game.id, it.match).catch(() => {});
          game = await library.get(game.id);
        }
        let savePath = null;
        const sug = await detect.suggest(game, it.dir, { roots, vndbEngines: vndbEnginesFor(game) }).catch(() => ({ candidates: [] }));
        const best = sug.candidates.find((c) => c.exists && c.fileCount > 0
          && !limits.rejectPath(c.path, c.include, { cloudDir: config.data.cloudDir, abs: c.abs }));
        if (best) {
          const added = await api.addSaveRule(game.id, { path: best.path, include: best.include });
          if (added && added.path && !added.refused && !added.needsConfirm) savePath = added.path;
        }
        results.push({ id: game.id, title: game.title, savePath });
      } catch (e) {
        results.push({ title: it.title, error: e.message });
      }
    }
    send('import-progress', { phase: 'done', done: items.length, total: items.length });
    send('games-changed');
    return results;
  },

  // ---- companion tools

  async setGameTools(id, toolIds) {
    await config.setGame(id, { tools: (toolIds || []).map(String) });
    return true;
  },

  async gameTools(id) {
    const chosen = new Set(local(id).tools || []);
    return (config.data.tools || []).map((t) => ({ ...t, enabled: t.allGames || chosen.has(t.id) }));
  },

  // ---- save export / import

  async exportSaves(id) {
    const game = await getGame(id);
    if (!local(id).exePath) throw new Error('Set the game up on this PC first.');
    const { zip, files } = await savesio.exportSaves(engine, game, installDir(id));
    if (!files) throw new Error('There are no save files on this PC to export yet.');
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = game.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'saves';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export saves', defaultPath: path.join(app.getPath('documents'), `${safe} saves ${stamp}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, zip);
    return { path: r.filePath, files };
  },

  async importSaves(id) {
    const game = await getGame(id);
    if (running.has(id)) throw new Error('Close the game first.');
    if (!local(id).exePath) throw new Error('Set the game up on this PC first.');
    const f = await api.pickFile('Choose a VN Shelf save export', [{ name: 'Zip', extensions: ['zip'] }]);
    if (!f) return null;
    if (await launcher.isRunningFrom(installDir(id)).catch(() => false)) throw new Error('Close the game first.');
    const buf = await fs.promises.readFile(f);
    const r = await exclusive(id, () => savesio.importSaves(engine, game, installDir(id), buf));
    const fresh = await library.get(id);
    const s = await runSync(fresh, { resolution: 'local' }).catch((e) => ({ error: e.message }));
    send('games-changed');
    return { ...r, uploaded: !!s.ok };
  },

  // ---- VN archive

  async archiveState() { return archiveState(); },

  /** Log in once to make this PC's API token; the password isn't kept. */
  async archiveConnect({ server, username, password }) {
    const name = `VN Shelf (${config.data.deviceName || os.hostname()})`;
    const c = await archive.connect(server, String(username || '').trim(), String(password || ''), { tokenName: name });
    archiveToken.save({ token: c.token, tokenName: c.tokenName });
    const prev = config.data.archive || {};
    // "New in the archive" counts from the first time this PC connected to this server.
    const connectedAt = prev.server === c.server && prev.connectedAt ? prev.connectedAt : new Date().toISOString();
    await config.set({ archive: { ...prev, server: c.server, username: c.username, index: null, count: 0, connectedAt } });
    archiveIndexCache = null;
    try {
      await archiveIndex({ fresh: true });
    } catch (e) {
      // Signed in, but nothing to show (no index, or no access to it): don't stay half connected.
      await archive.revoke(c.server, c.token, c.tokenName).catch(() => false);
      archiveToken.clear();
      archiveIndexCache = null;
      throw e;
    }
    await setUpArchiveQueue();
    return archiveState();
  },

  async archiveDisconnect() {
    if (archiveQueue) for (const j of archiveQueue.jobs) if (j.abort) j.abort.abort();
    const tok = archiveToken.load();
    const a = config.data.archive || {};
    if (tok && a.server) await archive.revoke(a.server, tok.token, tok.tokenName).catch(() => false);
    archiveToken.clear();
    archiveIndexCache = null;
    await fs.promises.rm(archiveFile('archive-index.json'), { force: true }).catch(() => {});
    await config.set({ archive: { ...(config.data.archive || {}), index: null, count: 0 } });
    await setUpArchiveQueue();
    return archiveState();
  },

  async archiveSettings(patch = {}) {
    const a = { ...(config.data.archive || {}) };
    if (patch.downloadDir !== undefined) a.downloadDir = String(patch.downloadDir || '');
    if (patch.sevenZip !== undefined) a.sevenZip = String(patch.sevenZip || '');
    if (patch.keepArchives !== undefined) a.keepArchives = !!patch.keepArchives;
    await config.set({ archive: a });
    return archiveState();
  },

  /** The archive's VNs, each with its cover, whether it's in your library and on your VNDB list. */
  async archiveItems({ fresh = false } = {}) {
    const index = await archiveIndex({ fresh });
    if (!index) return null;
    const items = index.items || [];
    const vids = [...new Set(items.flatMap((i) => i.vids || []))];
    const briefs = (await vndbCached(`archive-briefs-${vids.length}-${index.generated || ''}`, () => vndb.fetchBriefs(vids)).catch(() => null)) || [];
    const byId = new Map(briefs.map((b) => [b.vndbId, b]));
    const games = library ? await library.list({ maxAge: STATUS_MAX_AGE }) : [];
    const inLib = new Map(games.filter((g) => g.vndbId).map((g) => [g.vndbId, g.id]));
    const byKey = new Map(games.filter((g) => g.archiveKey).map((g) => [g.archiveKey, g.id]));
    // Several versions/parts of one VN: only the one you downloaded counts as in the library
    // (by vids alone, any one of them would mark them all).
    const siblings = new Map();
    for (const it of items) { const k = (it.vids || []).slice().sort().join(',') || it.path; siblings.set(k, (siblings.get(k) || 0) + 1); }
    const cache = config.data.vndb ? (await fsu.readJson(vndbCacheFile(), null)) || {} : {};
    const onList = new Set(Object.keys(cache.entries || {}));
    return {
      generated: index.generated || null,
      items: items.map((it) => {
        const b = (it.vids || []).map((v) => byId.get(v)).find(Boolean);
        const sk = (it.vids || []).slice().sort().join(',') || it.path;
        const gid = byKey.get(it.path) || (siblings.get(sk) === 1 ? (it.vids || []).map((v) => inLib.get(v)).find(Boolean) : null);
        const pl = unpack.plan((it.files || []).map((f) => f.path));
        return {
          key: it.path, title: it.title, titleEn: it.titleEn || (b && b.title) || null, group: it.group, kind: it.kind,
          vids: it.vids || [], igdb: it.igdb || null, edition: it.edition || null, part: it.part || null,
          size: it.size || 0, fileCount: (it.files || []).length, added: it.added || null,
          disc: !pl.extract.length && pl.discs.length > 0,
          image: b ? b.image : null, released: b ? b.released : null, developer: b ? b.developer : null,
          gameId: gid || null, onList: (it.vids || []).some((v) => onList.has(v)),
        };
      }),
    };
  },

  async archiveDownload(key) {
    if (!archiveQueue) await setUpArchiveQueue();
    if (!archiveQueue) throw new Error('Connect to the archive first.');
    const index = await archiveIndex();
    const it = (index.items || []).find((x) => x.path === key);
    if (!it) throw new Error('That VN isn\'t in the archive any more.');
    // "SWAN SONG (SWAN SONG HD)", "Schwarzesmarken 紅血の紋章": versions and parts get their own folders.
    const name = safeName(`${it.title}${it.part ? ` ${it.part}` : it.edition && it.edition !== it.title ? ` (${it.edition})` : ''}`);
    let dest = path.join(archiveDownloadDir(), name);
    for (let n = 2; fs.existsSync(dest) && !archiveQueue.jobs.some((j) => j.dest === dest); n++) dest = path.join(archiveDownloadDir(), `${name} (${n})`);
    archiveQueue.add(it, { source: index.source, dest });
    return archiveQueue.list();
  },

  async archiveDownloads() { return archiveQueue ? archiveQueue.list() : []; },
  async archivePause(key) { if (archiveQueue) archiveQueue.pause(key); return api.archiveDownloads(); },
  async archiveResume(key) {
    if (!archiveQueue) return [];
    const j = archiveQueue.jobs.find((x) => x.key === key);
    if (j && ['needs-7zip', 'install-error'].includes(j.state)) { installDownloaded(j).catch(() => {}); return archiveQueue.list(); }
    archiveQueue.resume(key);
    return archiveQueue.list();
  },
  async archiveCancel(key) { if (archiveQueue) await archiveQueue.cancel(key); return api.archiveDownloads(); },
  async archiveClearFinished() {
    if (archiveQueue) { archiveQueue.jobs = archiveQueue.jobs.filter((j) => !['done', 'installed'].includes(j.state)); archiveQueue.changed(); }
    return api.archiveDownloads();
  },

  // ---- updates

  async checkUpdate() {
    if (process.env.VNS_FAKE_UPDATE) { updateInfo = JSON.parse(process.env.VNS_FAKE_UPDATE); return updateInfo; } // test hook
    updateInfo = await updater.checkForUpdate(app.getVersion());
    return updateInfo;
  },

  async installUpdate() {
    const info = updateInfo || (await api.checkUpdate());
    if (!info) return { upToDate: true };
    if (!canSelfUpdate(info)) {
      await shell.openExternal(info.page);
      return { opened: true };
    }
    if (running.size) throw new Error('Close your games first; VN Shelf restarts to update.');
    await stageUpdate(info, (p) => send('update-progress', p));
    await swapToUpdate(info);
    return { restarting: true };
  },

  // ---- look: fonts, and copying another PC's settings

  /** Add a font file (.ttf / .otf / .ttc) for the interface. It's copied into VN Shelf's settings folder. */
  async addFont() {
    const f = await api.pickFile('Choose a font file', [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }]);
    if (!f) return null;
    const file = path.basename(f).replace(/[^\w.\- ]+/g, '_');
    await fs.promises.mkdir(fontsDir(), { recursive: true });
    await fs.promises.copyFile(f, path.join(fontsDir(), file));
    const family = `VNS ${path.basename(file, path.extname(file))}`;
    const custom = ((config.data.fonts && config.data.fonts.custom) || []).filter((c) => c.file !== file);
    custom.push({ family, file });
    await config.set({ fonts: { ...config.data.fonts, custom } });
    publishSettingsSoon();
    return { setup: await api.getSetup(), family };
  },

  async removeFont(file) {
    const f = config.data.fonts || {};
    const gone = (f.custom || []).find((c) => c.file === file);
    const custom = (f.custom || []).filter((c) => c.file !== file);
    const next = { ...f, custom };
    if (gone && next.en === gone.family) next.en = '';
    if (gone && next.ja === gone.family) next.ja = '';
    await config.set({ fonts: next });
    await fs.promises.rm(path.join(fontsDir(), file), { force: true }).catch(() => {});
    publishSettingsSoon();
    return api.getSetup();
  },

  /** Other PCs that shared their settings: [{ deviceId, deviceName, sharedAt }], newest first. */
  async otherDevices() {
    requireLibrary();
    await publishSettings().catch(() => {});
    const out = [];
    for (const name of (await library.listDeviceFiles()).filter((n) => /^[\w-]+\.json$/.test(n))) {
      if (name === `${config.data.deviceId}.json`) continue;
      try {
        const j = JSON.parse((await library.getDeviceFile(name)).toString('utf8'));
        if (j && j.deviceId && j.settings) out.push({ deviceId: j.deviceId, deviceName: j.deviceName, sharedAt: j.sharedAt });
      } catch { /* damaged or still syncing */ }
    }
    return out.sort((a, b) => String(b.sharedAt).localeCompare(String(a.sharedAt)));
  },

  /** Replace this PC's look and preferences with another PC's (background picture and fonts too). */
  async copySettingsFrom(deviceId) {
    requireLibrary();
    if (!/^[\w-]+$/.test(deviceId)) throw new Error('Unknown PC.');
    const buf = await library.getDeviceFile(`${deviceId}.json`);
    if (!buf) throw new Error('That PC\'s settings aren\'t available yet. Let the shared storage finish syncing, then try again.');
    const j = JSON.parse(buf.toString('utf8'));
    const s = j.settings || {};
    const patch = {};
    for (const k of SHARED_KEYS) if (s[k] !== undefined) patch[k] = s[k];
    if (patch.theme !== undefined) patch.theme = cleanTheme(patch.theme);
    // Fonts: copy the other PC's added fonts here, then use the same choices.
    const missing = [];
    const custom = [...((config.data.fonts && config.data.fonts.custom) || [])];
    for (const f of (j.files && j.files.fonts) || []) {
      const data = await library.getDeviceFile(f.name).catch(() => null);
      if (!data) { missing.push(f.family.replace(/^VNS /, '')); continue; }
      const file = path.basename(f.file).replace(/[^\w.\- ]+/g, '_');
      await fs.promises.mkdir(fontsDir(), { recursive: true });
      await fs.promises.writeFile(path.join(fontsDir(), file), data);
      if (!custom.some((c) => c.file === file)) custom.push({ family: f.family, file });
    }
    const fontsOk = (name) => !name || !/^VNS /.test(name) || custom.some((c) => c.family === name);
    patch.fonts = {
      ...config.data.fonts, custom,
      en: fontsOk(s.fonts && s.fonts.en) ? (s.fonts && s.fonts.en) || '' : config.data.fonts.en,
      ja: fontsOk(s.fonts && s.fonts.ja) ? (s.fonts && s.fonts.ja) || '' : config.data.fonts.ja,
    };
    // Background picture.
    if (j.files && j.files.background) {
      const data = await library.getDeviceFile(j.files.background).catch(() => null);
      if (data) {
        const dest = path.join(app.getPath('userData'), `background${path.extname(j.files.background)}`);
        const old = config.data.background;
        if (old && old.file && old.file !== dest) await fs.promises.rm(old.file, { force: true }).catch(() => {});
        await fs.promises.writeFile(dest, data);
        patch.background = { file: dest, dim: (s.background && s.background.dim) ?? 0.72, blur: (s.background && s.background.blur) ?? 0, version: Date.now() };
      }
    } else if (s.background === null) {
      patch.background = null;
    }
    await config.set(patch);
    if (patch.closeToTray !== undefined || patch.language !== undefined) { if (tray) tray.setContextMenu(trayMenu()); }
    publishSettingsSoon();
    return { setup: await api.getSetup(), missingFonts: missing, from: j.deviceName };
  },

  // ---- background

  async chooseBackground() {
    const f = await api.pickFile('Choose a background image', [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]);
    if (!f) return null;
    const ext = (path.extname(f) || '.jpg').toLowerCase();
    const dest = path.join(app.getPath('userData'), `background${ext}`);
    const old = config.data.background;
    if (old && old.file && old.file !== dest) await fs.promises.rm(old.file, { force: true }).catch(() => {});
    await fs.promises.copyFile(f, dest);
    await config.set({ background: { file: dest, dim: old ? old.dim ?? 0.72 : 0.72, blur: old ? old.blur ?? 0 : 0, version: Date.now() } });
    publishSettingsSoon();
    return api.getSetup();
  },

  async setBackgroundLook({ dim, blur }) {
    const b = config.data.background;
    if (!b) return api.getSetup();
    await config.set({ background: { ...b, dim: Math.max(0, Math.min(0.95, Number(dim))), blur: Math.max(0, Math.min(30, Number(blur) || 0)) } });
    publishSettingsSoon();
    return api.getSetup();
  },

  async clearBackground() {
    const b = config.data.background;
    if (b && b.file) await fs.promises.rm(b.file, { force: true }).catch(() => {});
    await config.set({ background: null });
    publishSettingsSoon();
    return api.getSetup();
  },

  // ---- about

  /** Patch notes from CHANGELOG.md: the given version's section (default: this one), or all of it. */
  async changelog({ version = app.getVersion(), all = false } = {}) {
    let text = '';
    try { text = await fs.promises.readFile(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'); } catch { return null; }
    if (all) return text.replace(/^# Changelog\s*\n/, '').trim();
    const m = text.match(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    return m ? m[1].trim() : null;
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
    show: !startHidden,
    backgroundColor: '#0f1115',
    title: 'VN Shelf',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    // Windows: one slim top bar. The native title bar is hidden and the window buttons sit over ours.
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#c9cdd6', height: TOPBAR_HEIGHT },
    } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Mouse back/forward buttons (and keyboard media keys) on Windows arrive as app commands.
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') send('nav', 'back');
    if (cmd === 'browser-forward') send('nav', 'forward');
  });
  // The X hides VN Shelf to the tray (if there is one) so saves keep syncing; Quit is in the tray menu.
  win.on('close', (e) => {
    if (quitting || !config.data.closeToTray || !tray) return;
    e.preventDefault();
    win.hide();
    if (!config.data.trayHintShown) {
      notify(mainText('hiddenTitle'), mainText('hiddenBody'));
      config.set({ trayHintShown: true }).catch(() => {});
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { api.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  roots = paths.defaultRoots({ documents: app.getPath('documents') });
  config = new LocalConfig(path.join(app.getPath('userData'), 'config.json'));
  await config.load();
  const oauth = loadOAuthConfig();
  if (oauth) {
    googleAuth = new GoogleAuth({
      clientId: oauth.clientId, clientSecret: oauth.clientSecret, tokenStore: tokenStore(),
      openUrl: (u) => shell.openExternal(u), authUrl: process.env.VNS_GOOGLE_AUTH_URL, tokenUrl: process.env.VNS_GOOGLE_TOKEN_URL, revokeUrl: process.env.VNS_GOOGLE_REVOKE_URL,
    });
  }
  vndbToken = tokenStore('vndb-token.json');
  archiveToken = tokenStore('archive-token.json');
  if (config.data.lastVersion && updater.compareVersions(app.getVersion(), config.data.lastVersion) > 0) justUpdated = app.getVersion();
  if (config.data.lastVersion !== app.getVersion()) config.set({ lastVersion: app.getVersion() }).catch(() => {});
  rebuild();
  // A previous update that didn't finish can leave the downloaded exe next to this one.
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    for (const leftover of [`${process.env.PORTABLE_EXECUTABLE_FILE}.new`, `${process.env.PORTABLE_EXECUTABLE_FILE}.new.part`]) {
      fs.promises.rm(leftover, { force: true }).catch(() => {});
    }
  }
  createTray();
  if (config.data.startWithSystem) applyStartWithSystem(true).catch(() => {});
  await createWindow();
  setUpArchiveQueue().catch(() => {});
  setTimeout(() => { if (archiveClient()) archiveIndex({ fresh: true }).catch(() => {}); }, 5000);
  setTimeout(() => autoUpload().catch(() => {}), 4000);
  setTimeout(() => publishSettings().catch(() => {}), 8000);
  setInterval(() => autoUpload().catch(() => {}), 5 * 60 * 1000);
  if (config.data.vndb) setTimeout(() => vndbSync().catch(() => {}), 6000);
  setInterval(() => { if (config.data.vndb) vndbSync().catch(() => {}); }, 15 * 60 * 1000);
  pollChanges();
  win.on('show', schedulePoll);
  win.on('focus', () => { if (!pollTimer || Date.now() - lastFocusPoll > 15000) { lastFocusPoll = Date.now(); pollChanges(); } });
  if (config.data.autoUpdate && !process.env.VNS_NO_UPDATE_CHECK) {
    setTimeout(async () => {
      try {
        const u = await api.checkUpdate();
        if (u && config.data.updateInstall === 'auto' && (await autoInstall(u).catch(() => false)) !== false) return;
        if (u) send('update-available', u);
      } catch { /* offline: try again next start */ }
    }, 4000);
  }
  // Left running in the tray for days: look again twice a day when updates install themselves.
  setInterval(async () => {
    if (!config.data.autoUpdate || config.data.updateInstall !== 'auto' || stagedUpdate || process.env.VNS_NO_UPDATE_CHECK) return;
    try { const u = await api.checkUpdate(); if (u) await autoInstall(u); } catch { /* try later */ }
  }, 12 * 3600 * 1000);
});

// ---- self-update

const canSelfUpdate = (info) => process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE && !!(info && info.asset);
let stagedUpdate = null; // { version, file } once the new exe is downloaded

/** Download the new exe next to the current one (once per version). */
async function stageUpdate(info, onProgress) {
  const newExe = `${process.env.PORTABLE_EXECUTABLE_FILE}.new`;
  if (stagedUpdate && stagedUpdate.version === info.version) return newExe;
  await updater.download(info.asset, newExe, { onProgress });
  stagedUpdate = { version: info.version, file: newExe };
  return newExe;
}

/** Quit and let the swap script put the staged exe in place and start it (hidden if we are). */
async function swapToUpdate(info, { hidden = false } = {}) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  // The portable launcher (our parent) holds the exe open until it has cleaned up, so wait for it too.
  const script = await updater.writeSwapScript({
    currentExe: exe, newExe: `${exe}.new`, targetExe: updater.updatedExePath(exe, app.getVersion(), info.version),
    pids: [process.pid, process.ppid], dir: app.getPath('temp'), args: hidden ? ['--hidden'] : [],
  });
  updater.launchSwapScript(script);
  setTimeout(() => app.quit(), 300);
}

/** A good moment to restart: no game running or starting, no saves copying, and nobody using the window. */
function quietMoment() {
  if (running.size || starting.size || busyGames().length) return false;
  const away = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
  let idle = 0;
  try { idle = powerMonitor.getSystemIdleTime(); } catch { /* not available */ }
  return away || idle >= 300;
}

/** "Install automatically": download quietly, then restart into the new version at a quiet moment. */
async function autoInstall(info) {
  if (process.env.VNS_FAKE_AUTO_INSTALL) { send('update-staged', info); return; } // test hook
  if (!canSelfUpdate(info)) return false;
  await stageUpdate(info);
  const t = setInterval(() => {
    if (!quietMoment()) return;
    clearInterval(t);
    const hidden = !win || win.isDestroyed() || !win.isVisible();
    swapToUpdate(info, { hidden }).catch(() => {});
  }, 60000);
  return true;
}

// Never quit in the middle of copying saves: wait (up to 2 minutes) for syncs to finish first.
let quitWhenSynced = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (!busyGames().length || quitWhenSynced) return;
  e.preventDefault();
  quitWhenSynced = true;
  if (win && !win.isDestroyed()) win.hide();
  const until = Date.now() + 120000;
  const check = setInterval(() => {
    if (!busyGames().length || Date.now() > until) { clearInterval(check); app.quit(); }
  }, 300);
});

app.on('window-all-closed', () => {
  // Keep tracking a running game even if the window is closed? Simpler and safer: stay alive until it exits.
  if (running.size === 0) app.quit();
  else {
    const check = setInterval(() => { if (running.size === 0) { clearInterval(check); app.quit(); } }, 2000);
  }
});

module.exports = { api };
