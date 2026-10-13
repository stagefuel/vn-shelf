'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeDrive } = require('./helpers/fake-drive');
const { GoogleAuth } = require('../src/core/google-oauth');
const { DriveClient } = require('../src/core/gdrive');
const { DriveStore, DirStore } = require('../src/core/stores');
const { ManifestSyncEngine } = require('../src/core/manifest-sync');
const { StoreLibrary } = require('../src/core/store-library');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vns-drv-')); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function memTokens() { let t = null; return { load: () => t, save: (x) => { t = x; }, clear: () => { t = null; } }; }

/** Play the browser's part: follow the auth URL's redirect back to the local helper. */
function fakeBrowser({ deny = false } = {}) {
  return async (url) => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri'));
    if (deny) back.searchParams.set('error', 'access_denied');
    else back.searchParams.set('code', 'the-code');
    back.searchParams.set('state', u.searchParams.get('state'));
    await fetch(back);
  };
}

function authFor(fd, opts = {}) {
  return new GoogleAuth({
    clientId: 'cid', clientSecret: 'csecret', tokenStore: opts.tokens || memTokens(),
    openUrl: opts.openUrl || fakeBrowser(), tokenUrl: fd.tokenUrl, revokeUrl: fd.revokeUrl,
  });
}

function driveStoreFor(fd, auth) {
  const client = new DriveClient({
    getAccessToken: () => auth.getAccessToken(), refreshAccessToken: () => auth.refreshAccessToken(),
    apiBase: fd.apiBase, uploadBase: fd.uploadBase,
  });
  return new DriveStore(client);
}

// ------------------------------------------------------------------ sign-in

