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
  test(`[${kind}] progress: uploads and downloads report every file`, async () => {
    const env = await twoPcs(kind);
    const { game, a, b } = env;
    try {
      a.save('save01.dat', 'x'.repeat(800));
      a.save('save02.dat', 'y'.repeat(200));
      const up = [];
      await sync(a, game, { onProgress: (p) => up.push(p) });
      assert.deepStrictEqual(up.map((p) => p.done), [0, 1, 2]);
      assert.ok(up.every((p) => p.phase === 'upload' && p.total === 2 && p.totalBytes === 1000));
      const down = [];
      await sync(b, game, { onProgress: (p) => down.push(p) });
      const last = down[down.length - 1];
      assert.deepStrictEqual([last.phase, last.done, last.total, last.bytes], ['download', 2, 2, 1000]);
    } finally { await env.close(); }
  });
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
      a.engine.historyDepth = 2;
      for (let i = 0; i < 4; i++) {
        a.save('s.dat', `v${i}`);
        await sync(a, game);
        await new Promise((r) => setTimeout(r, 1050));
      }
      const hist = await a.engine.listHistory(game.id);
      assert.strictEqual(hist.length, 2);
      const blobs = await a.engine.store.listBlobs(game.id);
      assert.ok(blobs.size <= 3, `blobs: ${blobs.size}`); // current + 2 history versions
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

// ------------------------------------------------------------------ duplicate root folders

test('drive: simultaneous first-time calls create only one VN Shelf root', async () => {
  const fd = await startFakeDrive();
  try {
    const auth = authFor(fd);
    await auth.signIn({ timeoutMs: 5000 });
    const store = driveStoreFor(fd, auth);
    // The app does several of these at once right after sign-in.
    await Promise.all([store.available(), store.listGames(), store.createGame('a-111111'), store.readAll('game.json')]);
    const roots = [...fd.state.files.values()].filter((f) => f.appProperties && f.appProperties.vnshelf === 'root');
    assert.strictEqual(roots.length, 1);
  } finally { await fd.close(); }
});

test('drive: games in a duplicate root (made by another PC) are still found', async () => {
  const fd = await startFakeDrive();
  try {
    const authA = authFor(fd); await authA.signIn({ timeoutMs: 5000 });
    const authB = authFor(fd); await authB.signIn({ timeoutMs: 5000 });
    // Two PCs each create a root before seeing the other's, and each adds a game.
    const a = driveStoreFor(fd, authA);
    const b = driveStoreFor(fd, authB);
    await a.client.createFolder('VN Shelf', undefined, { vnshelf: 'root' });
    await b.client.createFolder('VN Shelf', undefined, { vnshelf: 'root' });
    const libA = new StoreLibrary(a, tmp());
    const libB = new StoreLibrary(b, tmp());
    const ga = await libA.create({ title: 'Game A' });
    // Force B into the other root, as if it had created its own.
    const second = [...fd.state.files.values()].filter((f) => f.appProperties && f.appProperties.vnshelf === 'root')[1].id;
    b.rootIds = [second];
    b.rootId = second;
    const gb = await libB.create({ title: 'Game B' });
    const fresh = new StoreLibrary(driveStoreFor(fd, authA), tmp());
    const titles = (await fresh.list()).map((g) => g.title).sort();
    assert.deepStrictEqual(titles, ['Game A', 'Game B'], `found ${titles}; ids ${ga.id} ${gb.id}`);
  } finally { await fd.close(); }
});

// ------------------------------------------------------------------ start-up speed

