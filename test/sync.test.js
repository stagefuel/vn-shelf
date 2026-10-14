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
  const st = JSON.parse(fs.readFileSync(path.join(a.engine.gameDir(game.id), 'state.json'), 'utf8'));
  fs.rmSync(path.join(a.engine.gameDir(game.id), st.dir, game.saves[0].id, 's.dat'));
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

test('progress: uploads and downloads report every file and the bytes copied', async () => {
  const { game, a, b } = await setup();
  a.save('save01.dat', 'x'.repeat(1000));
  a.save('save02.dat', 'y'.repeat(500));
  a.gameSave('sys.dat', 'z'.repeat(250));
  const up = [];
  assert.strictEqual(await sync(a, game, { onProgress: (p) => up.push(p) }), 'push');
  assert.deepStrictEqual(up.map((p) => p.done), [0, 1, 2, 3]);
  assert.ok(up.every((p) => p.phase === 'upload' && p.total === 3 && p.totalBytes === 1750));
  assert.strictEqual(up[up.length - 1].bytes, 1750);

  // The laptop already has one older save: it's backed up, then the 3 new files come down.
  b.save('save01.dat', 'old');
  const down = [];
  await sync(b, game, { resolution: 'cloud', onProgress: (p) => down.push(p) });
  const backup = down.filter((p) => p.phase === 'backup');
  const dl = down.filter((p) => p.phase === 'download');
  assert.deepStrictEqual(backup.map((p) => p.done), [0, 1]);
  assert.strictEqual(dl[dl.length - 1].done, 3);
  assert.strictEqual(dl[dl.length - 1].total, 3);
  assert.strictEqual(dl[dl.length - 1].bytes, 1750);

  // A listener that throws never breaks a sync.
  a.save('save03.dat', 'w');
  assert.strictEqual(await sync(a, game, { onProgress: () => { throw new Error('boom'); } }), 'push');
});

test('an empty or missing save folder never wipes the cloud copy: the saves come back instead', async () => {
  const { game, a } = await setup();
  a.save('save01.dat', 'progress');
  assert.strictEqual(await sync(a, game), 'push');
  // The save folder disappears (a drive unplugged, the game reinstalled, saves deleted by hand).
  fs.rmSync(path.join(a.roots['<appdata>'], 'Nitroplus'), { recursive: true });
  assert.strictEqual((await a.engine.status(game, a.install, a.last)).action, 'pull');
  assert.strictEqual(await sync(a, game), 'pull');
  assert.strictEqual(a.readSave('save01.dat'), 'progress');
});

test('a half-downloaded sync record in the shared folder is refused, not treated as "no cloud copy"', async () => {
  const { game, a, cloud } = await setup();
  a.save('save01.dat', 'x');
  await sync(a, game);
  fs.writeFileSync(path.join(cloud, 'games', game.id, 'state.json'), '{"generation": "12');
  await assert.rejects(sync(a, game), (e) => e.code === 'cloud-incomplete');
});

test('upload-only syncs never download or ask', async () => {
  const { game, a, b } = await setup();
  a.save('save01.dat', 'A');
  await sync(a, game);
  b.save('save01.dat', 'B, made outside VN Shelf');
  assert.strictEqual(await sync(b, game, { only: 'push' }), 'skipped'); // would be a conflict
  assert.strictEqual(b.readSave('save01.dat'), 'B, made outside VN Shelf');
  a.save('save01.dat', 'A2');
  assert.strictEqual(await sync(a, game, { only: 'push' }), 'push');
});

test('saves never come down while the game is open', async () => {
  const { game, a, b } = await setup();
  a.save('save01.dat', 'new');
  await sync(a, game);
  b.save('save01.dat', 'old');
  await sync(b, game, { resolution: 'cloud' });
  a.save('save01.dat', 'newer');
  await sync(a, game);
  await assert.rejects(sync(b, game, { beforePull: async () => false }), (e) => e.code === 'game-running');
  assert.strictEqual(b.readSave('save01.dat'), 'new');
  assert.strictEqual(await sync(b, game, { beforePull: async () => true }), 'pull');
  assert.strictEqual(b.readSave('save01.dat'), 'newer');
});

