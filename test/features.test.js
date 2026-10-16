'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createZip, readZip } = require('../src/core/zip');
const savesio = require('../src/core/savesio');
const importer = require('../src/core/importer');
const vndb = require('../src/core/vndb');
const updater = require('../src/core/updater');
const tools = require('../src/core/tools');
const { SyncEngine } = require('../src/core/sync');
const { Library } = require('../src/core/library');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vns-f-')); }
function write(p, s = '') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }

// ------------------------------------------------------------------ zip

test('zip: round trip keeps names (incl. Japanese), contents and compresses', () => {
  const big = Buffer.alloc(50000, 'a');
  const z = createZip([{ name: 'saves/r1/セーブ01.dat', data: Buffer.from('progress') }, { name: 'big.bin', data: big }]);
  assert.ok(z.length < 2000, 'repetitive data is deflated');
  const out = readZip(z);
  assert.deepStrictEqual(out.map((e) => e.name), ['saves/r1/セーブ01.dat', 'big.bin']);
  assert.strictEqual(out[0].data.toString(), 'progress');
  assert.ok(out[1].data.equals(big));
});

test('zip: other tools can read it', { skip: !fs.existsSync('/usr/bin/python3') }, () => {
  const dir = tmp();
  const f = path.join(dir, 'x.zip');
  fs.writeFileSync(f, createZip([{ name: 'a/セーブ.dat', data: Buffer.from('hello') }]));
  const r = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), z.read(z.namelist()[0]).decode(), z.namelist()[0])', f]).toString().trim();
  assert.strictEqual(r, 'None hello a/セーブ.dat');
});

test('zip: damaged data is refused', () => {
  const z = createZip([{ name: 'a.dat', data: Buffer.from('some save data here') }]);
  z[40] ^= 0xff;
  assert.throws(() => readZip(z));
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /Not a zip/);
});

// ------------------------------------------------------------------ save export / import

async function twoPcs() {
  const base = tmp();
  const cloud = path.join(base, 'cloud');
  fs.mkdirSync(cloud);
  const lib = new Library(cloud);
  let game = await lib.create({ title: 'Muramasa' });
  game = await lib.addSaveRule(game.id, { path: '<appdata>/Nitroplus/Muramasa' });
  const pc = (name) => {
    const roots = { '<appdata>': path.join(base, name, 'appdata'), '<home>': path.join(base, name) };
    return { roots, install: path.join(base, name, 'game'), dir: path.join(roots['<appdata>'], 'Nitroplus', 'Muramasa'),
      engine: new SyncEngine({ cloudDir: cloud, deviceId: `${name}-0000-id`, deviceName: name, roots }) };
  };
  return { lib, game, a: pc('Desktop'), b: pc('Laptop') };
}

test('saves: export on one PC, import on another; current saves are backed up first', async () => {
  const { game, a, b } = await twoPcs();
  write(path.join(a.dir, 'save01.dat'), 'desktop progress');
  write(path.join(a.dir, 'sub', 'system.dat'), 'cfg');
  const { zip, files } = await savesio.exportSaves(a.engine, game, a.install);
  assert.strictEqual(files, 2);

  write(path.join(b.dir, 'save01.dat'), 'laptop progress');
  write(path.join(b.dir, 'stale.dat'), 'old');
  const r = await savesio.importSaves(b.engine, game, b.install, zip);
  assert.strictEqual(r.files, 2);
  assert.strictEqual(fs.readFileSync(path.join(b.dir, 'save01.dat'), 'utf8'), 'desktop progress');
  assert.strictEqual(fs.readFileSync(path.join(b.dir, 'sub', 'system.dat'), 'utf8'), 'cfg');
  assert.ok(!fs.existsSync(path.join(b.dir, 'stale.dat')), 'import makes the folder match the export');
  const hist = await b.engine.listHistory(game.id);
  assert.ok(hist.some((h) => h.kind === 'before-import' && h.files === 2), 'laptop saves were backed up');
});

test('saves: rules are matched by path when ids differ; unrelated zips are refused', async () => {
  const { lib, game, a, b } = await twoPcs();
  write(path.join(a.dir, 'save01.dat'), 'x');
  const { zip } = await savesio.exportSaves(a.engine, game, a.install);
  // Same game re-added elsewhere: same save path, new rule id.
  let other = await lib.create({ title: 'Muramasa again' });
  other = await lib.addSaveRule(other.id, { path: '<appdata>/Nitroplus/Muramasa' });
  const r = await savesio.importSaves(b.engine, other, b.install, zip);
  assert.strictEqual(r.files, 1);
  let unrelated = await lib.create({ title: 'Other' });
  unrelated = await lib.addSaveRule(unrelated.id, { path: '<appdata>/Other' });
  await assert.rejects(() => savesio.importSaves(b.engine, unrelated, b.install, zip), (e) => e.code === 'no-match');
  await assert.rejects(() => savesio.importSaves(b.engine, unrelated, b.install, createZip([{ name: 'x', data: Buffer.from('1') }])), (e) => e.code === 'not-export');
});

