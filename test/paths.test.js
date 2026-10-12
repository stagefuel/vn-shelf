'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tokenize, expand, defaultRoots } = require('../src/core/paths');

const winRoots = defaultRoots({
  platform: 'win32', home: 'C:\\Users\\Alice',
  env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
  documents: 'C:\\Users\\Alice\\OneDrive\\Documents',
});
const laptopRoots = defaultRoots({
  platform: 'win32', home: 'D:\\Users\\bob',
  env: { APPDATA: 'D:\\Users\\bob\\AppData\\Roaming', LOCALAPPDATA: 'D:\\Users\\bob\\AppData\\Local' },
});

test('AppData path becomes a token and maps to the other PC', () => {
  const t = tokenize('C:\\Users\\Alice\\AppData\\Roaming\\Nitroplus\\Muramasa\\1.00', { roots: winRoots, platform: 'win32' });
  assert.deepStrictEqual(t, { path: '<appdata>/Nitroplus/Muramasa/1.00', portable: true });
  assert.strictEqual(expand(t.path, { roots: laptopRoots, platform: 'win32' }), 'D:\\Users\\bob\\AppData\\Roaming\\Nitroplus\\Muramasa\\1.00');
});

test('LocalLow beats Local, case-insensitive on Windows', () => {
  const t = tokenize('c:\\users\\alice\\appdata\\locallow\\Re,AER\\manosaba', { roots: winRoots, platform: 'win32' });
  assert.strictEqual(t.path, '<locallow>/Re,AER/manosaba');
});

test('game folder wins over Documents when the game is installed inside Documents', () => {
  const gameDir = 'C:\\Users\\Alice\\OneDrive\\Documents\\Games\\Sakuuta';
  const t = tokenize(gameDir + '\\savedata', { roots: winRoots, gameDir, platform: 'win32' });
  assert.strictEqual(t.path, '<game>/savedata');
  assert.strictEqual(expand('<game>/savedata', { roots: laptopRoots, gameDir: 'E:\\VN\\Sakuuta', platform: 'win32' }), 'E:\\VN\\Sakuuta\\savedata');
});

test('redirected Documents folder is honoured', () => {
  const t = tokenize('C:\\Users\\Alice\\OneDrive\\Documents\\My Games\\MUSICUS\\savedata', { roots: winRoots, platform: 'win32' });
  assert.strictEqual(t.path, '<documents>/My Games/MUSICUS/savedata');
});

test('a path outside known places is kept as-is and marked not portable', () => {
  const t = tokenize('X:\\weird\\place', { roots: winRoots, platform: 'win32' });
  assert.strictEqual(t.portable, false);
});

test('.. is rejected', () => {
  assert.throws(() => expand('<appdata>/../../Windows', { roots: winRoots, platform: 'win32' }));
});

test('unknown token on this PC throws a clear error', () => {
  const linux = defaultRoots({ platform: 'linux', home: '/home/a', env: {} });
  assert.throws(() => expand('<locallow>/x', { roots: linux, platform: 'linux' }), /locallow/);
});
