'use strict';
// End-to-end check of downloading from a VN archive (a stand-in Filebrowser server,
// test/helpers/fake-fbq.js, with a stand-in VNDB for covers): connect in Settings → Archive (only a
// token is kept), the Archive view, a download that unpacks with 7-Zip and lands in the library
// linked to VNDB, a disc image that waits for you to install it, pause and resume, the ↓ button on
// My List's cards, and disconnecting.
// Linux: DISPLAY=:97 node scripts/ui-smoke-archive.js <shots dir>   (needs 7z on the PATH; no internet)
// Windows / a packaged build: set VNS_EXE to the app's .exe (needs 7-Zip installed).
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { FakeVndb } = require('../test/helpers/fake-vndb');
const { FakeFbq } = require('../test/helpers/fake-fbq');
const unpack = require('../src/core/unpack');

const shots = path.resolve(process.argv[2] || 'shots-archive');
fs.mkdirSync(shots, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-uia-'));
const shot = (page, n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
const write = (p, s = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cloudDir = path.join(base, 'shared', 'VNShelf');
const userData = path.join(base, 'settings');
const downloads = path.join(base, 'VN downloads');
write(path.join(userData, 'config.json'), JSON.stringify({ cloudDir, backend: 'folder', deviceName: 'PC1', autoUpdate: false }));

async function until(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(250);
  }
}

(async () => {
  // The archive's files: a zipped game, a disc image, and a big file to pause.
  const sevenZip = await unpack.find7z();
  if (!sevenZip) throw new Error('7-Zip is needed for this check');
  const src = path.join(base, 'src', 'ゲームA');
  write(path.join(src, 'gamea.exe'), crypto.randomBytes(200000));
  write(path.join(src, 'data.xp3'), 'xp3');
  const zip = path.join(base, 'src', 'gamea.zip');
  execFileSync(sevenZip, ['a', zip, src], { stdio: 'ignore' });
  const zipBuf = fs.readFileSync(zip);
  const iso = crypto.randomBytes(30000);
  const bigBuf = crypto.randomBytes(3 * 1024 * 1024);
  const item = (p, kind, title, vids, files, extra = {}) => ({ path: p, kind, group: p.split('/')[0], title, vids, size: files.reduce((s, f) => s + f[1], 0),
    files: files.map(([fp, size]) => ({ path: fp, size })), ...extra });
  const index = { version: 1, generated: '2026-10-15T00:00:00Z', items: [
    item('Brand/ゲームA', 'folder', 'ゲームA', ['v501'], [['Brand/ゲームA/gamea.zip', zipBuf.length]]),
    item('Brand/Disc Game', 'folder', 'ディスクゲーム', ['v502'], [['Brand/Disc Game/DISC.ISO', iso.length]], { edition: '初回限定版' }),
    item('Other/Big Game', 'folder', 'ビッグゲーム', ['v503'], [['Other/Big Game/big.bin', bigBuf.length]], { part: '前編' }),
  ] };
  const fbq = new FakeFbq({
    users: { reader: { password: 'secret pass', api: true } },
    files: {
      '/vns/vnshelf-index.json': JSON.stringify(index), '/vns/Brand/ゲームA/gamea.zip': zipBuf,
      '/vns/Brand/Disc Game/DISC.ISO': iso, '/vns/Other/Big Game/big.bin': bigBuf,
    },
  });
  const fbqSrv = await fbq.listen();
  const vndbFake = new FakeVndb();
  const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=';
  vndbFake.vns.set('v501', { title: 'Game A', alttitle: 'ゲームA', image: { url: px, sexual: 0 } });
  vndbFake.vns.set('v502', { title: 'Disc Game', alttitle: 'ディスクゲーム', image: { url: px, sexual: 0 } });
  vndbFake.vns.set('v503', { title: 'Big Game', alttitle: 'ビッグゲーム', image: null });
  const vndbSrv = await vndbFake.listen();
  const result = {};
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.VNS_EXE || require('electron'),
      args: process.env.VNS_EXE ? [] : [path.join(__dirname, '..'), '--no-sandbox'],
      env: (() => {
        const e = { ...process.env, VNS_USER_DATA: userData, VNS_VNDB_API: vndbSrv.url, VNS_NO_UPDATE_CHECK: '1' };
        delete e.ELECTRON_RUN_AS_NODE;
        return e;
      })(),
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForSelector('#sidebar .navitem');

    // ---- before signing in, nothing about the archive shows
    result.hiddenBeforeSignIn = !(await page.locator('#sidebar .navitem:has-text("Archive")').count())
      && await page.evaluate(() => !document.querySelector('#archiveView .card, .downloads'));

    // ---- connect: a wrong password is refused; the right one makes a token and finds the index
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="archive"]');
    await page.fill('#archServer', fbqSrv.url);
    await page.fill('#archUser', 'reader');
    await page.fill('#archPass', 'nope');
    await page.click('.tabpane[data-tab="archive"] button:has-text("Connect")');
    await until('wrong password toast', () => page.locator('#toasts').textContent().then((x) => /password/i.test(x)));
    result.wrongPasswordRefused = true;
    await page.fill('#archPass', 'secret pass');
    await page.click('.tabpane[data-tab="archive"] button:has-text("Connect")');
    await until('connected', () => page.locator('.tabpane[data-tab="archive"]').textContent().then((x) => x.includes('Disconnect')));
    await shot(page, 'a01-settings-archive');
    // Downloads go to a folder of our choosing (the picker is stubbed).
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, downloads);
    await page.click('.tabpane[data-tab="archive"] button:has-text("Change…")');
    await until('download folder shown', () => page.locator('.tabpane[data-tab="archive"]').textContent().then((x) => x.includes('VN downloads')));
    await page.click('#dlg button:has-text("Cancel")');
    const cfg = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
    result.passwordNotStored = !cfg.includes('secret pass') && !fs.readFileSync(path.join(userData, 'archive-token.json'), 'utf8').includes('secret pass');
    result.tokenNotInConfig = ![...fbq.tokens.keys()].some((tk) => cfg.includes(tk));
    result.tokenName = [...fbq.tokens.values()].map((v) => v.name);
    result.sessionClosed = fbq.sessions.size === 0;

    // ---- the Archive view
    await until('Archive in the sidebar', () => page.locator('#sidebar .navitem:has-text("Archive")').count());
    await page.click('#sidebar .navitem:has-text("Archive")');
    await until('archive cards', () => page.locator('#archiveView .card').count().then((n) => n === 3));
    result.cards = await page.$$eval('#archiveView .card', (c) => c.map((x) => `${x.querySelector('.title').textContent} | ${x.querySelector('.sub').textContent}`));
    await shot(page, 'a02-archive');
    await page.fill('#archiveSearch', 'disc');
    await until('search filters', () => page.locator('#archiveView .card').count().then((n) => n === 1));
    await page.fill('#archiveSearch', '');

    // ---- download → unpack → in the library, linked to VNDB
    await page.click('#archiveView .card:has-text("Game A") button');
    await until('installed', () => page.locator('.dlrow.installed').count(), 60000);
    const games = await page.evaluate(() => vns.call('listGames'));
    const ga = games.find((g) => g.vndbId === 'v501');
    result.installed = ga ? { title: ga.title, installed: ga.installed } : null;
    result.unpackedExe = fs.existsSync(path.join(downloads, 'ゲームA', 'ゲームA', 'gamea.exe'));
    result.zipRemoved = !fs.existsSync(path.join(downloads, 'ゲームA', 'gamea.zip'));
    await until('card says In library', () => page.locator('#archiveView .card:has-text("Game A") .badge').textContent().then((x) => /library/i.test(x)));
    await shot(page, 'a03-installed');

    // ---- a disc image: downloaded, then waits for you to install it
    await page.click('#archiveView .card:has-text("Disc Game")');
    await page.waitForSelector('#dlg[open] .archinfo');
    result.infoDialog = await page.textContent('#dlg[open] .archinfo');
    await shot(page, 'a04-info');
    await page.click('#dlg button:has-text("Download")');
    await until('needs install', () => page.locator('.dlrow.needs-install').count());
    result.discKept = fs.existsSync(path.join(downloads, 'ディスクゲーム (初回限定版)', 'DISC.ISO'));

    // ---- pause and resume (slow server), carrying on with a byte range
    fbq.slowMs = 40;
    await page.click('#archiveView .card:has-text("Big Game") button');
    await until('downloading', () => page.locator('.dlrow.downloading').count());
    await until('some progress', () => page.evaluate(() => vns.call('archiveDownloads')).then((l) => (l.find((j) => j.state === 'downloading') || {}).received > 100000));
    await page.click('.dlrow.downloading button[title="Pause"]');
    await until('paused', () => page.locator('.dlrow.paused').count());
    await shot(page, 'a05-paused');
    result.sidebarWhilePaused = await page.textContent('#sidebar .navitem:has-text("Archive")');
    fbq.slowMs = 0;
    await page.click('.dlrow.paused button[title="Resume"]');
    await until('big done', () => page.evaluate(() => vns.call('archiveDownloads')).then((l) => ['done', 'needs-install', 'installed'].includes((l.find((j) => j.title === 'ビッグゲーム') || {}).state)), 60000);
    result.bigIntact = Buffer.compare(fs.readFileSync(path.join(downloads, 'ビッグゲーム 前編', 'big.bin')), bigBuf) === 0;
    result.resumedWithRange = fbq.requests.some((r) => r.query.file === '/vns/Other/Big Game/big.bin' && r.range);

    // ---- disconnect: the entry goes
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="archive"]');
    await page.click('.tabpane[data-tab="archive"] button:has-text("Disconnect")');
    await until('archive gone', () => page.locator('#sidebar .navitem:has-text("Archive")').count().then((n) => n === 0));
    await page.click('#dlg button:has-text("Cancel")');
    result.disconnected = !fs.existsSync(path.join(userData, 'archive-token.json'));
    result.tokenRevoked = fbq.tokens.size === 0;
    result.noArchiveWhenSignedOut = await page.evaluate(() => !document.querySelector('#archiveView .card') && !/Archive/.test(document.querySelector('#sidebar').textContent));

    // ---- a token the server stops accepting signs this PC out: the archive disappears
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="archive"]');
    await page.fill('#archServer', fbqSrv.url);
    await page.fill('#archUser', 'reader');
    await page.fill('#archPass', 'secret pass');
    await page.click('.tabpane[data-tab="archive"] button:has-text("Connect")');
    await until('reconnected', () => page.locator('.tabpane[data-tab="archive"]').textContent().then((x) => x.includes('Disconnect')));
    await page.click('#dlg button:has-text("Cancel")');
    await page.click('#sidebar .navitem:has-text("Archive")');
    await until('archive cards again', () => page.locator('#archiveView .card').count());
    fbq.tokens.clear(); // e.g. the admin removed it
    await page.click('#archiveView button[title="Refresh"]');
    await until('signed out by the server', () => page.locator('#sidebar .navitem:has-text("Archive")').count().then((n) => n === 0));
    result.revokedHidesArchive = await page.evaluate(() => !document.querySelector('#homeView').classList.contains('hidden'));

    // ---- a server without a VN index: the sign-in is undone
    fbq.files.delete('/vns/vnshelf-index.json');
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="archive"]');
    await page.fill('#archServer', fbqSrv.url);
    await page.fill('#archUser', 'reader');
    await page.fill('#archPass', 'secret pass');
    await page.click('.tabpane[data-tab="archive"] button:has-text("Connect")');
    await until('no index toast', () => page.locator('#toasts').textContent().then((x) => /index/i.test(x)));
    result.noIndexNotConnected = !(await page.locator('.tabpane[data-tab="archive"] button:has-text("Disconnect")').count())
      && fbq.tokens.size === 0 && !fs.existsSync(path.join(userData, 'archive-token.json'));
    await page.click('#dlg button:has-text("Cancel")');
    result.stillHidden = !(await page.locator('#sidebar .navitem:has-text("Archive")').count());
    await page.keyboard.press('Escape');

    console.log(JSON.stringify(result, null, 1));
    const bad = Object.entries(result).filter(([, v]) => v === false || v === null);
    if (bad.length) throw new Error(`failed: ${bad.map(([k]) => k).join(', ')}`);
  } catch (e) {
    if (app) {
      const w = await app.firstWindow();
      console.error('jobs:', JSON.stringify(await w.evaluate(() => vns.call('archiveDownloads')).catch(() => null), null, 1));
      await w.screenshot({ path: path.join(shots, 'FAILED.png') }).catch(() => {});
    }
    throw e;
  } finally {
    if (app) await app.close().catch(() => {});
    await fbqSrv.close();
    await vndbSrv.close();
  }
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
