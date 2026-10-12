'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { suggest } = require('../src/core/detect');
const snapshot = require('../src/core/snapshot');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vns-d-')); }
function touch(p, s = '') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function rootsFor(home) {
  return { '<appdata>': path.join(home, 'Roaming'), '<localappdata>': path.join(home, 'Local'),
    '<locallow>': path.join(home, 'LocalLow'), '<documents>': path.join(home, 'Documents'), '<home>': home };
}

const fixtures = [
  ['KiriKiri', ['data.xp3', 'game.exe'], '<game>/savedata'],
  ['SiglusEngine', ['Scene.pck', 'SiglusEngine.exe'], '<game>/savedata'],
  ['BGI / Ethornell', ['BGI.exe', 'sysprg.arc'], '<game>/UserData'],
  ['AliceSoft System 4', ['Rance.ain', 'System40.exe'], '<game>/SaveData'],
  ['Artemis', ['root.pfs', 'game.exe'], '<game>/save'],
  ['YU-RIS', ['bn.ypf', 'game.exe'], '<game>/savedata'],
  ['RPG Maker MZ', ['js/rmmz_core.js', 'Game.exe'], '<game>/save'],
  ['RPG Maker MV', ['www/js/rpg_core.js', 'Game.exe'], '<game>/www/save'],
];

for (const [engine, files, expected] of fixtures) {
  test(`detects ${engine}`, async () => {
    const home = tmp();
    const dir = path.join(home, 'game');
    for (const f of files) touch(path.join(dir, f));
    const r = await suggest({ title: 'Some Game', exe: 'game.exe' }, dir, { roots: rootsFor(home), platform: process.platform });
    assert.strictEqual(r.engine, engine);
    assert.strictEqual(r.candidates[0].path, expected);
  });
}

test("Ren'Py reads save_directory from options.rpy", async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'renpy', 'x.py'));
  touch(path.join(dir, 'game', 'options.rpy'), 'define config.save_directory = "MyVN-1234"\n');
  const r = await suggest({ title: 'My VN' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.ok(r.candidates.some((c) => c.path === '<appdata>/RenPy/MyVN-1234'));
});

test('Unity reads company/product from app.info', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'manosaba_Data', 'app.info'), 'Re,AER\nmanosaba\n');
  touch(path.join(home, 'LocalLow', 'Re,AER', 'manosaba', 'Saves_v1', 'a.sav'), 'x');
  const r = await suggest({ title: 'manosaba' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.strictEqual(r.candidates[0].path, '<locallow>/Re,AER/manosaba');
  assert.strictEqual(r.candidates[0].fileCount, 1);
});

test('VX Ace uses include patterns in the game folder', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'Game.rgss3a'));
  touch(path.join(dir, 'Save01.rvdata2'));
  const r = await suggest({ title: 'x' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.deepStrictEqual(r.candidates[0].include, ['Save*.rvdata2', 'Save*.rvdata', 'Save*.rxdata']);
  assert.strictEqual(r.candidates[0].fileCount, 1);
});

test('finds the game folder inside the developer folder in AppData', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'muramasa.exe'));
  touch(path.join(home, 'Roaming', 'Nitroplus', 'Muramasa', '1.00', 'save.dat'), 'x');
  touch(path.join(home, 'Roaming', 'Nitroplus', 'Hanachirasu', 'version1.00', 'save.dat'), 'x');
  const r = await suggest({ title: '装甲悪鬼村正', developer: 'Nitroplus', exe: 'muramasa.exe' }, dir,
    { roots: rootsFor(home), platform: process.platform });
  assert.strictEqual(r.candidates[0].path, '<appdata>/Nitroplus/Muramasa');
  assert.ok(!r.candidates.some((c) => c.path.includes('Hanachirasu')));
});

test('save-once: finds the AppData folder written during play and ignores noise', async () => {
  const home = tmp();
  const roots = rootsFor(home);
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'muramasa.exe'));
  touch(path.join(home, 'Roaming', 'Nitroplus', 'Muramasa', '1.00', 'old.dat'));
  await new Promise((r) => setTimeout(r, 100));
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 1100));
  touch(path.join(home, 'Roaming', 'Nitroplus', 'Muramasa', '1.00', 'save003.dat'), 'x');
  touch(path.join(home, 'Roaming', 'discord', 'Cache', 'data_1'), 'noise');
  touch(path.join(home, 'Local', 'Google', 'Chrome', 'x'), 'noise');
  touch(path.join(home, 'Local', 'SomeTool', 'state.json'), 'noise');
  touch(path.join(home, 'Roaming', 'loose.txt'), 'noise');
  const changed = await snapshot.changedSince(roots, dir, since);
  const ranked = snapshot.rank(changed, { game: { title: 'Muramasa', exe: 'muramasa.exe' }, roots, gameDir: dir, platform: process.platform });
  assert.strictEqual(ranked[0].path, '<appdata>/Nitroplus/Muramasa');
  assert.ok(!ranked.some((c) => /discord|Google|loose/.test(c.path)));
});

