'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SyncEngine, decide } = require('../src/core/sync');
const { Library } = require('../src/core/library');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vns-')); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function read(p) { return fs.readFileSync(p, 'utf8'); }

// Two PCs sharing one cloud folder. Each has its own AppData and install dir.
async function setup() {
  const base = tmp();
  const cloud = path.join(base, 'cloud');
  fs.mkdirSync(cloud);
  const pc = (name) => {
    const home = path.join(base, name);
    const roots = { '<appdata>': path.join(home, 'appdata'), '<localappdata>': path.join(home, 'local'),
      '<documents>': path.join(home, 'docs'), '<home>': home };
    const install = path.join(home, 'games', 'Muramasa');
    fs.mkdirSync(install, { recursive: true });
    const engine = new SyncEngine({ cloudDir: cloud, deviceId: `${name}-id-0000`, deviceName: name, roots, historyDepth: 5 });
    return { name, roots, install, engine, last: null,
      save: (f, s) => write(path.join(roots['<appdata>'], 'Nitroplus', 'Muramasa', f), s),
      gameSave: (f, s) => write(path.join(install, 'savedata', f), s),
      readSave: (f) => read(path.join(roots['<appdata>'], 'Nitroplus', 'Muramasa', f)),
      hasSave: (f) => fs.existsSync(path.join(roots['<appdata>'], 'Nitroplus', 'Muramasa', f)) };
  };
  const lib = new Library(cloud);
  let game = await lib.create({ title: 'Muramasa', exe: 'muramasa.exe' });
  game = await lib.addSaveRule(game.id, { path: '<appdata>/Nitroplus/Muramasa' });
  game = await lib.addSaveRule(game.id, { path: '<game>/savedata' });
  return { cloud, lib, game, a: pc('PC'), b: pc('Laptop') };
}

async function sync(p, game, opts) {
  const r = await p.engine.sync(game, p.install, p.last, opts);
  p.last = r.lastSync;
  return r.action;
}

test('decide() covers every case', () => {
  const h1 = { 'r/a': '1' }; const h2 = { 'r/a': '2' };
  assert.strictEqual(decide({}, null, null), 'nothing');
  assert.strictEqual(decide(h1, null, null), 'push');
  assert.strictEqual(decide({}, { generation: 'g', hashes: h1 }, null), 'pull');
  assert.strictEqual(decide(h1, { generation: 'g', hashes: h1 }, null), 'adopt');
  assert.strictEqual(decide(h2, { generation: 'g', hashes: h1 }, null), 'conflict');
  const last = { generation: 'g', hashes: h1 };
  assert.strictEqual(decide(h1, { generation: 'g', hashes: h1 }, last), 'nothing');
  assert.strictEqual(decide(h2, { generation: 'g', hashes: h1 }, last), 'push');
  assert.strictEqual(decide(h1, { generation: 'g2', hashes: h2 }, last), 'pull');
  assert.strictEqual(decide(h2, { generation: 'g2', hashes: h2 }, last), 'adopt');
  assert.strictEqual(decide({ 'r/a': '3' }, { generation: 'g2', hashes: h2 }, last), 'conflict');
  // Shared folder wiped: re-upload rather than deleting local saves.
  assert.strictEqual(decide(h1, null, last), 'push');
});

test('PC saves, laptop picks it up, laptop saves, PC picks that up', async () => {
  const { game, a, b } = await setup();
  a.save('save01.dat', 'chapter 1');
  a.gameSave('system.dat', 'cfg');
  assert.strictEqual(await sync(a, game), 'push');
  assert.strictEqual(await sync(b, game), 'pull');
  assert.strictEqual(b.readSave('save01.dat'), 'chapter 1');
  assert.strictEqual(read(path.join(b.install, 'savedata', 'system.dat')), 'cfg');

  b.save('save01.dat', 'chapter 2');
  b.save('save02.dat', 'chapter 2b');
  assert.strictEqual(await sync(b, game), 'push');
  assert.strictEqual(await sync(a, game), 'pull');
  assert.strictEqual(a.readSave('save01.dat'), 'chapter 2');
  assert.strictEqual(a.readSave('save02.dat'), 'chapter 2b');
  assert.strictEqual(await sync(a, game), 'nothing');
  assert.strictEqual(await sync(b, game), 'nothing');
});

test('deleted save slots are deleted on the other PC too, with a backup', async () => {
  const { game, a, b } = await setup();
  a.save('s1.dat', '1'); a.save('s2.dat', '2');
  await sync(a, game); await sync(b, game);
  fs.rmSync(path.join(a.roots['<appdata>'], 'Nitroplus', 'Muramasa', 's2.dat'));
  assert.strictEqual(await sync(a, game), 'push');
  assert.strictEqual(await sync(b, game), 'pull');
  assert.strictEqual(b.hasSave('s2.dat'), false);
  const hist = await b.engine.listHistory(game.id);
  assert.ok(hist.some((h) => h.kind === 'before-pull' && h.files === 2), 'laptop copy was backed up before pull');
});

