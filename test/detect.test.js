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
    const r = await suggest({ title: 'Some Game', exe: 'game.exe' }, dir, { roots: rootsFor(home), platform: 'linux' });
    assert.strictEqual(r.engine, engine);
    assert.strictEqual(r.candidates[0].path, expected);
  });
}

test("Ren'Py reads save_directory from options.rpy", async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'renpy', 'x.py'));
  touch(path.join(dir, 'game', 'options.rpy'), 'define config.save_directory = "MyVN-1234"\n');
  const r = await suggest({ title: 'My VN' }, dir, { roots: rootsFor(home), platform: 'linux' });
  assert.ok(r.candidates.some((c) => c.path === '<appdata>/RenPy/MyVN-1234'));
});

test('Unity reads company/product from app.info', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'manosaba_Data', 'app.info'), 'Re,AER\nmanosaba\n');
  touch(path.join(home, 'LocalLow', 'Re,AER', 'manosaba', 'Saves_v1', 'a.sav'), 'x');
  const r = await suggest({ title: 'manosaba' }, dir, { roots: rootsFor(home), platform: 'linux' });
  assert.strictEqual(r.candidates[0].path, '<locallow>/Re,AER/manosaba');
  assert.strictEqual(r.candidates[0].fileCount, 1);
});

test('VX Ace uses include patterns in the game folder', async () => {
  const home = tmp();
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'Game.rgss3a'));
  touch(path.join(dir, 'Save01.rvdata2'));
  const r = await suggest({ title: 'x' }, dir, { roots: rootsFor(home), platform: 'linux' });
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
    { roots: rootsFor(home), platform: 'linux' });
  assert.strictEqual(r.candidates[0].path, '<appdata>/Nitroplus/Muramasa');
  assert.ok(!r.candidates.some((c) => c.path.includes('Hanachirasu')));
});

test('save-once: finds the AppData folder written during play and ignores noise', async () => {
  const home = tmp();
  const roots = rootsFor(home);
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'muramasa.exe'));
  touch(path.join(home, 'Roaming', 'Nitroplus', 'Muramasa', '1.00', 'old.dat'));
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  touch(path.join(home, 'Roaming', 'Nitroplus', 'Muramasa', '1.00', 'save003.dat'), 'x');
  touch(path.join(home, 'Roaming', 'discord', 'Cache', 'data_1'), 'noise');
  touch(path.join(home, 'Local', 'Google', 'Chrome', 'x'), 'noise');
  touch(path.join(home, 'Local', 'SomeTool', 'state.json'), 'noise');
  touch(path.join(home, 'Roaming', 'loose.txt'), 'noise');
  const changed = await snapshot.changedSince(roots, dir, since);
  const ranked = snapshot.rank(changed, { game: { title: 'Muramasa', exe: 'muramasa.exe' }, roots, gameDir: dir, platform: 'linux' });
  assert.strictEqual(ranked[0].path, '<appdata>/Nitroplus/Muramasa');
  assert.ok(!ranked.some((c) => /discord|Google|loose/.test(c.path)));
});

test('save-once: loose save files in the game folder become an include list', async () => {
  const home = tmp();
  const roots = rootsFor(home);
  const dir = path.join(home, 'g');
  touch(path.join(dir, 'game.exe'));
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  touch(path.join(dir, 'save1.dat'), 'x');
  touch(path.join(dir, 'gloval.sav'), 'x');
  const ranked = snapshot.rank(await snapshot.changedSince(roots, dir, since),
    { game: { title: 'g' }, roots, gameDir: dir, platform: 'linux' });
  assert.strictEqual(ranked[0].path, '<game>');
  assert.deepStrictEqual(ranked[0].include.sort(), ['gloval.sav', 'save1.dat']);
});
