'use strict';
// "Save once" detection: note the time, the user plays and saves once, then we list every
// file created or changed since then in the usual save places and suggest the likeliest folder.
// Only file dates are read (no hashing), so even a large AppData scans in seconds.

const fsp = require('fs').promises;
const path = require('path');
const { tokenize } = require('./paths');
const { normName, namesMatch } = require('./detect');

// Folders that change constantly for reasons unrelated to the game.
const SKIP_DIRS = new Set([
  'microsoft', 'windows', 'packages', 'temp', 'tmp', 'crashdumps', 'd3dscache', 'nvidia', 'nvidia corporation',
  'amd', 'intel', 'google', 'mozilla', 'brave-software', 'opera software', 'vivaldi', 'discord', 'discordptb',
  'slack', 'spotify', 'steam', 'steamapps', 'epic', 'epicgameslauncher', 'unrealengine', 'code', 'cursor',
  'npm', 'npm-cache', 'pip', 'node-gyp', 'jetbrains', 'adobe', 'zoom', 'teams', 'onedrive', 'dropbox',
  'google drive', 'drivefs', 'icloud', 'mega', 'megasync', 'box', 'syncthing', 'vn shelf', 'vn-shelf',
  'cache', 'caches', 'code cache', 'gpucache', 'shadercache', 'grshadercache', 'dawncache', 'crashpad',
  'logs', 'log', 'inetcache', 'webcache', 'history', 'service worker', 'blob_storage', 'indexeddb_leveldb',
  'squirreltemp', 'elevateddiagnostics', 'connecteddevicesplatform', 'comms', 'peer distribution',
  'my music', 'my pictures', 'my videos', 'sharex', 'obs-studio', 'nvidia share',
  'chrome', 'firefox', 'edge', 'microsoft edge', 'lunatranslator', 'lunahook', 'textractor', 'locale.emulator',
  'claude', 'fontcache', 'iconcache', 'notifications', 'explorer', 'recent', 'unitycrashhandler', 'mediafoundation',
  'python', '__pycache__', 'node_modules', '.vscode', 'vscode', 'programs', 'meikipop', 'magpie', 'ikemenreader',
  'd3d12', 'dxcache', 'glcache', 'shadercache', 'fxc', 'directx', 'crashreports', 'crashreporter',
]);
const SKIP_EXT = new Set(['.log', '.tmp', '.etl', '.lock', '.pf', '.dmp', '.cache', '.db-wal', '.db-shm', '.ldb',
  '.journal', '.lnk', '.crdownload', '.partial', '.vns-tmp']);

/** The places a game is likely to write saves, as [token, absolute dir]. */
function scanRoots(roots, gameDir) {
  const list = [];
  if (gameDir) list.push(['<game>', gameDir]);
  for (const t of ['<appdata>', '<localappdata>', '<locallow>', '<documents>', '<savedgames>']) {
    if (roots[t]) list.push([t, roots[t]]);
  }
  return list;
}

/**
 * Walk every root and return files modified at or after `sinceMs`.
 * @param {string[]} [extraSkip] absolute paths never to enter (e.g. the shared folder)
 */
async function changedSince(roots, gameDir, sinceMs, { extraSkip = [], maxFiles = 2000 } = {}) {
  const skipAbs = extraSkip.filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  const changed = [];
  const seenRoots = [];
  for (const [token, root] of scanRoots(roots, gameDir)) {
    const rootKey = path.resolve(root).toLowerCase();
    // <game> may live inside Documents etc.; don't scan the same tree twice.
    const nestedInGame = token !== '<game>' && gameDir && rootKey === path.resolve(gameDir).toLowerCase();
    if (nestedInGame || seenRoots.includes(rootKey)) continue;
    seenRoots.push(rootKey);
    await (async function rec(dir, depth) {
      if (changed.length >= maxFiles || depth > 10) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          const lower = e.name.toLowerCase();
          if (token !== '<game>' && SKIP_DIRS.has(lower)) continue;
          if (lower.startsWith('.')) continue;
          const absKey = path.resolve(abs).toLowerCase();
          if (skipAbs.some((s) => absKey === s || absKey.startsWith(s + path.sep))) continue;
          if (token !== '<game>' && gameDir && absKey === path.resolve(gameDir).toLowerCase()) continue;
          await rec(abs, depth + 1);
        } else if (e.isFile()) {
          if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
          try {
            const st = await fsp.stat(abs);
            // Created or changed: a file copied in keeps its old modified time but gets a new creation time.
            if (st.mtimeMs >= sinceMs || (st.birthtimeMs && st.birthtimeMs >= sinceMs && st.birthtimeMs <= Date.now())) {
              changed.push({ abs, token, root, size: st.size, mtime: st.mtimeMs });
            }
          } catch { /* vanished */ }
        }
      }
    })(root, 0);
  }
  return changed;
}

