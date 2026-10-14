'use strict';
// Bulk import: walk a folder (e.g. G:\VNJP), find each game's folder and its main .exe.
// A folder counts as a game once it holds a program that isn't an installer, config tool,
// crack or updater; its subfolders are then not searched.

const fsp = require('fs').promises;
const path = require('path');
const { normName } = require('./detect');

// Programs that are almost never the game itself.
const NOT_GAME = /^(unins\d*|uninstall(er)?|setup|install(er)?|.*setup|.*install|config(uration)?|.*config|.*cfg|settings?|directxcheck|dxsetup|dxwebsetup|vc_?redist.*|vcredist.*|filechk|startuptool|.*crack(er)?.*|alpharom.*|.*patch.*|.*update(r)?|lec|leproc|ntleas.*|unitycrashhandler(32|64)?|crashhandler|notification_helper|python[w0-9.]*|.*check|.*register|.*regist|.*manual|readme|.*tool)$/i;
// Folders inside a game that are never another game.
const SKIP_DIRS = new Set(['_commonredist', 'redist', 'directx', 'dx', 'manual', 'マニュアル', 'extras', 'bonus', 'ost', 'soundtrack',
  'movie', 'movies', 'video', 'videos', 'savedata', 'save', 'saves', 'userdata', 'system', 'data', 'www', 'plugins', 'font', 'fonts',
  'artbook', 'artbooks', 'scans', 'patches', 'patch', 'crack', '__macosx', '$recycle.bin', 'system volume information']);

/** A readable title from a folder name: drops [brand] tags, version suffixes and underscores. */
function cleanTitle(name) {
  const tidy = (x) => x.replace(/\s+/g, ' ').trim();
  let s = String(name)
    .replace(/[\[(【［].*?[\])】］]/g, ' ')
    .replace(/_(game|games)$/i, ''); // "manosaba_game" (only when glued on with "_")
  s = tidy(s.replace(/[_]+/g, ' '));
  s = tidy(s.replace(/[\s+-]*v?(?:er)?\.?\s?\d+(?:\.\d+)+[a-z]?$/i, '')); // "Game v1.05", "DemonsRoots1.2.1"
  s = tidy(s.replace(/[\s+-]+v\d+$/i, '')); // "Title+v115"
  s = tidy(s.replace(/\s*-\s*copy(\s*\(\d+\))?$/i, '')); // "月姫 - Copy"
  s = tidy(s.replace(/[\s+-]+(19|20)\d{2}[\s.-]\d{1,2}[\s.-]\d{1,2}$/, '')); // "Game 2025 08 29"
  s = tidy(s.replace(/[\s+-]+(win|win32|win64|windows|pc|x64|x86)$/i, '')); // "game_win"
  s = tidy(s.replace(/[\s+-]+(eng|english|en|jp|jpn|japanese|ja)$/i, '')); // "BLACK SHEEP TOWN_eng"
  s = tidy(s.replace(/[\s+-]+\d{6,8}$/, '')); // "Game 20250829"
  return s || String(name);
}

/** Pick the most likely game program among a folder's .exe files. */
function pickExe(exes, folderName, dirNames = []) {
  const folder = normName(cleanTitle(folderName));
  const dataDirs = dirNames.filter((d) => /_data$/i.test(d)).map((d) => d.replace(/_data$/i, '').toLowerCase());
  const scored = exes.map((e) => {
    const base = e.name.replace(/\.exe$/i, '');
    const n = normName(base);
    let score = 0;
    if (NOT_GAME.test(base)) score -= 100;
    if (dataDirs.includes(base.toLowerCase())) score += 50; // Unity: Game.exe + Game_Data
    if (folder && n && (folder.includes(n) || n.includes(folder)) && n.length >= 3) score += 20;
    if (/^(game|start|play|main)$/i.test(base)) score += 5;
    score += Math.min(10, Math.log2(1 + e.size / (1024 * 1024))); // bigger usually means the real game
    return { ...e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Find games under `rootDir`.
 * @returns {Promise<Array<{dir, title, exe, exes: string[], score}>>}
 */
async function scan(rootDir, { maxDepth = 4, onProgress } = {}) {
  const found = [];
  let seen = 0;
  async function rec(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    seen++;
    if (onProgress && seen % 25 === 0) onProgress({ folders: seen, games: found.length });
    const exes = [];
    for (const e of entries) {
      if (e.isFile() && /\.exe$/i.test(e.name)) {
        let size = 0;
        try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch { /* ignore */ }
        exes.push({ name: e.name, size });
      }
    }
    const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (exes.length) {
      const ranked = pickExe(exes, path.basename(dir), dirNames);
      if (ranked[0].score > -50) {
        found.push({
          dir,
          title: cleanTitle(path.basename(dir)),
          exe: path.join(dir, ranked[0].name),
          exes: ranked.map((r) => r.name),
          score: ranked[0].score,
        });
        return;
      }
    }
    if (depth >= maxDepth) return;
    for (const d of dirNames) {
      if (SKIP_DIRS.has(d.toLowerCase()) || d.startsWith('.')) continue;
      await rec(path.join(dir, d), depth + 1);
    }
  }
  await rec(rootDir, 0);
  found.sort((a, b) => a.dir.localeCompare(b.dir, 'ja'));
  return found;
}

module.exports = { scan, pickExe, cleanTitle, NOT_GAME };
