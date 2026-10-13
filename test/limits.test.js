'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const limits = require('../src/core/limits');
const { SyncEngine } = require('../src/core/sync');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vns-lim-')); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }

test('whole system folders and the whole game folder are refused', () => {
  for (const p of ['<appdata>', '<localappdata>', '<locallow>', '<documents>', '<home>', '<savedgames>', '<documents>/My Games', '<game>']) {
    assert.ok(limits.rejectPath(p, []), p);
  }
  assert.ok(limits.rejectPath('C:/', []));
  assert.strictEqual(limits.rejectPath('D:/Games/Saves/Rance', []), null);
  assert.ok(limits.rejectPath('C:/Windows', []));
  assert.strictEqual(limits.rejectPath('<game>', ['Save*.rvdata2']), null);
  assert.strictEqual(limits.rejectPath('<appdata>/Nitroplus/Muramasa', []), null);
  assert.strictEqual(limits.rejectPath('<game>/savedata', []), null);
});

test('a folder overlapping the sync folder is refused', () => {
  const r = limits.rejectPath('<documents>/Sync', [], { cloudDir: '/home/a/Documents/Sync/VNShelf', abs: '/home/a/Documents/Sync', platform: 'linux' });
  assert.ok(r);
});

test('soft limit needs confirmation, hard limit is refused', () => {
  assert.strictEqual(limits.judge({ files: 10, bytes: 1e6 }), 'ok');
  assert.strictEqual(limits.judge({ files: 1500, bytes: 1e6 }), 'confirm');
  assert.strictEqual(limits.judge({ files: 1500, bytes: 1e6 }, { confirmed: true }), 'ok');
  assert.strictEqual(limits.judge({ files: 10, bytes: 600 * 1024 * 1024 }, { confirmed: true }), 'refuse');
});

function engineFor(home) {
  const roots = { '<appdata>': path.join(home, 'appdata'), '<home>': home };
  return new SyncEngine({ cloudDir: path.join(home, 'cloud'), deviceId: 'x-0000000', deviceName: 'PC', roots });
}

test('multi-file saves: every slot, system file and subfolder syncs as one set; non-saves are skipped', async () => {
  const home = tmp();
  const dir = path.join(home, 'appdata', 'Studio', 'Game');
  write(path.join(dir, 'save001.dat'), 'a');
  write(path.join(dir, 'save002.dat'), 'b');
  write(path.join(dir, 'system.dat'), 'sys');
  write(path.join(dir, 'global.sav'), 'g');
  write(path.join(dir, 'thumbs', 'save001.png'), 'png');
  write(path.join(dir, 'udat_rel.bin'), 'bin');
  write(path.join(dir, 'game.exe'), 'MZ');
  write(path.join(dir, 'opening.mp4'), 'video');
  write(path.join(dir, 'data.xp3'), 'archive');
  write(path.join(dir, 'Cache', 'data_0'), 'cache');
  write(path.join(dir, 'debug.log'), 'log');
  const e = engineFor(home);
  const game = { id: 'g', saves: [{ id: 'r1', path: '<appdata>/Studio/Game', include: [], exclude: [] }] };
  const local = await e.scanLocal(game, path.join(home, 'install'));
  assert.deepStrictEqual(Object.keys(local.hashes).sort(), [
    'r1/global.sav', 'r1/save001.dat', 'r1/save002.dat', 'r1/system.dat', 'r1/thumbs/save001.png', 'r1/udat_rel.bin',
  ]);
});

test('a save location that grew past the hard limit stops syncing with a clear error', async () => {
  const home = tmp();
  const dir = path.join(home, 'appdata', 'Studio', 'Huge');
  for (let i = 0; i <= limits.LIMITS.hardFiles; i++) write(path.join(dir, `f${i}.dat`), 'x');
  const e = engineFor(home);
  const game = { id: 'g', saves: [{ id: 'r1', path: '<appdata>/Studio/Huge', include: [], exclude: [] }] };
  await assert.rejects(() => e.scanLocal(game, path.join(home, 'install')), (err) => err.code === 'too-big');
});

test('a refused location in game.json (e.g. edited by hand) is not synced', async () => {
  const home = tmp();
  write(path.join(home, 'appdata', 'x.dat'), 'x');
  const e = engineFor(home);
  const game = { id: 'g', saves: [{ id: 'r1', path: '<appdata>', include: [], exclude: [] }] };
  await assert.rejects(() => e.scanLocal(game, path.join(home, 'install')), (err) => err.code === 'bad-path');
});