test('save-once: loose save files in the game folder become an include list', async () => {
  const home = tmp();
  const roots = rootsFor(home);
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'game.exe'));
  await new Promise((r) => setTimeout(r, 100)); // file clocks can run a few ms ahead of Date.now()
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 1100));
  touch(path.join(dir, 'save1.dat'), 'x');
  touch(path.join(dir, 'gloval.sav'), 'x');
  const ranked = snapshot.rank(await snapshot.changedSince(roots, dir, since),
    { game: { title: 'g' }, roots, gameDir: dir, platform: process.platform });
  assert.strictEqual(ranked[0].path, '<game>');
  assert.deepStrictEqual(ranked[0].include.sort(), ['gloval.sav', 'save1.dat']);
});

// ---- cases taken from real installs
test('rUGP (age): finds Documents/age/<name> by its .rio.ici marker', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'rugp.exe'));
  touch(path.join(dir, '君望LE.rio'));
  touch(path.join(home, 'Documents', 'age', '君が望む永遠LE', '君望LE.rio.ici'));
  touch(path.join(home, 'Documents', 'age', '君が望む永遠LE', 'Vmreg', 'gdb.uuc'));
  touch(path.join(home, 'Documents', 'Default rUGP App', 'Vmreg', 'gdb.uuc'));
  const r = await suggest({ title: 'x', exe: 'rugp.exe' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.strictEqual(r.engine, 'rUGP');
  assert.strictEqual(r.candidates[0].path, '<documents>/age/君が望む永遠LE');
  assert.ok(!r.candidates.some((c) => c.path.includes('Default rUGP App')), 'generic rugp.exe name must not match');
});

test('generic Game.exe does not match another game\'s folder', async () => {
  const home = tmp();
  const dir = path.join(home, 'BLACK SOULS');
  touch(path.join(dir, 'Game.exe'));
  touch(path.join(home, 'Roaming', 'tyranogame', 'Local Storage', 'x'));
  const r = await suggest({ title: 'BLACK SOULS', exe: 'Game.exe' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.ok(!r.candidates.some((c) => c.path.includes('tyranogame')));
});

test('title found one level inside a developer folder, even without knowing the developer', async () => {
  const home = tmp();
  const dir = path.join(home, 'サクラノ刻 ―櫻の森の下を歩む― 通常版');
  touch(path.join(dir, 'sakuranotoki.exe'));
  touch(path.join(dir, 'root.pfs'));
  touch(path.join(home, 'Roaming', '枕', 'サクラノ刻', 'save0001.dat'));
  const r = await suggest({ title: 'サクラノ刻 ―櫻の森の下を歩む― 通常版', exe: 'sakuranotoki.exe' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.strictEqual(r.candidates[0].path, '<appdata>/枕/サクラノ刻');
});

test('folders like faterealtanua_savedata and Vmreg count as save folders; loose *.save files too', async () => {
  const home = tmp();
  const a = path.join(home, 'fsn');
  touch(path.join(a, 'faterealtanua_savedata', 'x.ksd'));
  touch(path.join(a, 'Fate.exe'));
  const ra = await suggest({ title: 'Fate', exe: 'Fate.exe' }, a, { roots: rootsFor(home), platform: process.platform });
  assert.ok(ra.candidates.some((c) => c.path === '<game>/faterealtanua_savedata' && c.fileCount === 1));
  const b = path.join(home, 'uta');
  touch(path.join(b, 'utaware-dvd.exe'));
  touch(path.join(b, 'slot01.save'));
  const rb = await suggest({ title: 'うたわれるもの', exe: 'utaware-dvd.exe' }, b, { roots: rootsFor(home), platform: process.platform });
  assert.ok(rb.candidates.some((c) => c.path === '<game>' && c.include.includes('*.save')));
});

test('RPG Maker 2000/2003 saves are Save*.lsd in the game folder', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'RPG_RT.exe'));
  touch(path.join(dir, 'RPG_RT.ldb'));
  touch(path.join(dir, 'Save01.lsd'));
  const r = await suggest({ title: 'kaze' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.strictEqual(r.engine, 'RPG Maker 2000/2003');
  assert.deepStrictEqual(r.candidates[0].include, ['Save*.lsd']);
  assert.strictEqual(r.candidates[0].fileCount, 1);
});

test('never suggests the game\'s own folder when it is installed under Documents', async () => {
  const home = tmp();
  const dir = path.join(home, 'Documents', 'Games', '神咒神威神楽');
  touch(path.join(dir, 'data.xp3'));
  touch(path.join(dir, 'kkk.exe'));
  const r = await suggest({ title: '神咒神威神楽', exe: 'kkk.exe' }, dir, { roots: rootsFor(home), platform: process.platform });
  assert.ok(!r.candidates.some((c) => !c.path.startsWith('<game>') && c.path.includes('神咒神威神楽')), JSON.stringify(r.candidates.map((c) => c.path)));
  assert.strictEqual(r.candidates[0].path, '<game>/savedata');
});
