'use strict';
// Suggest save locations for a game without running it:
//   1. recognise the engine from its files and use that engine's usual save folder
//   2. look for folders called save/savedata/UserData inside the game folder
//   3. look in AppData / Documents / Saved Games for folders named after the game,
//      its .exe or its developer
// When the files don't show the engine, the engine VNDB lists for the game's release is used as a
// hint instead; it never replaces an engine recognised from the files.
// Every suggestion is only a suggestion; the user confirms or sets folders by hand.

const fsp = require('fs').promises;
const path = require('path');
const fsu = require('./fsutil');
const { expand } = require('./paths');

async function listNames(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

const ENGINES = [
  {
    // age's rUGP: saves go to Documents/<vendor>/<name>/Vmreg; that folder holds "<archive>.rio.ici".
    id: 'rugp', name: 'rUGP',
    match: (c) => c.hasFile('rugp.exe') || c.hasExt('.rio'),
    saves: async (c) => {
      const rios = c.filesWithExt('.rio');
      const out = [];
      if (!c.roots['<documents>']) return out;
      for (const vendor of await listNames(c.roots['<documents>'])) {
        if (!vendor.isDirectory()) continue;
        for (const d of await listNames(path.join(c.roots['<documents>'], vendor.name))) {
          if (!d.isDirectory()) continue;
          const kids = (await listNames(path.join(c.roots['<documents>'], vendor.name, d.name))).map((k) => k.name.toLowerCase());
          if (rios.some((r) => kids.includes(`${r.toLowerCase()}.ici`))) out.push({ path: `<documents>/${vendor.name}/${d.name}` });
        }
      }
      return out;
    },
  },
  {
    id: 'rpg2k', name: 'RPG Maker 2000/2003',
    match: (c) => c.hasFile('rpg_rt.ldb') || c.hasFile('rpg_rt.exe'),
    saves: () => [{ path: '<game>', include: ['Save*.lsd'] }],
  },
  {
    id: 'kirikiri', name: 'KiriKiri',
    match: (c) => c.hasExt('.xp3'),
    saves: () => [{ path: '<game>/savedata' }],
  },
  {
    id: 'renpy', name: "Ren'Py",
    match: (c) => c.hasDir('renpy') || (c.hasDir('game') && c.hasDir('lib') && c.hasExt('.exe')),
    saves: async (c) => {
      const out = [{ path: '<game>/game/saves' }];
      const opts = await readText(path.join(c.dir, 'game', 'options.rpy'));
      const m = opts && /config\.save_directory\s*=\s*["']([^"']+)["']/.exec(opts);
      if (m) out.push({ path: `<appdata>/RenPy/${m[1]}` });
      return out;
    },
  },
  {
    id: 'rpgmz', name: 'RPG Maker MZ',
    match: (c) => c.exists('js/rmmz_core.js'),
    saves: () => [{ path: '<game>/save' }],
  },
  {
    id: 'rpgmv', name: 'RPG Maker MV',
    match: (c) => c.exists('www/js/rpg_core.js') || c.exists('js/rpg_core.js'),
    saves: (c) => [{ path: c.hasDir('www') ? '<game>/www/save' : '<game>/save' }],
  },
  {
    id: 'rgss', name: 'RPG Maker XP / VX / VX Ace',
    match: (c) => c.hasExt('.rgss3a') || c.hasExt('.rgss2a') || c.hasExt('.rgssad'),
    saves: () => [{ path: '<game>', include: ['Save*.rvdata2', 'Save*.rvdata', 'Save*.rxdata'] }],
  },
  {
    id: 'siglus', name: 'SiglusEngine',
    match: (c) => c.hasFile('scene.pck') || c.hasFile('siglusengine.exe'),
    saves: () => [{ path: '<game>/savedata' }],
  },
  {
    id: 'bgi', name: 'BGI / Ethornell',
    match: (c) => c.hasFile('bgi.exe') || c.hasFile('bgi.gdb') || c.hasFile('sysprg.arc'),
    saves: () => [{ path: '<game>/UserData' }],
  },
  {
    id: 'catsystem2', name: 'CatSystem2',
    match: (c) => c.hasFile('cs2.exe') || (c.hasExt('.int') && c.hasFile('cs2conf.dll')),
    saves: () => [{ path: '<game>/savedata' }],
  },
  {
    id: 'system4', name: 'AliceSoft System 4',
    match: (c) => c.hasExt('.ain') || c.hasExt('.ald') || c.hasFile('system40.exe'),
    saves: () => [{ path: '<game>/SaveData' }],
  },
  {
    id: 'artemis', name: 'Artemis',
    match: (c) => c.hasExt('.pfs'),
    saves: () => [{ path: '<game>/save' }],
  },
  {
    id: 'yuris', name: 'YU-RIS',
    match: (c) => c.hasExt('.ypf'),
    saves: () => [{ path: '<game>/savedata' }],
  },
  {
    id: 'nscripter', name: 'NScripter / ONScripter',
    match: (c) => c.hasFile('nscript.dat') || c.hasExt('.nsa'),
    saves: () => [{ path: '<game>', include: ['save*.dat', 'gloval.sav', 'envdata', 'kidoku.dat'] }],
  },
  {
    id: 'unity', name: 'Unity',
    match: (c) => c.dataDir !== null,
    saves: async (c) => {
      const info = await readText(path.join(c.dir, c.dataDir, 'app.info'));
      if (!info) return [];
      const [company, product] = info.split(/\r?\n/).map((s) => s.trim());
      return company && product ? [{ path: `<locallow>/${company}/${product}` }] : [];
    },
  },
];

// VNDB's engine names (from release entries) for the engines above.
const ENGINE_ALIASES = [
  ['kirikiri', /^(kirikiri|krkr|kag|吉里吉里)/],
  ['renpy', /^renpy/],
  ['rpgmz', /^rpgmakermz/],
  ['rpgmv', /^rpgmakermv/],
  ['rgss', /^rpgmaker(xp|vx|vxace)$/],
  ['rpg2k', /^rpgmaker(2000|2003|2k)/],
  ['siglus', /^siglus/],
  ['bgi', /^(bgi|ethornell|burikogeneralinterpreter)/],
  ['catsystem2', /^catsystem/],
  ['system4', /^(alicesoft)?system4/],
  ['artemis', /^artemis/],
  ['yuris', /^yuris/],
  ['nscripter', /^o?nscripter/],
  ['unity', /^unity/],
  ['rugp', /^rugp/],
];

/** The ENGINES entry for a VNDB engine name ("KiriKiri Z", "AliceSoft System4.X"), or null. */
function engineFromVndb(name) {
  const n = normName(name);
  const hit = n && ENGINE_ALIASES.find(([, re]) => re.test(n));
  return hit ? ENGINES.find((e) => e.id === hit[0]) : null;
}

// Folder names that hold saves: save, Saves, savedata, faterealtanua_savedata, UserData, Vmreg (age), ...
const SAVE_DIR_RE = /^(?:.*[_\-\s])?(?:save|saves|savedata|save_data|savedat|sav|userdata|vmreg)$/i;
// Loose save files in the game folder.
const SAVE_FILE_EXT = ['.sav', '.save', '.savedata'];
// Words too generic to identify a game when matching folder names (common .exe names, engines).
const GENERIC = new Set(['game', 'games', 'start', 'launcher', 'launch', 'main', 'play', 'player', 'system', 'setup',
  'data', 'app', 'default', 'rugp', 'malie', 'rpgrt', 'nw', 'nwjs', 'mygame', 'config', 'sakura', 'siglusengine',
  'bgi', 'cs2', 'system40', 'artemis', 'unity', 'unitycrashhandler64', 'renpy', 'kirikiri', 'krkr', 'tyrano', 'tyranoscript', 'easyrpg', 'translate']);

// Big app folders that never hold VN saves; skipped to keep the search quick.
const SKIP_VENDOR = new Set(['microsoft', 'packages', 'google', 'mozilla', 'nvidia', 'nvidia corporation', 'temp', 'steam',
  'discord', 'code', 'adobe', 'programs', 'package cache', 'crashdumps', 'd3dscache', 'virtualstore']);

function normName(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length >= 4 && long.includes(short);
}

/** Build the file-listing context the engine checks use. */
async function context(dir, roots = {}) {
  const top = await listNames(dir);
  const files = new Set();
  const dirs = new Set();
  for (const e of top) (e.isDirectory() ? dirs : files).add(e.name.toLowerCase());
  const exts = new Set([...files].map((f) => path.extname(f)));
  const dataDir = top.find((e) => e.isDirectory() && /_data$/i.test(e.name));
  const existsCache = {};
  for (const rel of ['js/rmmz_core.js', 'www/js/rpg_core.js', 'js/rpg_core.js']) {
    existsCache[rel] = await fsu.exists(path.join(dir, ...rel.split('/')));
  }
  return {
    dir,
    roots,
    filesWithExt: (x) => top.filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === x).map((e) => e.name),
    hasFile: (n) => files.has(n.toLowerCase()),
    hasDir: (n) => dirs.has(n.toLowerCase()),
    hasExt: (x) => exts.has(x.toLowerCase()),
    exists: (rel) => !!existsCache[rel],
    dataDir: dataDir ? dataDir.name : null,
  };
}