// ------------------------------------------------------------------ bulk import

test('import: finds game folders and their main .exe, skipping installers and cracks', async () => {
  const root = tmp();
  const mk = (rel, size = 10) => write(path.join(root, rel), Buffer.alloc(size));
  mk('AlphaROMdiE.exe', 100); mk('Cracker.exe', 100); // top-level tools are not games
  mk('light/Dies Irae/malie.exe', 4e6); mk('light/Dies Irae/MalieCfg.exe', 1e5); mk('light/Dies Irae/data/x.dat');
  mk('Setoguchi/[S.M.L] CARNIVAL v1.02/carnival.exe', 2e6); mk('Setoguchi/[S.M.L] CARNIVAL v1.02/carnival_patch.exe', 3e6);
  mk('Unity Game/Bst.exe', 7e5); mk('Unity Game/UnityCrashHandler64.exe', 1e6); fs.mkdirSync(path.join(root, 'Unity Game', 'Bst_Data'));
  mk('Installers/setup.exe', 5e6); mk('Installers/Real Game/game.exe', 1e6);
  mk('Manual Only/readme.txt');
  const found = await importer.scan(root);
  const by = Object.fromEntries(found.map((f) => [path.relative(root, f.dir).replace(/\\/g, '/'), path.basename(f.exe)]));
  assert.deepStrictEqual(by, {
    'Installers/Real Game': 'game.exe',
    'Setoguchi/[S.M.L] CARNIVAL v1.02': 'carnival.exe',
    'Unity Game': 'Bst.exe',
    'light/Dies Irae': 'malie.exe',
  });
  assert.strictEqual(found.find((f) => f.dir.includes('CARNIVAL')).title, 'CARNIVAL');
});

test('import: title cleanup', () => {
  assert.strictEqual(importer.cleanTitle('[light] 神咒神威神楽'), '神咒神威神楽');
  assert.strictEqual(importer.cleanTitle('DemonsRoots1.2.1'), 'DemonsRoots');
  assert.strictEqual(importer.cleanTitle('Some_Game_v1.05'), 'Some Game');
  assert.strictEqual(importer.cleanTitle('新説魔法少女+v115'), '新説魔法少女');
  assert.strictEqual(importer.cleanTitle('サクラノ詩 DL版'), 'サクラノ詩');
  assert.strictEqual(importer.cleanTitle('DL版 素晴らしき日々'), '素晴らしき日々');
  assert.strictEqual(importer.cleanTitle('SWAN SONG HD'), 'SWAN SONG');
  assert.strictEqual(importer.cleanTitle('Title HD 初回限定版'), 'Title');
  assert.strictEqual(importer.cleanTitle('HD'), 'HD', 'never empties a title');
  assert.strictEqual(importer.cleanTitle('Hardcore Game'), 'Hardcore Game');
  const { SHARED_EXE } = require('../src/core/detect');
  assert.ok(['BGI.exe', 'SiglusEngine.exe', 'RealLive.exe', 'AdvHD.exe', 'game.exe', 'Start.exe'].every((x) => SHARED_EXE.test(x)), 'engine exes are shared');
  assert.ok(!SHARED_EXE.test('kkk.exe') && !SHARED_EXE.test('swansong.exe'), 'a game\'s own exe is not');
  assert.strictEqual(importer.cleanTitle('Fate Stay Night'), 'Fate Stay Night');
  // Real folder names from a test library
  assert.strictEqual(importer.cleanTitle('Dai Sengoku Rance MG_2025_08_29(1)'), 'Dai Sengoku Rance MG');
  assert.strictEqual(importer.cleanTitle('justinlamsadventure_win'), 'justinlamsadventure');
  assert.strictEqual(importer.cleanTitle('BLACK SHEEP TOWN_eng'), 'BLACK SHEEP TOWN');
  assert.strictEqual(importer.cleanTitle('月姫 - Copy'), '月姫');
  assert.strictEqual(importer.cleanTitle('manosaba_game'), 'manosaba');
  assert.strictEqual(importer.cleanTitle('Game'), 'Game');
  assert.strictEqual(importer.cleanTitle('Muv-Luv Tactics'), 'Muv-Luv Tactics');
});

// ------------------------------------------------------------------ VNDB

