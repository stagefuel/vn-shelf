'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const archive = require('../src/core/archive');
const unpack = require('../src/core/unpack');
const { FakeFbq } = require('./helpers/fake-fbq');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vns-arch-'));
const big = (n, seed) => crypto.createHash('sha256').update(seed).digest().toString('hex').repeat(Math.ceil(n / 64)).slice(0, n);

function sampleServer() {
  const a = big(50000, 'a');
  const b = big(20000, 'b');
  const index = { version: 1, items: [
    { path: 'Brand/Game One', kind: 'folder', title: 'ゲーム1', vids: ['v1'], size: a.length + b.length,
      files: [{ path: 'Brand/Game One/data/a.bin', size: a.length }, { path: 'Brand/Game One/b.bin', size: b.length }] },
    { path: 'Brand/Two/two.rar', kind: 'file', title: 'Two', vids: ['v2'], size: 3, files: [{ path: 'Brand/Two/two.rar', size: 3 }] },
  ] };
  return new FakeFbq({
    users: { reader: { password: 'p@ss wörd', api: true }, plain: { password: 'x', api: false } },
    files: {
      '/vns/vnshelf-index.json': JSON.stringify(index), '/vns/Brand/Game One/data/a.bin': a, '/vns/Brand/Game One/b.bin': b,
      '/vns/Brand/Two/two.rar': 'RAR', '/other/readme.txt': 'hi',
    },
  });
}

test('archive: connect makes one named API token and ends the login session', async () => {
  const fake = sampleServer();
  const srv = await fake.listen();
  try {
    await assert.rejects(archive.connect(srv.url, 'reader', 'wrong'), { code: 'login' });
    await assert.rejects(archive.connect(srv.url, 'plain', 'x'), { code: 'no-api' });
    const c = await archive.connect(srv.url, 'reader', 'p@ss wörd', { tokenName: 'VN Shelf (PC)' });
    assert.ok(c.token.startsWith('tok-'));
    assert.strictEqual(fake.sessions.size, 0, 'session logged out');
    const again = await archive.connect(`${srv.url}/`, 'reader', 'p@ss wörd', { tokenName: 'VN Shelf (PC)' });
    assert.strictEqual(fake.tokens.size, 1, 'reconnecting replaces the old token');
    assert.ok(fake.tokens.has(again.token));
    assert.strictEqual([...fake.tokens.values()][0].name, 'VN Shelf (PC)');
    assert.ok(await archive.revoke(srv.url, again.token, 'VN Shelf (PC)'));
    assert.strictEqual(fake.tokens.size, 0, 'revoked on the server');
  } finally { await srv.close(); }
});

test('archive: finds the index and turns its paths into server paths', async () => {
  const fake = sampleServer();
  const srv = await fake.listen();
  try {
    const { token } = await archive.connect(srv.url, 'reader', 'p@ss wörd');
    const client = new archive.ArchiveClient({ server: srv.url, token });
    const where = await client.findIndex();
    assert.deepStrictEqual(where, { source: 'Home', path: '/vns/vnshelf-index.json' });
    const index = await client.fetchIndex(where);
    assert.strictEqual(index.items[0].files[0].remote, '/vns/Brand/Game One/data/a.bin');
    await assert.rejects(new archive.ArchiveClient({ server: srv.url, token: 'nope' }).findIndex(), { code: 'denied' });
  } finally { await srv.close(); }
});

test('archive: an interrupted download carries on from where it stopped', async () => {
  const fake = sampleServer();
  const srv = await fake.listen();
  const dir = tmp();
  try {
    const { token } = await archive.connect(srv.url, 'reader', 'p@ss wörd');
    const client = new archive.ArchiveClient({ server: srv.url, token });
    const dest = path.join(dir, 'a.bin');
    fake.dropAfter = 20000;
    await assert.rejects(client.downloadFile({ source: 'Home', remote: '/vns/Brand/Game One/data/a.bin', size: 50000 }, dest));
    const partial = fs.statSync(`${dest}.part`).size;
    assert.ok(partial > 0 && partial < 50000, `partial ${partial}`);
    await client.downloadFile({ source: 'Home', remote: '/vns/Brand/Game One/data/a.bin', size: 50000 }, dest);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), big(50000, 'a'));
    assert.strictEqual(fake.requests.filter((r) => r.path === '/api/resources/download').pop().range, `bytes=${partial}-`);
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally { await srv.close(); }
});