test('conflict is raised, and either choice keeps the other side in history', async () => {
  const { game, a, b } = await setup();
  a.save('s.dat', 'base');
  await sync(a, game); await sync(b, game);
  a.save('s.dat', 'pc progress');
  b.save('s.dat', 'laptop progress');
  await sync(a, game); // PC pushes first
  await assert.rejects(() => sync(b, game), (e) => e.code === 'conflict' && e.info.cloud.deviceName === 'PC');
  // Laptop keeps its own; PC's version must survive in history.
  assert.strictEqual(await sync(b, game, { resolution: 'local' }), 'push');
  const hist = await b.engine.listHistory(game.id);
  const pcVersion = hist.find((h) => h.deviceName === 'PC' && h.kind === 'pushed' && h.files === 1 &&
    fs.readFileSync(path.join(b.engine.gameDir(game.id), 'history', h.name, 'files', game.saves[0].id, 's.dat'), 'utf8') === 'pc progress');
  assert.ok(pcVersion, "PC's version is in history");
  // And it can be restored on the PC.
  assert.strictEqual(await sync(a, game), 'pull');
  assert.strictEqual(a.readSave('s.dat'), 'laptop progress');
  a.last = await a.engine.restore(game, a.install, pcVersion.name);
  assert.strictEqual(a.readSave('s.dat'), 'pc progress');
  assert.strictEqual(await sync(b, game), 'pull');
  assert.strictEqual(b.readSave('s.dat'), 'pc progress');
});

test('conflict resolved by taking the cloud copy backs up the local one', async () => {
  const { game, a, b } = await setup();
  a.save('s.dat', 'base'); await sync(a, game); await sync(b, game);
  a.save('s.dat', 'pc'); b.save('s.dat', 'laptop');
  await sync(a, game);
  assert.strictEqual(await sync(b, game, { resolution: 'cloud' }), 'pull');
  assert.strictEqual(b.readSave('s.dat'), 'pc');
  const hist = await b.engine.listHistory(game.id);
  assert.ok(hist.some((h) => h.kind === 'before-pull' && h.deviceName === 'Laptop'));
});

test('first sync on a second PC that already has identical saves just adopts', async () => {
  const { game, a, b } = await setup();
  a.save('s.dat', 'same'); b.save('s.dat', 'same');
  await sync(a, game);
  assert.strictEqual(await sync(b, game), 'adopt');
});

test('half-synced shared folder is refused instead of copied', async () => {
  const { game, a, b } = await setup();
  a.save('s.dat', 'one');
  await sync(a, game);
  // Simulate Drive having delivered state.json but not the save file yet.
  fs.rmSync(path.join(a.engine.gameDir(game.id), 'current', game.saves[0].id, 's.dat'));
  b.save('s.dat', 'old');
  b.last = null;
  await assert.rejects(() => sync(b, game, { resolution: 'cloud' }), (e) => e.code === 'cloud-incomplete');
  assert.strictEqual(b.readSave('s.dat'), 'old');
});

test('missing shared folder gives a clear error', async () => {
  const { game, a, cloud } = await setup();
  fs.renameSync(cloud, cloud + '-gone');
  await assert.rejects(() => sync(a, game), (e) => e.code === 'cloud-unavailable');
});

test('history keeps only the newest N versions', async () => {
  const { game, a } = await setup();
  for (let i = 0; i < 9; i++) {
    a.save('s.dat', `v${i}`);
    await sync(a, game);
    await new Promise((r) => setTimeout(r, 1100)); // history names have 1-second resolution
  }
  const hist = await a.engine.listHistory(game.id);
  assert.strictEqual(hist.length, 5);
});

test('include patterns limit which files sync', async () => {
  const { game, lib, a, b } = await setup();
  const g = await lib.addSaveRule(game.id, { path: '<game>', include: ['Save*.rvdata2'] });
  write(path.join(a.install, 'Save01.rvdata2'), 'x');
  write(path.join(a.install, 'Game.exe'), 'binary');
  await sync(a, g); await sync(b, g);
  assert.ok(fs.existsSync(path.join(b.install, 'Save01.rvdata2')));
  assert.ok(!fs.existsSync(path.join(b.install, 'Game.exe')));
});

test('lock shows another PC has the game open', async () => {
  const { game, a, b } = await setup();
  await a.engine.takeLock(game.id);
  const l = await b.engine.readLock(game.id);
  assert.strictEqual(l.deviceName, 'PC');
  assert.strictEqual(l.mine, false);
  await b.engine.releaseLock(game.id); // not ours: must not remove
  assert.ok(await a.engine.readLock(game.id));
  await a.engine.releaseLock(game.id);
  assert.strictEqual(await a.engine.readLock(game.id), null);
});