test('vndb: description markup becomes safe text segments', () => {
  const segs = vndb.parseDescription('Intro [url=/c123]Hero[/url] text [spoiler]twist[/spoiler] [url=javascript:alert(1)]bad[/url]\n[i]end[/i]');
  assert.deepStrictEqual(segs, [
    { text: 'Intro ' }, { text: 'Hero', href: 'https://vndb.org/c123' }, { text: ' text ' },
    { text: 'twist', spoiler: true }, { text: ' ' }, { text: 'bad' }, { text: '\n' }, { text: 'end' },
  ]);
});

test('vndb: info keeps meaningful tags, drops lies and weak ones', () => {
  const i = vndb.info({ id: 'v1', length: 4, length_minutes: 2400, rating: 85.3, votecount: 900, languages: ['ja'],
    tags: [{ id: 'g1', name: 'Strong', rating: 2.8, spoiler: 0 }, { id: 'g2', name: 'Weak', rating: 0.6, spoiler: 0 },
      { id: 'g3', name: 'Lie', rating: 2.5, lie: true }, { id: 'g4', name: 'Twist', rating: 2, spoiler: 2 }] });
  assert.strictEqual(i.length, 'long');
  assert.deepStrictEqual(i.tags.map((t) => t.name), ['Strong', 'Twist']);
  assert.strictEqual(i.tags[1].spoiler, 2);
});

// ------------------------------------------------------------------ updates

test('updater: version order and picking the newest release with its exe', async () => {
  assert.ok(updater.compareVersions('0.2.10', '0.2.9') > 0);
  assert.ok(updater.compareVersions('1.0.0-beta.2', '1.0.0') < 0);
  const releases = [
    { tag_name: 'v0.3.0', draft: true, assets: [] },
    { tag_name: 'v0.2.2', prerelease: true, body: 'notes', html_url: 'u', assets: [{ name: 'VN-Shelf-0.2.2-portable.exe', browser_download_url: 'https://github.com/stagefuel/vn-shelf/releases/download/v0.2.2/VN-Shelf-0.2.2-portable.exe', size: 5, digest: 'sha256:ABC' }] },
    { tag_name: 'v0.2.1', assets: [] },
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => releases });
  const r = await updater.checkForUpdate('0.2.1', { fetchImpl });
  assert.strictEqual(r.version, '0.2.2');
  assert.strictEqual(r.asset.sha256, 'abc');
  assert.strictEqual(await updater.checkForUpdate('0.2.2', { fetchImpl }), null);
  assert.strictEqual(await updater.checkForUpdate('0.2.1', { fetchImpl, includePrerelease: false }), null);
});

test('updater: download is checked against size and SHA-256, and only from GitHub releases', async () => {
  const dir = tmp();
  const data = Buffer.from('new exe contents');
  const sha = require('crypto').createHash('sha256').update(data).digest('hex');
  const url = 'https://github.com/stagefuel/vn-shelf/releases/download/v9/VN-Shelf-9-portable.exe';
  const fetchImpl = async () => ({ ok: true, body: (async function* () { yield data.subarray(0, 5); yield data.subarray(5); })() });
  const ok = await updater.download({ url, size: data.length, sha256: sha }, path.join(dir, 'new.exe'), { fetchImpl });
  assert.strictEqual(fs.readFileSync(ok.path, 'utf8'), 'new exe contents');
  await assert.rejects(() => updater.download({ url, size: data.length, sha256: 'f'.repeat(64) }, path.join(dir, 'bad.exe'), { fetchImpl }), /checksum/);
  assert.ok(!fs.existsSync(path.join(dir, 'bad.exe')) && !fs.existsSync(path.join(dir, 'bad.exe.part')));
  await assert.rejects(() => updater.download({ url: 'https://evil.example/x.exe', size: 1 }, path.join(dir, 'x.exe'), { fetchImpl }), /outside GitHub/);
});

// ------------------------------------------------------------------ companion tools

test('tools: placeholders are filled and quoted arguments kept together', () => {
  assert.deepStrictEqual(tools.expandArgs('--attach "{gameExe}" -t {title}', { gameExe: 'C:\\G\\a b.exe', title: 'X' }), ['--attach', 'C:\\G\\a b.exe', '-t', 'X']);
});

