'use strict';
// Suggest save locations for a game without running it:
//   1. recognise the engine from its files and use that engine's usual save folder
//   2. look for folders called save/savedata/UserData inside the game folder
//   3. look in AppData / Documents / Saved Games for folders named after the game,
//      its .exe or its developer
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

const SAVE_DIR_NAMES = new Set(['save', 'saves', 'savedata', 'save_data', 'savedat', 'userdata', 'sav']);

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
async function context(dir) {
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
    hasFile: (n) => files.has(n.toLowerCase()),
    hasDir: (n) => dirs.has(n.toLowerCase()),
    hasExt: (x) => exts.has(x.toLowerCase()),
    exists: (rel) => !!existsCache[rel],
    dataDir: dataDir ? dataDir.name : null,
  };
}

async function detectEngine(dir) {
  const c = await context(dir);
  for (const e of ENGINES) if (e.match(c)) return { engine: e, ctx: c };
  return null;
}

/**
 * @returns {Promise<{engine: string|null, candidates: Array<{path, include, reason, abs, exists, fileCount, score}>}>}
 */
async function suggest(game, installDir, { roots, platform = process.platform }) {
  const out = [];
  const push = (cand) => {
    const key = `${cand.path}|${(cand.include || []).join(',')}`;
    const prev = out.find((o) => o.key === key);
    if (prev) { prev.score = Math.max(prev.score, cand.score); return; }
    out.push({ include: [], ...cand, key });
  };

  // 1. Engine
  let engineName = null;
  if (installDir && (await fsu.isDir(installDir))) {
    const found = await detectEngine(installDir);
    if (found) {
      engineName = found.engine.name;
      for (const s of await found.engine.saves(found.ctx)) {
        push({ ...s, reason: `${found.engine.name} games usually save here`, score: 6 });
      }
    }

    // 2. save-ish folders inside the game folder
    const all = [];
    await (async function rec(abs, rel, depth) {
      for (const e of await listNames(abs)) {
        if (!e.isDirectory()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (SAVE_DIR_NAMES.has(e.name.toLowerCase())) all.push(r);
        if (depth < 3) await rec(path.join(abs, e.name), r, depth + 1);
      }
    })(installDir, '', 1);
    for (const r of all) push({ path: `<game>/${r}`, reason: 'Folder named like a save folder', score: 4 });
  }

  // 3. Folders named after the game elsewhere
  const exeBase = game.exe ? path.basename(game.exe).replace(/\.[^.]+$/, '') : '';
  const titleTerms = [game.title, game.titleAlt, exeBase, installDir ? path.basename(installDir) : '']
    .map(normName).filter((t) => t.length >= 3);
  const devTerms = [game.developer].map(normName).filter((t) => t.length >= 3);
  const places = [
    ['<appdata>', ''], ['<localappdata>', ''], ['<locallow>', ''],
    ['<documents>', ''], ['<documents>', 'My Games'], ['<savedgames>', ''],
  ];
  for (const [token, sub] of places) {
    if (!roots[token]) continue;
    const base = sub ? path.join(roots[token], sub) : roots[token];
    const prefix = sub ? `${token}/${sub}` : token;
    for (const e of await listNames(base)) {
      if (!e.isDirectory()) continue;
      const n = normName(e.name);
      if (titleTerms.some((t) => namesMatch(n, t))) {
        push({ path: `${prefix}/${e.name}`, reason: 'Named after the game', score: 5 });
      } else if (devTerms.some((t) => namesMatch(n, t))) {
        // A developer folder usually holds one subfolder per game: pick the one named after this game.
        const kids = (await listNames(path.join(base, e.name))).filter((k) => k.isDirectory());
        const hit = kids.filter((k) => titleTerms.some((t) => namesMatch(normName(k.name), t)));
        for (const k of hit) push({ path: `${prefix}/${e.name}/${k.name}`, reason: 'In the developer\'s folder, named after the game', score: 5 });
        if (!hit.length && kids.length === 1) {
          push({ path: `${prefix}/${e.name}/${kids[0].name}`, reason: 'Only folder in the developer\'s folder', score: 3 });
        }
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
  out.sort((a, b) => b.score - a.score);
  return { engine: engineName, candidates: out };
}

module.exports = { suggest, detectEngine, ENGINES, normName, namesMatch };