test('archive: the queue downloads one item at a time, pauses, resumes and survives a restart', async () => {
  const fake = sampleServer();
  const srv = await fake.listen();
  const dir = tmp();
  try {
    const { token } = await archive.connect(srv.url, 'reader', 'p@ss wörd');
    const client = new archive.ArchiveClient({ server: srv.url, token });
    const index = await client.fetchIndex(await client.findIndex());
    const done = [];
    const file = path.join(dir, 'downloads.json');
    let q = await new archive.DownloadQueue({ client, file, onDone: async (j) => { done.push(j.key); } }).load();
    fake.slowMs = 15;
    q.add(index.items[0], { source: 'Home', dest: path.join(dir, 'one') });
    q.add(index.items[1], { source: 'Home', dest: path.join(dir, 'two') });
    assert.strictEqual(q.add(index.items[0], { source: 'Home', dest: path.join(dir, 'one') }), null, 'no double queueing');
    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(q.list().map((j) => j.state), ['downloading', 'queued']);
    q.pause('Brand/Game One');
    await new Promise((r) => setTimeout(r, 100));
    // While the first is paused, the second goes ahead.
    assert.strictEqual(q.list()[0].state, 'paused');
    assert.deepStrictEqual(done, ['Brand/Two/two.rar']);
    // "Restart": a new queue from the saved list keeps the paused job and its progress on disk.
    fake.slowMs = 0;
    q = await new archive.DownloadQueue({ client, file, onDone: async (j) => { done.push(j.key); } }).load();
    assert.strictEqual(q.list()[0].state, 'paused');
    q.resume('Brand/Game One');
    for (let i = 0; i < 100 && done.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(done, ['Brand/Two/two.rar', 'Brand/Game One']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'one', 'data', 'a.bin'), 'utf8'), big(50000, 'a'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'one', 'b.bin'), 'utf8'), big(20000, 'b'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'two', 'two.rar'), 'utf8'), 'RAR');
    assert.ok(fake.requests.some((r) => r.range), 'resumed with a byte range');
    const j = q.list()[0];
    assert.strictEqual(j.received, j.total);
  } finally { await srv.close(); }
});

test('unpack: plan extracts part 1 of a multi-part rar and plain archives, leaves discs and extras', () => {
  assert.deepStrictEqual(unpack.plan(['g.part1.rar', 'g.part2.rar', 'g.part10.rar', 'readme.txt']),
    { extract: ['g.part1.rar'], discs: [], other: ['g.part2.rar', 'g.part10.rar', 'readme.txt'] });
  assert.deepStrictEqual(unpack.plan(['FSN.part01.rar', 'FSN.part02.rar']).extract, ['FSN.part01.rar']);
  assert.deepStrictEqual(unpack.plan(['game.zip', 'Bonus/wall.rar', 'crack/fix.zip']).extract, ['game.zip']);
  assert.deepStrictEqual(unpack.plan(['G.ISO', 'G.MDS', 'patch.zip']), { extract: [], discs: ['G.ISO', 'G.MDS'], other: ['patch.zip'] });
});

test('unpack: extracts with 7-Zip and removes the archive set afterwards', { skip: !fs.existsSync('/usr/bin/7z') && process.platform !== 'win32' }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'ゲーム'), { recursive: true });
  fs.writeFileSync(path.join(src, 'ゲーム', 'game.exe'), big(300000, 'exe'));
  const sz = await unpack.find7z();
  assert.ok(sz, '7-Zip found');
  execFileSync(sz, ['a', '-v100k', path.join(dir, 'g.7z'), path.join(src, 'ゲーム')], { stdio: 'ignore' });
  // 7-Zip's volumes are .7z.001…; rename into the rar-style part names the plan expects isn't needed: extract .001.
  const out = path.join(dir, 'out');
  let pct = 0;
  await unpack.extract(sz, path.join(dir, 'g.7z.001'), out, { onProgress: (p) => { pct = p; } });
  assert.strictEqual(fs.readFileSync(path.join(out, 'ゲーム', 'game.exe'), 'utf8'), big(300000, 'exe'));
  assert.ok(pct >= 0);
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  await assert.rejects(unpack.extract(sz, path.join(dir, 'bad.zip'), path.join(dir, 'out2')));
  fs.writeFileSync(path.join(dir, 'x.part1.rar'), '1');
  fs.writeFileSync(path.join(dir, 'x.part2.rar'), '2');
  await unpack.removeArchives(dir, ['x.part1.rar']);
  assert.ok(!fs.existsSync(path.join(dir, 'x.part1.rar')) && !fs.existsSync(path.join(dir, 'x.part2.rar')));
});