test('tools: started with the game and closed with it (only those set to close)', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const mark = (n) => path.join(dir, `${n}.pid`);
  const mk = (n) => { const p = path.join(dir, `${n}.sh`); fs.writeFileSync(p, `#!/bin/sh\necho $$ > "${mark(n)}"\nsleep 30\n`); fs.chmodSync(p, 0o755); return p; };
  const hs = tools.startTools([
    { id: 'a', name: 'hooker', path: mk('a'), args: '', closeWithGame: true },
    { id: 'b', name: 'keeps running', path: mk('b'), args: '', closeWithGame: false },
  ], { gameExe: '/g/x', gameDir: '/g', title: 't' });
  for (let i = 0; i < 50 && !(fs.existsSync(mark('a')) && fs.existsSync(mark('b'))); i++) await new Promise((r) => setTimeout(r, 100));
  const pidA = Number(fs.readFileSync(mark('a'), 'utf8'));
  const pidB = Number(fs.readFileSync(mark('b'), 'utf8'));
  await tools.stopTools(hs);
  await new Promise((r) => setTimeout(r, 300));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.strictEqual(alive(pidA), false, 'closeWithGame tool was stopped');
  assert.strictEqual(alive(pidB), true, 'other tool keeps running');
  process.kill(-hs[1].child.pid, 'SIGTERM');
});

test('updater: the swap script passes extra arguments to the new exe and is named after the first pid', async () => {
  const dir = tmp();
  const script = await updater.writeSwapScript({ currentExe: 'C:\\VN\\VN Shelf.exe', newExe: 'C:\\VN\\VN Shelf.exe.new', pids: [111, 222], dir, args: ['--hidden'] });
  assert.strictEqual(path.basename(script), 'vnshelf-update-111.cmd');
  assert.match(fs.readFileSync(script, 'utf8'), /start "" "%TARGET%" "--hidden"/);
  const plain = fs.readFileSync(await updater.writeSwapScript({ currentExe: 'a.exe', newExe: 'a.exe.new', pid: 5, dir }), 'utf8');
  assert.match(plain, /start "" "%TARGET%"\r\n/);
});

test('updater (Windows): the swap script outlives its launcher and replaces the exe after the old process exits', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const dir = tmp();
  const sys32 = path.join(process.env.SystemRoot, 'System32');
  const cur = path.join(dir, 'VN Shelf.exe');
  const nw = `${cur}.new`;
  fs.copyFileSync(path.join(sys32, 'whoami.exe'), cur);
  fs.copyFileSync(path.join(sys32, 'hostname.exe'), nw);
  const want = fs.readFileSync(nw);
  // Stand-in for the running VN Shelf: a process that exits after ~3 s.
  const stand = spawn(path.join(sys32, 'PING.EXE'), ['-n', '4', '127.0.0.1'], { stdio: 'ignore' });
  const script = await updater.writeSwapScript({ currentExe: cur, newExe: nw, pid: stand.pid, dir });
  updater.launchSwapScript(script);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!fs.readFileSync(cur).equals(want), 'not replaced while the old process still runs');
  for (let i = 0; i < 40 && fs.existsSync(nw); i++) await new Promise((r) => setTimeout(r, 500));
  assert.ok(fs.readFileSync(cur).equals(want), 'replaced after it exits');
  const log = fs.readFileSync(script.replace(/\.cmd$/, '.log'), 'utf8');
  assert.match(log, /closed, replacing the program/);
});

test('updater: the updated exe gets the new version in its name', () => {
  const dir = path.join(path.sep, 'apps');
  assert.strictEqual(updater.updatedExePath(path.join(dir, 'VN-Shelf-0.4.0-portable.exe'), '0.4.0', '0.4.1'), path.join(dir, 'VN-Shelf-0.4.1-portable.exe'));
  // A renamed copy without the version in its name keeps its name.
  assert.strictEqual(updater.updatedExePath(path.join(dir, 'VN Shelf.exe'), '0.4.0', '0.4.1'), path.join(dir, 'VN Shelf.exe'));
});

test('updater (Windows): the swap script saves the update under the new name and removes the old exe', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const dir = tmp();
  const sys32 = path.join(process.env.SystemRoot, 'System32');
  const cur = path.join(dir, 'VN-Shelf-0.4.0-portable.exe');
  const target = updater.updatedExePath(cur, '0.4.0', '0.4.1');
  const nw = `${cur}.new`;
  fs.copyFileSync(path.join(sys32, 'whoami.exe'), cur);
  fs.copyFileSync(path.join(sys32, 'hostname.exe'), nw);
  const want = fs.readFileSync(nw);
  // Two stand-ins: VN Shelf itself and the portable launcher, which exits a little later.
  const app = spawn(path.join(sys32, 'PING.EXE'), ['-n', '2', '127.0.0.1'], { stdio: 'ignore' });
  const launcher = spawn(path.join(sys32, 'PING.EXE'), ['-n', '4', '127.0.0.1'], { stdio: 'ignore' });
  const script = await updater.writeSwapScript({ currentExe: cur, newExe: nw, targetExe: target, pids: [app.pid, launcher.pid], dir });
  updater.launchSwapScript(script);
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(!fs.existsSync(target), 'nothing moved while the launcher still runs');
  for (let i = 0; i < 40 && (fs.existsSync(nw) || fs.existsSync(cur)); i++) await new Promise((r) => setTimeout(r, 500));
  assert.ok(fs.readFileSync(target).equals(want), 'new version saved under the new name');
  assert.ok(!fs.existsSync(cur), 'old version removed');
});