test('sign-in: browser round trip, token refresh, sign-out', async () => {
  const fd = await startFakeDrive();
  try {
    let opened = null;
    const auth = authFor(fd, { openUrl: async (u) => { opened = new URL(u); await fakeBrowser()(u); } });
    assert.strictEqual(auth.signedIn(), false);
    await auth.signIn({ timeoutMs: 5000 });
    assert.strictEqual(auth.signedIn(), true);
    assert.strictEqual(opened.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    assert.strictEqual(opened.searchParams.get('code_challenge_method'), 'S256');
    assert.match(opened.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.strictEqual(await auth.getAccessToken(), fd.state.validToken);

    // Expired access token is refreshed automatically.
    auth.store.save({ ...auth.store.load(), expires_at: Date.now() - 1 });
    const t2 = await auth.getAccessToken();
    assert.strictEqual(t2, fd.state.validToken);

    await auth.signOut();
    assert.strictEqual(auth.signedIn(), false);
    await assert.rejects(() => auth.getAccessToken(), (e) => e.code === 'signed-out');
  } finally { await fd.close(); }
});

test('sign-in: cancelled in the browser gives a clear error', async () => {
  const fd = await startFakeDrive();
  try {
    const auth = authFor(fd, { openUrl: fakeBrowser({ deny: true }) });
    await assert.rejects(() => auth.signIn({ timeoutMs: 5000 }), (e) => e.code === 'denied');
    assert.strictEqual(auth.signedIn(), false);
  } finally { await fd.close(); }
});

test('sign-in revoked elsewhere: refresh fails as signed-out and tokens are dropped', async () => {
  const fd = await startFakeDrive();
  try {
    const auth = authFor(fd);
    await auth.signIn({ timeoutMs: 5000 });
    fd.state.refreshToken = 'something-else'; // user revoked access on myaccount.google.com
    auth.store.save({ ...auth.store.load(), expires_at: 0 });
    await assert.rejects(() => auth.getAccessToken(), (e) => e.code === 'signed-out');
    assert.strictEqual(auth.signedIn(), false);
  } finally { await fd.close(); }
});

// ------------------------------------------------------------------ Drive client / store

test('Drive store: retries server errors and re-auths after a 401', async () => {
  const fd = await startFakeDrive();
  try {
    const auth = authFor(fd);
    await auth.signIn({ timeoutMs: 5000 });
    const store = driveStoreFor(fd, auth);
    assert.ok(await store.available());
    await store.createGame('g1');
    fd.state.failNext.push(500, 503);
    await store.putFile('g1', 'x.txt', Buffer.from('hello'));
    assert.strictEqual((await store.getFile('g1', 'x.txt')).toString(), 'hello');
    fd.state.validToken = 'rotated'; // server-side expiry: next call gets 401, client must refresh
    fd.state.refreshToken = auth.store.load().refresh_token;
    store.refresh();
    assert.strictEqual((await store.getFile('g1', 'x.txt')).toString(), 'hello');
    // Overwrite keeps one file
    await store.putFile('g1', 'x.txt', Buffer.from('bye'));
    store.refresh('g1');
    assert.strictEqual((await store.list('g1')).filter((f) => f.name === 'x.txt').length, 1);
    // Paging: more files than one page
    for (let i = 0; i < 9; i++) await store.putBlob('g1', `h${i}`, Buffer.from(String(i)));
    assert.strictEqual((await store.listBlobs('g1')).size, 9);
    // Same root folder is found again by a second client
    const store2 = driveStoreFor(fd, auth);
    assert.strictEqual(await store2.root(), await store.root());
    assert.deepStrictEqual(await store2.listGames(), ['g1']);
  } finally { await fd.close(); }
});

test('Drive store: unreachable Drive reports unavailable instead of throwing', async () => {
  const fd = await startFakeDrive();
  const auth = authFor(fd);
  await auth.signIn({ timeoutMs: 5000 });
  const store = driveStoreFor(fd, auth);
  await fd.close();
  assert.strictEqual(await store.available(), false);
});

// ------------------------------------------------------------------ two PCs syncing (Drive and DirStore)

async function twoPcs(kind) {
  const base = tmp();
  let fd = null;
  let makeStore;
  if (kind === 'drive') {
    fd = await startFakeDrive();
    const auth = authFor(fd);
    await auth.signIn({ timeoutMs: 5000 });
    makeStore = () => driveStoreFor(fd, auth);
  } else {
    const root = path.join(base, 'shared');
    fs.mkdirSync(root);
    makeStore = () => new DirStore(root);
  }
  const libStore = makeStore();
  const lib = new StoreLibrary(libStore, path.join(base, 'covers'));
  let game = await lib.create({ title: 'Muramasa', exe: 'muramasa.exe' });
  game = await lib.addSaveRule(game.id, { path: '<appdata>/Nitroplus/Muramasa' });
  const pc = (name) => {
    const home = path.join(base, name);
    const roots = { '<appdata>': path.join(home, 'appdata'), '<home>': home };
    const install = path.join(home, 'game');
    fs.mkdirSync(install, { recursive: true });
    const engine = new ManifestSyncEngine({ store: makeStore(), deviceId: `${name}-id-0000`, deviceName: name, roots, historyDepth: 5, gcGraceMs: 0 });
    const dir = path.join(roots['<appdata>'], 'Nitroplus', 'Muramasa');
    return {
      name, engine, install, last: null,
      save: (f, s) => write(path.join(dir, f), s),
      read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
      has: (f) => fs.existsSync(path.join(dir, f)),
      rm: (f) => fs.rmSync(path.join(dir, f)),
    };
  };
  return { fd, lib, game, a: pc('PC'), b: pc('Laptop'), close: () => fd && fd.close() };
}

async function sync(p, game, opts) {
  const r = await p.engine.sync(game, p.install, p.last, opts);
  p.last = r.lastSync;
  return r.action;
}

for (const kind of ['drive', 'dir']) {
  test(`[${kind}] saves move PC → laptop → PC, deletions follow, history is kept`, async () => {
    const env = await twoPcs(kind);
    const { game, a, b } = env;
    try {
      a.save('s1.dat', 'one'); a.save('s2.dat', 'two');
      assert.strictEqual(await sync(a, game), 'push');
      assert.strictEqual(await sync(b, game), 'pull');
      assert.strictEqual(b.read('s1.dat'), 'one');
      b.save('s1.dat', 'one+'); b.rm('s2.dat');
      assert.strictEqual(await sync(b, game), 'push');
      assert.strictEqual(await sync(a, game), 'pull');
      assert.strictEqual(a.read('s1.dat'), 'one+');
      assert.strictEqual(a.has('s2.dat'), false);
      assert.strictEqual(await sync(a, game), 'nothing');
      const hist = await a.engine.listHistory(game.id);
      assert.ok(hist.some((h) => h.kind === 'pushed' && h.deviceName === 'PC'));
      assert.ok(hist.some((h) => h.kind === 'before-pull' && h.deviceName === 'PC' && h.files === 2));
    } finally { await env.close(); }
  });

  test(`[${kind}] conflict: either choice keeps the other copy restorable`, async () => {
    const env = await twoPcs(kind);
    const { game, a, b } = env;
    try {
      a.save('s.dat', 'base');
      await sync(a, game); await sync(b, game);
      a.save('s.dat', 'pc'); b.save('s.dat', 'laptop');
      await sync(a, game);
      await assert.rejects(() => sync(b, game), (e) => e.code === 'conflict' && e.info.cloud.deviceName === 'PC');
      assert.strictEqual(await sync(b, game, { resolution: 'local' }), 'push');
      assert.strictEqual(await sync(a, game), 'pull');
      assert.strictEqual(a.read('s.dat'), 'laptop');
      // PC's version is in history (either as the pushed version or PC's pre-pull backup); restore it
      const hist = await a.engine.listHistory(game.id);
      const pcEntry = hist.find((h) => h.deviceName === 'PC' && h.kind === 'pushed');
      assert.ok(pcEntry, JSON.stringify(hist.map((h) => [h.kind, h.deviceName])));
      a.last = await a.engine.restore(game, a.install, pcEntry.name);
      assert.strictEqual(a.read('s.dat'), 'pc');
      assert.strictEqual(await sync(b, game), 'pull');
      assert.strictEqual(b.read('s.dat'), 'pc');
    } finally { await env.close(); }
  });

  test(`[${kind}] a push that races another PC's push is refused, not overwritten`, async () => {
    const env = await twoPcs(kind);
    const { game, a, b } = env;
    try {
      a.save('s.dat', 'base');
      await sync(a, game); await sync(b, game);
      // Laptop decides to push based on the current state...
      b.save('s.dat', 'laptop');
      const local = await b.engine.scanLocal(game, b.install);
      const expected = (await b.engine.readCloudState(game.id)).generation;
      // ...but the PC pushes first.
      a.save('s.dat', 'pc');
      await sync(a, game);
      await assert.rejects(() => b.engine.push(game, local, { expected }), (e) => e.code === 'conflict');
    } finally { await env.close(); }
  });

  test(`[${kind}] missing blob is reported as still-uploading and nothing is overwritten`, async () => {
    const env = await twoPcs(kind);
    const { game, a, b } = env;
    try {
      a.save('s.dat', 'new');
      await sync(a, game);
      const st = await a.engine.readCloudState(game.id);
      await a.engine.store.deleteBlob(game.id, Object.values(st.hashes)[0]);
      b.save('s.dat', 'old');
      await assert.rejects(() => sync(b, game, { resolution: 'cloud' }), (e) => e.code === 'cloud-incomplete');
      assert.strictEqual(b.read('s.dat'), 'old');
    } finally { await env.close(); }
  });

  test(`[${kind}] history is trimmed and unreferenced blobs are cleaned up`, async () => {
    const env = await twoPcs(kind);
    const { game, a } = env;
    try {
      for (let i = 0; i < 9; i++) {
        a.save('s.dat', `v${i}`);
        await sync(a, game);
        await new Promise((r) => setTimeout(r, 1050));
      }
      const hist = await a.engine.listHistory(game.id);
      assert.strictEqual(hist.length, 5);
      const blobs = await a.engine.store.listBlobs(game.id);
      assert.ok(blobs.size <= 6, `blobs: ${blobs.size}`); // current + 5 history versions
    } finally { await env.close(); }
  });

  test(`[${kind}] lock shows the game is open on another PC`, async () => {
    const env = await twoPcs(kind);
    const { game, a, b } = env;
    try {
      await a.engine.takeLock(game.id);
      const l = await b.engine.readLock(game.id);
      assert.strictEqual(l.deviceName, 'PC');
      assert.strictEqual(l.mine, false);
      await b.engine.releaseLock(game.id);
      assert.ok(await a.engine.readLock(game.id));
      await a.engine.releaseLock(game.id);
      assert.strictEqual(await a.engine.readLock(game.id), null);
    } finally { await env.close(); }
  });

  test(`[${kind}] library: list, update, cover cache, remove`, async () => {
    const env = await twoPcs(kind);
    const { lib, game } = env;
    try {
      await lib.create({ title: '素晴らしき日々' });
      let all = await lib.list();
      assert.deepStrictEqual(all.map((g) => g.title).sort(), ['Muramasa', '素晴らしき日々'].sort());
      await lib.update(game.id, { launch: { useLocaleEmulator: true } });
      const g2 = await lib.setCoverBuffer(game.id, Buffer.from('JPEGDATA'), '.jpg');
      fs.rmSync(lib.coverPath(g2)); // another PC: not cached yet
      const p = await lib.ensureCover(await lib.get(game.id));
      assert.strictEqual(fs.readFileSync(p, 'utf8'), 'JPEGDATA');
      assert.strictEqual((await lib.get(game.id)).launch.useLocaleEmulator, true);
      await lib.remove(game.id);
      all = await lib.list();
      assert.deepStrictEqual(all.map((g) => g.title), ['素晴らしき日々']);
    } finally { await env.close(); }
  });
}