test('drive: readAll downloads in parallel and caches unchanged files between runs', async () => {
  const fd = await startFakeDrive();
  try {
    const auth = authFor(fd); await auth.signIn({ timeoutMs: 5000 });
    const lib = new StoreLibrary(driveStoreFor(fd, auth), tmp());
    const made = [];
    for (let i = 0; i < 12; i++) made.push(await lib.create({ title: `Game ${i}` }));

    const cacheFile = path.join(tmp(), 'drive-cache.json');
    const counted = () => {
      const s = driveStoreFor(fd, auth);
      s.cacheFile = cacheFile;
      try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) s.jsonCache.set(k, v); } catch { /* first run */ }
      s.downloads = 0;
      let inFlight = 0;
      s.maxInFlight = 0;
      const dl = s.client.download.bind(s.client);
      s.client.download = async (id) => {
        s.downloads++; inFlight++; s.maxInFlight = Math.max(s.maxInFlight, inFlight);
        try { return await dl(id); } finally { inFlight--; }
      };
      return s;
    };

    const first = counted();
    const all = await first.readAll('game.json');
    assert.strictEqual(all.size, 12);
    assert.strictEqual(first.downloads, 12);
    assert.ok(first.maxInFlight > 1, 'downloads should overlap');
    for (const g of made) assert.strictEqual(all.get(g.id).title, g.title);

    // Next start: nothing changed, so nothing is downloaded.
    const second = counted();
    assert.strictEqual((await second.readAll('game.json')).size, 12);
    assert.strictEqual(second.downloads, 0);

    // Another PC edits one game: only that file is fetched, and the new content wins.
    await lib.update(made[3].id, { title: 'Renamed' });
    const third = counted();
    const again = await third.readAll('game.json');
    assert.strictEqual(third.downloads, 1);
    assert.strictEqual(again.get(made[3].id).title, 'Renamed');

    // The cache only keeps entries for files that still exist.
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).length, 12);
  } finally { await fd.close(); }
});

test('drive: every game\'s badge from one listing, own writes seen at once, other PC\'s changes noticed', async () => {
  const fd = await startFakeDrive();
  try {
    const auth = authFor(fd); await auth.signIn({ timeoutMs: 5000 });
    const roots = { '<appdata>': path.join(tmp(), 'appdata'), '<home>': tmp() };
    const storeA = driveStoreFor(fd, auth);
    const libA = new StoreLibrary(storeA, tmp());
    const engA = new ManifestSyncEngine({ store: storeA, deviceId: 'A', deviceName: 'A', roots });
    const made = [];
    for (let i = 0; i < 6; i++) {
      let g = await libA.create({ title: `Game ${i}` });
      g = await libA.addSaveRule(g.id, { path: `<appdata>/G${i}` });
      write(path.join(roots['<appdata>'], `G${i}`, 'save.dat'), `slot ${i}`);
      await engA.sync(g, null, null);
      made.push(g);
    }
    // A fresh start on another PC: one listing, then badges for every game with no further requests.
    const storeB = driveStoreFor(fd, auth);
    const libB = new StoreLibrary(storeB, tmp());
    const engB = new ManifestSyncEngine({ store: storeB, deviceId: 'B', deviceName: 'B', roots: { '<appdata>': tmp(), '<home>': tmp() } });
    const list = await libB.list();
    assert.strictEqual(list.length, 6);
    const before = fd.state.requests;
    const o = { maxAge: 20000 };
    for (const g of list) {
      const game = await libB.get(g.id, o);
      const st = await engB.status(game, null, null, o);
      assert.strictEqual(st.action, 'pull');
      await engB.readLock(g.id, o);
    }
    assert.strictEqual(fd.state.requests - before, 0, 'no Drive requests for the badges');

    // B's own edit shows straight away, without re-downloading it.
    await libB.update(made[0].id, { notes: 'mine' });
    const r1 = fd.state.requests;
    assert.strictEqual((await libB.get(made[0].id, o)).notes, 'mine');
    assert.strictEqual(fd.state.requests - r1, 0);

    // A changes a game: B's change check (one request) names exactly that game, and not B's own edit.
    const since = new Date(Date.now() - 1).toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await libA.update(made[3].id, { title: 'Renamed on A' });
    const r2 = fd.state.requests;
    const ch = await storeB.changedSince(since);
    assert.strictEqual(fd.state.requests - r2, 1);
    assert.deepStrictEqual([...ch.games.keys()], [made[3].id]);
    await storeB.snapshot();
    assert.strictEqual((await libB.get(made[3].id, o)).title, 'Renamed on A');
  } finally { await fd.close(); }
});
