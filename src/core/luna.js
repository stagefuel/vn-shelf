'use strict';
// Starting games through LunaTranslator, so its text hook is attached from the very start.
//
// LunaTranslator keeps its game list in <its folder>/userconfig/savegamedata_<version>.json, where
// each game ID maps to { gamepath, title, ... }. Its own "desktop shortcut" runs
// `LunaTranslator.exe --Exec <id>`, which starts that game hooked; we do the same. IDs differ per PC,
// so they're looked up by the game's .exe path every time and never stored in the shared library.
// A standalone LunaHook program has no game list, so it's just opened alongside the game.

const fsp = require('fs').promises;
const path = require('path');

const isTranslator = (exe) => /^lunatranslator(_x86|_x64)?\.exe$/i.test(path.basename(String(exe || '')));

const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Every { id, gamepath, title } in Luna's game list (newest savegamedata file), or []. */
async function gameList(lunaExe) {
  const dir = path.join(path.dirname(lunaExe), 'userconfig');
  let names;
  try { names = (await fsp.readdir(dir)).filter((n) => /^savegamedata.*\.json$/i.test(n)); } catch { return []; }
  const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  for (const { n } of stats) {
    let data;
    try { data = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); } catch { continue; }
    const out = [];
    // The list's shape has changed between versions: look for any { id: { gamepath } } map.
    (function walk(x, depth) {
      if (!x || typeof x !== 'object' || depth > 3) return;
      for (const [k, v] of Object.entries(x)) {
        if (v && typeof v === 'object' && typeof v.gamepath === 'string') out.push({ id: k, gamepath: v.gamepath, title: v.title || '' });
        else walk(v, depth + 1);
      }
    })(data, 0);
    if (out.length) return out;
  }
  return [];
}

/** Luna's ID for the game at `gameExe`, or null. */
async function findId(lunaExe, gameExe) {
  const want = norm(gameExe);
  const hit = (await gameList(lunaExe)).find((g) => norm(g.gamepath) === want);
  return hit ? hit.id : null;
}

/** The game .exe a Luna ID points to (to follow Luna's own desktop shortcuts), or null. */
async function gameFor(lunaExe, id) {
  const hit = (await gameList(lunaExe)).find((g) => g.id === String(id));
  return hit ? hit.gamepath : null;
}

/**
 * How to start a game with Luna: { mode: 'exec', cmd, argv, cwd } when LunaTranslator knows the game,
 * otherwise { mode: 'alongside' } (open Luna, then start the game as usual).
 */
async function plan(lunaExe, gameExe) {
  if (!lunaExe || !isTranslator(lunaExe)) return { mode: 'alongside' };
  const id = await findId(lunaExe, gameExe);
  if (!id) return { mode: 'alongside' };
  return { mode: 'exec', cmd: lunaExe, argv: ['--Exec', id], cwd: path.dirname(lunaExe) };
}

module.exports = { isTranslator, gameList, findId, gameFor, plan };