/**
 * Group changed files into candidate save folders and rank them.
 * Files directly in the game folder become an include list rather than the whole game folder.
 */
function rank(changed, { game, roots, gameDir, platform = process.platform }) {
  const terms = [game.title, game.titleAlt, game.developer,
    game.exe ? path.basename(game.exe).replace(/\.[^.]+$/, '') : '', gameDir ? path.basename(gameDir) : '']
    .map(normName).filter((t) => t.length >= 3);

  const groups = new Map();
  for (const f of changed) {
    const rel = path.relative(f.root, f.abs).split(path.sep);
    let folder;
    let include = [];
    if (f.token === '<game>') {
      if (rel.length === 1) { folder = f.root; include = [rel[0]]; } else folder = path.join(f.root, rel[0]);
    } else {
      if (rel.length === 1) continue; // loose files at the top of AppData/Documents are never a game's saves
      // Vendor/Product is the usual AppData shape; go one level deeper than the vendor when possible.
      const depth = Math.min(rel.length - 1, 2);
      folder = path.join(f.root, ...rel.slice(0, Math.max(depth, 1)));
    }
    const key = `${folder}|${f.token === '<game>' && include.length ? 'loose' : ''}`;
    if (!groups.has(key)) groups.set(key, { folder, include: [], files: [], token: f.token });
    const g = groups.get(key);
    g.files.push(f);
    for (const i of include) if (!g.include.includes(i)) g.include.push(i);
  }

  const out = [];
  for (const g of groups.values()) {
    let score = 0;
    const reasons = [];
    const folderNames = path.relative(g.token === '<game>' ? gameDir : roots[g.token] || '', g.folder).split(path.sep).map(normName);
    if (g.token === '<game>') { score += 3; reasons.push('inside the game folder'); }
    if (folderNames.some((n) => terms.some((t) => namesMatch(n, t)))) { score += 4; reasons.push('named after the game'); }
    const saveish = g.files.filter((f) => /sav|\.dat$|slot|record/i.test(path.basename(f.abs))).length;
    if (saveish) { score += 2; reasons.push(`${saveish} file(s) look like saves`); }
    if (/save/i.test(g.folder)) { score += 2; reasons.push('folder name contains "save"'); }
    const tok = tokenize(g.folder, { roots, gameDir, platform });
    // Collapse loose files in the game folder into patterns like Save*.dat when there are many.
    const include = g.include.length > 6 ? collapsePatterns(g.include) : g.include;
    out.push({
      path: tok.path, portable: tok.portable, include, abs: g.folder, score,
      reason: reasons.join(', ') || 'changed while the game was running',
      files: g.files.map((f) => path.relative(g.folder, f.abs).split(path.sep).join('/')).slice(0, 50),
      fileCount: g.files.length,
    });
  }
  out.sort((a, b) => b.score - a.score || b.fileCount - a.fileCount);
  return out;
}

function collapsePatterns(names) {
  const pats = new Set();
  for (const n of names) {
    const m = /^([A-Za-z_-]*?)\d+(\.[^.]+)?$/.exec(n);
    pats.add(m ? `${m[1]}*${m[2] || ''}` : n);
  }
  return [...pats];
}

module.exports = { changedSince, rank, scanRoots, SKIP_DIRS };