test('settings: many saves at the same moment never collide', async () => {
  const fsu = require('../src/core/fsutil');
  const f = path.join(tmp(), 'config.json');
  await Promise.all(Array.from({ length: 40 }, (_, i) => fsu.writeJson(f, { n: i })));
  assert.ok(typeof JSON.parse(fs.readFileSync(f, 'utf8')).n === 'number');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)).filter((x) => x.endsWith('.tmp')), []);
});

// ------------------------------------------------------------------ VNDB extras

test('vndb extras: Japanese screenshots first, English only when there are none, nothing otherwise', () => {
  const shot = (n, ...langs) => ({ url: `u${n}`, thumbnail: `t${n}`, release: { languages: langs.map((lang) => ({ lang })) } });
  assert.deepStrictEqual(vndb.pickScreenshots([shot(1, 'en'), shot(2, 'ru'), shot(3, 'ja'), shot(4, 'ja', 'en')]).map((x) => x.url), ['u3', 'u4']);
  assert.deepStrictEqual(vndb.pickScreenshots([shot(1, 'en'), shot(2, 'ru'), shot(3, 'en')]).map((x) => x.url), ['u1', 'u3']);
  assert.deepStrictEqual(vndb.pickScreenshots([shot(1, 'ru'), shot(2, 'zh-Hans')]), []);
  assert.deepStrictEqual(vndb.pickScreenshots(undefined), []);
});

test('vndb extras: staff merged per person, relations ordered, characters by role with spoilers kept apart', async () => {
  const { FakeVndb } = require('./helpers/fake-vndb');
  const fake = new FakeVndb();
  fake.extras.set('v5', {
    screenshots: [{ url: 'a', thumbnail: 'ta', release: { languages: [{ lang: 'en' }] } }],
    relations: [{ id: 'v9', relation: 'ser', relation_official: true, title: 'Series' }, { id: 'v8', relation: 'seq', relation_official: true, title: 'Sequel' }, { id: 'v7', relation: 'preq', relation_official: false, title: 'Before' }],
    staff: [{ id: 's1', name: 'A', original: 'エー', role: 'director', note: null }, { id: 's1', name: 'A', original: 'エー', role: 'scenario', note: 'route 1' }, { id: 's2', name: 'B', role: 'music' }],
    developers: [{ id: 'p1', name: 'Brand' }],
  });
  fake.characters.set('v5', [
    { id: 'c1', name: 'Side', vns: [{ id: 'v5', role: 'side', spoiler: 0 }], traits: [] },
    { id: 'c2', name: 'Hero', vns: [{ id: 'v5', role: 'main', spoiler: 0 }], traits: [{ id: 'i1', name: 'Brown', group_name: 'Hair', spoiler: 0 }] },
    { id: 'c3', name: 'Secret', vns: [{ id: 'v5', role: 'primary', spoiler: 2 }], traits: [] },
  ]);
  process.env.VNS_VNDB_API = 'http://fake/kana';
  try {
    const x = await vndb.fetchExtras('v5', { fetchImpl: fake.fetch });
    assert.deepStrictEqual(x.screenshots.map((s) => s.url), ['a'], 'English when there is no Japanese set');
    assert.deepStrictEqual(x.relations.map((r) => r.relation), ['preq', 'seq', 'ser']);
    assert.strictEqual(x.relations[0].official, false);
    assert.deepStrictEqual(x.staff[0], { id: 's1', name: 'A', original: 'エー', roles: ['director', 'scenario'], notes: ['route 1'] });
    assert.strictEqual(x.developers[0].id, 'p1');
    const c = await vndb.fetchCharacters('v5', { fetchImpl: fake.fetch });
    assert.deepStrictEqual(c.map((y) => `${y.name}/${y.role}/${y.spoiler}`), ['Hero/main/0', 'Secret/primary/2', 'Side/side/0']);
    assert.deepStrictEqual(c[0].traits, [{ id: 'i1', name: 'Brown', group: 'Hair', spoiler: 0 }]);
  } finally { delete process.env.VNS_VNDB_API; }
});