test('one sync at a time per game, even across engines', async () => {
  const { exclusive, busyGames } = require('../src/core/sync');
  const order = [];
  const slow = (tag, ms) => exclusive('g1', async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`); });
  const other = exclusive('g2', async () => { order.push('other'); });
  await Promise.all([slow('a', 60), slow('b', 10), other]);
  assert.deepStrictEqual(order.filter((x) => x !== 'other'), ['a+', 'a-', 'b+', 'b-']);
  assert.ok(order.indexOf('other') < order.indexOf('a-'), 'another game doesn\'t wait');
  assert.deepStrictEqual(busyGames(), []);
  // A failure doesn't block the next sync of that game.
  await assert.rejects(exclusive('g1', async () => { throw new Error('x'); }));
  assert.strictEqual(await exclusive('g1', async () => 'ok'), 'ok');
});

test('unchanged save files aren\'t read again to check them', async () => {
  const fsu = require('../src/core/fsutil');
  const { game, a } = await setup();
  for (let i = 0; i < 5; i++) a.save(`save0${i}.dat`, `slot ${i}`);
  // Files written long enough ago to trust their modified time.
  const dir = path.join(a.roots['<appdata>'], 'Nitroplus', 'Muramasa');
  const old = new Date(Date.now() - 60000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  const real = fsu.hashFile;
  let reads = 0;
  fsu.hashFile = async (p) => { reads++; return real(p); };
  try {
    await a.engine.status(game, a.install, null);
    assert.strictEqual(reads, 5);
    await a.engine.status(game, a.install, null);
    assert.strictEqual(reads, 5, 'second check used the cache');
    fs.writeFileSync(path.join(dir, 'save02.dat'), 'changed!');
    fs.utimesSync(path.join(dir, 'save02.dat'), new Date(Date.now() - 30000), new Date(Date.now() - 30000));
    const st = await a.engine.status(game, a.install, null);
    assert.strictEqual(reads, 6, 'only the changed file was read');
    assert.ok(Object.keys(st.local.hashes).length === 5);
  } finally { fsu.hashFile = real; }
});

test('a just-written file isn\'t trusted from the cache (coarse timestamps on some drives)', async () => {
  const { HashCache } = require('../src/core/hashcache');
  const c = new HashCache(null);
  const now = BigInt(Date.now()) * 1000000n;
  c.set('/x', 10, now, 'h1', Date.now());
  assert.strictEqual(c.get('/x', 10, now), null);
  const past = BigInt(Date.now() - 60000) * 1000000n;
  c.set('/x', 10, past, 'h2', Date.now());
  assert.strictEqual(c.get('/x', 10, past), 'h2');
  assert.strictEqual(c.get('/x', 11, past), null, 'different size');
});

test('a sync app\'s copy of a game folder doesn\'t show up as a second game', async () => {
  const { cloud, lib, game } = await setup();
  fs.cpSync(path.join(cloud, 'games', game.id), path.join(cloud, 'games', `${game.id} (1)`), { recursive: true });
  fs.cpSync(path.join(cloud, 'games', game.id), path.join(cloud, 'games', `${game.id} (Laptop's conflicted copy)`), { recursive: true });
  assert.deepStrictEqual((await lib.list()).map((g) => g.id), [game.id]);
});

test('play time: each PC keeps its own total in the shared record', async () => {
  const { lib, game } = await setup();
  await lib.recordPlay(game.id, 'pc', { seconds: 600, deviceName: 'PC' });
  await lib.recordPlay(game.id, 'laptop', { seconds: 120, deviceName: 'Laptop' });
  await lib.recordPlay(game.id, 'pc', { seconds: 60.4, deviceName: 'PC' });
  const g = await lib.get(game.id);
  assert.strictEqual(g.playtime.pc.seconds, 660);
  assert.strictEqual(g.playtime.laptop.seconds, 120);
  assert.ok(g.playtime.pc.lastPlayed);
});

test('registry saves: a game\'s key travels to the other PC like a save file, with history', async () => {
  const { MemoryRegistry, normalizeKey } = require('../src/core/registry');
  const { game: g0, lib, a, b } = await setup();
  const regA = new MemoryRegistry();
  const regB = new MemoryRegistry();
  a.engine.registry = regA; a.engine.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-st-'));
  b.engine.registry = regB; b.engine.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-st-'));
  const game = await lib.addSaveRule(g0.id, { kind: 'registry', key: 'HKCU\\Software\\Nitroplus\\Muramasa' });
  assert.strictEqual(game.saves[2].key, 'Software\\Nitroplus\\Muramasa');
  const data = { values: { Route: { kind: 'DWord', data: 3 }, Name: { kind: 'String', data: '景明' }, Flags: { kind: 'Binary', data: '00FF10' } },
    keys: { System: { values: { Clear: { kind: 'MultiString', data: ['a', 'b'] } }, keys: {} } } };
  regA.set('Software\\Nitroplus\\Muramasa', data);
  a.save('save01.dat', 'file save');
  assert.strictEqual(await sync(a, game), 'push');
  assert.strictEqual(await sync(b, game), 'pull');
  assert.deepStrictEqual((await regB.exportKeys(['Software\\Nitroplus\\Muramasa'])).get('Software\\Nitroplus\\Muramasa'), data);
  assert.strictEqual(b.readSave('save01.dat'), 'file save');
  // A change on B goes back to A; A's old values are kept in History first.
  regB.set('Software\\Nitroplus\\Muramasa', { ...data, values: { ...data.values, Route: { kind: 'DWord', data: 4 } } });
  assert.strictEqual(await sync(b, game), 'push');
  assert.strictEqual(await sync(a, game), 'pull');
  assert.strictEqual((await regA.exportKeys(['Software\\Nitroplus\\Muramasa'])).get('Software\\Nitroplus\\Muramasa').values.Route.data, 4);
  assert.ok((await a.engine.listHistory(game.id)).some((h) => h.kind === 'before-pull'));
  // Unsafe keys are refused outright.
  for (const bad of ['HKLM\\Software\\X\\Y', 'HKCU\\Software\\Microsoft\\Windows', 'HKCU\\Software\\OnlyMaker', 'HKCU\\Control Panel\\Desktop']) {
    assert.throws(() => normalizeKey(bad), (e) => e.code === 'registry-not-allowed', bad);
  }
});

test('registry saves: a damaged export in the cloud is never written into the registry', async () => {
  const { MemoryRegistry } = require('../src/core/registry');
  const { game: g0, lib, a, b, cloud } = await setup();
  for (const p of [a, b]) { p.engine.registry = new MemoryRegistry(); p.engine.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-st-')); }
  const game = await lib.addSaveRule(g0.id, { kind: 'registry', key: 'Software\\Maker\\Game' });
  a.engine.registry.set('Software\\Maker\\Game', { values: { X: { kind: 'DWord', data: 1 } }, keys: {} });
  await sync(a, game);
  const rule = game.saves.find((r) => r.kind === 'registry');
  const state = JSON.parse(fs.readFileSync(path.join(cloud, 'games', game.id, 'state.json'), 'utf8'));
  const dir = path.join(cloud, 'games', game.id, state.dir || 'current');
  fs.writeFileSync(path.join(dir, rule.id, '__registry__.json'), '{"values": {"X": {"kind": "DWord", "data": 1}}, "keys"');
  await assert.rejects(sync(b, game), (e) => e.code === 'cloud-incomplete');
  assert.strictEqual((await b.engine.registry.exportKeys(['Software\\Maker\\Game'])).get('Software\\Maker\\Game'), null);
});

test('two PCs uploading at the same moment through a slow sync app: no mixed files, a conflict, nothing lost', async () => {
  const { game, a, b, cloud } = await setup();
  a.save('save01.dat', 'start');
  await sync(a, game);
  await sync(b, game);
  // The sync app is slow: each PC now works on its own copy of the shared folder for a while.
  const base = path.dirname(cloud);
  const viewA = path.join(base, 'viewA');
  const viewB = path.join(base, 'viewB');
  fs.cpSync(cloud, viewA, { recursive: true });
  fs.cpSync(cloud, viewB, { recursive: true });
  a.engine.cloudDir = viewA;
  b.engine.cloudDir = viewB;
  a.save('save01.dat', 'A progress');
  b.save('save01.dat', 'B progress');
  b.save('save02.dat', 'B only');
  assert.strictEqual(await sync(a, game), 'push');
  assert.strictEqual(await sync(b, game), 'push');
  // The sync app catches up: B's sync record wins, A's becomes a "conflicted copy"; folders merge.
  const merged = path.join(base, 'merged');
  fs.cpSync(viewB, merged, { recursive: true });
  fs.cpSync(viewA, merged, { recursive: true, force: false });
  const gd = (root) => path.join(root, 'games', game.id);
  fs.copyFileSync(path.join(gd(viewA), 'state.json'), path.join(gd(merged), 'state (PC\'s conflicted copy 2026-10-14).json'));
  a.engine.cloudDir = merged;
  b.engine.cloudDir = merged;

  // B is up to date; A is told its upload was replaced (a conflict), not quietly overwritten.
  assert.strictEqual(await sync(b, game), 'nothing');
  await assert.rejects(sync(a, game), (e) => e.code === 'conflict');
  // Choosing B's: B's files arrive intact (nothing mixed in from A's upload), A's are kept in History.
  assert.strictEqual(await sync(a, game, { resolution: 'cloud' }), 'pull');
  assert.strictEqual(a.readSave('save01.dat'), 'B progress');
  assert.strictEqual(a.readSave('save02.dat'), 'B only');
  assert.ok((await a.engine.listHistory(game.id)).some((h) => h.kind === 'before-pull'));

  // A day later, A's replaced upload folder is moved into History (named after A), not deleted.
  const stB = JSON.parse(fs.readFileSync(path.join(gd(merged), 'state.json'), 'utf8'));
  const orphan = fs.readdirSync(gd(merged)).find((n) => n.startsWith('current-') && n !== stB.dir);
  assert.ok(orphan, 'A\'s upload kept its own folder');
  const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(gd(merged), orphan), old, old);
  await a.engine.cleanIncoming(gd(merged));
  assert.ok(!fs.existsSync(path.join(gd(merged), orphan)));
  const replaced = (await a.engine.listHistory(game.id)).find((h) => h.kind === 'replaced');
  assert.ok(replaced && replaced.deviceName === 'PC', 'kept as a restorable backup from PC');
});