async function detectEngine(dir, roots) {
  const c = await context(dir, roots);
  for (const e of ENGINES) if (e.match(c)) return { engine: e, ctx: c };
  return null;
}

/**
 * @returns {Promise<{engine: string|null, candidates: Array<{path, include, reason, abs, exists, fileCount, score}>}>}
 */
async function suggest(game, installDir, { roots, platform = process.platform, vndbEngines = null }) {
  const out = [];
  const push = (cand) => {
    const key = `${cand.path}|${(cand.include || []).join(',')}`;
    const prev = out.find((o) => o.key === key);
    if (prev) { prev.score = Math.max(prev.score, cand.score); return; }
    out.push({ include: [], ...cand, key });
  };

  // 1. Engine
  let engineName = null;
  let engineHint = false;
  if (installDir && (await fsu.isDir(installDir))) {
    const found = await detectEngine(installDir, roots);
    if (found) {
      engineName = found.engine.name;
      for (const s of await found.engine.saves(found.ctx)) {
        push({ ...s, reason: `${found.engine.name} games usually save here`, score: 6 });
      }
    } else if (vndbEngines) {
      // No engine in the files: try the one VNDB lists (a function, so VNDB is only asked when needed).
      const names = (await Promise.resolve(typeof vndbEngines === 'function' ? vndbEngines() : vndbEngines).catch(() => null)) || [];
      // Only the most likely engine: a lower one is often a port (Ever17's official release is
      // "MAGES. Engine", its NScripter release a fan port), which would point at the wrong folder.
      const hinted = names.length ? engineFromVndb(names[0]) : null;
      if (hinted) {
        engineName = hinted.name;
        engineHint = true;
        const ctx = await context(installDir, roots);
        for (const s of await hinted.saves(ctx)) {
          push({ ...s, reason: `VNDB says this game uses ${hinted.name}, which usually saves here`, score: 5 });
        }
      }
    }

    // 2. save-ish folders inside the game folder
    const all = [];
    await (async function rec(abs, rel, depth) {
      for (const e of await listNames(abs)) {
        if (!e.isDirectory()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (SAVE_DIR_RE.test(e.name)) all.push(r);
        if (depth < 3) await rec(path.join(abs, e.name), r, depth + 1);
      }
    })(installDir, '', 1);
    for (const r of all) push({ path: `<game>/${r}`, reason: 'Folder named like a save folder', score: 4 });
    const loose = new Set();
    for (const e of await listNames(installDir)) {
      const ext = path.extname(e.name).toLowerCase();
      if (e.isFile() && (SAVE_FILE_EXT.includes(ext) || /save$/i.test(ext))) loose.add(`*${path.extname(e.name)}`);
    }
    if (loose.size) push({ path: '<game>', include: [...loose], reason: 'Save files in the game folder', score: 4 });
  }

  // 3. Folders named after the game elsewhere: either directly (AppData/<Game>) or one level
  //    down inside a developer folder (AppData/枕/サクラノ刻, Saved Games/WillPlus/CROSS†CHANNEL).
  const exeBase = game.exe ? path.basename(game.exe).replace(/\.[^.]+$/, '') : '';
  const titleTerms = [game.title, game.titleAlt, exeBase, installDir ? path.basename(installDir).replace(/[\[(【].*?[\])】]/g, '') : '']
    .map(normName).filter((t) => t.length >= 3 && !GENERIC.has(t));
  const devTerms = String(game.developer || '').split(/,\s*/).map(normName).filter((t) => t.length >= 3 && !GENERIC.has(t));
  const titleHit = (name) => { const n = normName(name); return !GENERIC.has(n) && titleTerms.some((t) => namesMatch(n, t)); };
  const places = [
    ['<appdata>', ''], ['<localappdata>', ''], ['<locallow>', ''],
    ['<documents>', ''], ['<documents>', 'My Games'], ['<savedgames>', ''],
  ];
  for (const [token, sub] of places) {
    if (!roots[token]) continue;
    const base = sub ? path.join(roots[token], sub) : roots[token];
    const prefix = sub ? `${token}/${sub}` : token;
    for (const e of await listNames(base)) {
      if (!e.isDirectory() || SKIP_VENDOR.has(e.name.toLowerCase())) continue;
      const isDev = devTerms.some((t) => namesMatch(normName(e.name), t));
      if (titleHit(e.name)) {
        push({ path: `${prefix}/${e.name}`, reason: 'Named after the game', score: 5 });
        continue;
      }
      const kids = (await listNames(path.join(base, e.name))).filter((k) => k.isDirectory());
      const hit = kids.filter((k) => titleHit(k.name));
      for (const k of hit) {
        push({ path: `${prefix}/${e.name}/${k.name}`, reason: isDev ? 'In the developer\'s folder, named after the game' : 'Named after the game', score: isDev ? 6 : 5 });
      }
      if (isDev && !hit.length && kids.length === 1) {
        push({ path: `${prefix}/${e.name}/${kids[0].name}`, reason: 'Only folder in the developer\'s folder', score: 3 });
      }
    }
  }

  // Resolve and count files so the user can see which suggestions are real.
  for (const c of out) {
    try {
      c.abs = expand(c.path, { roots, gameDir: installDir, platform });
      c.exists = await fsu.isDir(c.abs);
      c.fileCount = c.exists ? (await fsu.walk(c.abs, { filter: fsu.makeMatcher(c.include, []), maxDepth: 6 })).length : 0;
    } catch {
      c.abs = null; c.exists = false; c.fileCount = 0;
    }
    if (c.exists && c.fileCount > 0) c.score += 3;
    else if (c.exists) c.score += 1;
    delete c.key;
  }
  // A folder found by name must never be the game's own folder (or contain it, or sit inside it):
  // e.g. a game installed under Documents/Games/<title> matches its own title.
  if (installDir) {
    const { relativeInside } = require('./paths');
    for (let i = out.length - 1; i >= 0; i--) {
      const c = out[i];
      if (c.path.startsWith('<game>') || !c.abs) continue;
      if (relativeInside(installDir, c.abs, platform) !== null || relativeInside(c.abs, installDir, platform) !== null) out.splice(i, 1);
    }
  }
  out.sort((a, b) => b.score - a.score);
  return { engine: engineName, engineFromVndb: engineHint, candidates: out };
}

module.exports = { suggest, detectEngine, engineFromVndb, ENGINES, normName, namesMatch };
