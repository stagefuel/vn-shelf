'use strict';
// End-to-end check of the VNDB list sync against a stand-in VNDB (test/helpers/fake-vndb.js):
// connect with a token, pull status/labels/rating, the "Your VNDB list" view with Add and Link,
// a status and rating change sent to VNDB, and a change made on VNDB coming back with Sync now.
// Linux: DISPLAY=:97 node scripts/ui-smoke-vndb.js <shots dir>     (no internet needed)
// Windows / a packaged build: set VNS_EXE to the app's .exe.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeVndb } = require('../test/helpers/fake-vndb');

const shots = path.resolve(process.argv[2] || 'shots-vndb');
fs.mkdirSync(shots, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-uiv-'));
const shot = (page, n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
const write = (p, s = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

const cloudDir = path.join(base, 'shared', 'VNShelf');
const userData = path.join(base, 'settings');
const game = (id, fields) => write(path.join(cloudDir, 'games', id, 'game.json'), JSON.stringify({
  id, cover: null, exe: null, engine: null, saves: [], launch: { useLocaleEmulator: false, args: '' }, status: '', categories: [],
  titleAlt: '', developer: '', vndbId: null, addedAt: '2026-10-01T00:00:00.000Z', titleSource: 'user', ...fields,
}));
game('linked-aaaaaa', { title: 'Linked Game', vndbId: 'v11' });
game('wanted-bbbbbb', { title: 'Wanted Game' });
write(path.join(userData, 'config.json'), JSON.stringify({ cloudDir, backend: 'folder', deviceName: 'PC1', autoUpdate: false }));
const readGame = (id) => JSON.parse(fs.readFileSync(path.join(cloudDir, 'games', id, 'game.json'), 'utf8'));

async function until(what, fn, ms = 20000) {
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
  const fake = new FakeVndb();
  fake.addLabel(10, 'Favourites');
  fake.setEntry('v11', { labels: [1, 10], vote: 80, started: '2026-01-01', vn: { title: 'Linked Game' } });
  fake.setEntry('v12', { labels: [5], vn: { title: 'Only On The List' } });
  fake.setEntry('v13', { labels: [2], vote: 70, vn: { title: 'Wanted Game' } });
  const srv = await fake.listen();
  const result = {};
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.VNS_EXE || require('electron'),
      args: process.env.VNS_EXE ? [] : [path.join(__dirname, '..'), '--no-sandbox'],
      env: (() => {
        const e = { ...process.env, VNS_USER_DATA: userData, VNS_VNDB_API: srv.url, VNS_NO_UPDATE_CHECK: '1' };
        delete e.ELECTRON_RUN_AS_NODE;
        return e;
      })(),
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForSelector('.card, .homehero h1');

    // ---- connect: a wrong token is refused, the right one connects and the first sync pulls
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="vndb"]');
    await shot(page, '01-settings-vndb');
    await page.fill('input[type=password]', 'wrong');
    await page.click('button:has-text("Connect")');
    await until('bad token toast', () => page.locator('#toasts').textContent().then((x) => /token/i.test(x)));
    result.badTokenRefused = true;
    await page.fill('input[type=password]', fake.token);
    await page.click('button:has-text("Connect")');
    await until('connected', () => page.locator('.tabpane[data-tab="vndb"]').textContent().then((x) => x.includes('reader')));
    await until('first sync pulled', () => readGame('linked-aaaaaa').status === 'playing');
    const g1 = readGame('linked-aaaaaa');
    result.pulled = { status: g1.status, categories: g1.categories, vote: g1.vote, started: g1.started };
    if (g1.vote !== 80 || g1.categories[0] !== 'Favourites' || g1.started !== '2026-01-01') throw new Error(`pull wrong: ${JSON.stringify(result.pulled)}`);
    await until('labels listed', () => page.locator('.tabpane[data-tab="vndb"]').textContent().then((x) => x.includes('Favourites')));
    await shot(page, '02-settings-connected');
    await page.click('#dlg button:has-text("Cancel")');
    result.tokenEncryptedOrPlain = fs.existsSync(path.join(userData, 'vndb-token.json'));
    result.tokenNotInConfig = !fs.readFileSync(path.join(userData, 'config.json'), 'utf8').includes(fake.token);
    result.tokenNotShared = !JSON.stringify(fs.readdirSync(cloudDir, { recursive: true })).includes('vndb');

    // ---- Your VNDB list: two VNs not in the library; one can be linked to "Wanted Game"
    await page.click('.navitem:has-text("Your VNDB list")');
    await until('list cards', () => page.locator('#vndbView .listcard').count().then((n) => n === 2));
    await shot(page, '03-vndb-list');
    await page.click('#vndbView button:has-text("Link to")');
    await until('linked', () => readGame('wanted-bbbbbb').vndbId === 'v13');
    await until('linked game pulled', () => readGame('wanted-bbbbbb').status === 'finished');
    result.linked = { vndbId: readGame('wanted-bbbbbb').vndbId, status: readGame('wanted-bbbbbb').status, vote: readGame('wanted-bbbbbb').vote };
    await until('one card left', () => page.locator('#vndbView .listcard').count().then((n) => n === 1));
    await page.click('#vndbView button:has-text("+ Add")');
    const added = await until('added from list', () => {
      const ids = fs.readdirSync(path.join(cloudDir, 'games')).filter((n) => !n.startsWith('.'));
      const g = ids.map(readGame).find((x) => x.vndbId === 'v12');
      return g && g.status === 'wishlist' ? g : null;
    });
    result.added = { title: added.title, status: added.status };
    await until('list empty', () => page.locator('#vndbView .empty').count().then((n) => n === 1));

    // ---- game page: status → Finished fills the date and goes to VNDB; rating too
    await page.click('.navitem:has-text("All games")');
    await page.click('#grid .card:has-text("Linked Game")');
    // Statuses are labels: ticking Finished keeps Playing (on VNDB too); unticking Reading takes only that off.
    await page.waitForSelector('.statussel');
    await page.click('.statussel');
    await page.click('.statusmenu label:has-text("Finished")');
    await until('finished date filled', () => readGame('linked-aaaaaa').finished === today);
    await until('Finished added on VNDB, Playing kept', () => { const e = fake.entry('v11'); return e.labels.includes(1) && e.labels.includes(2); }, 30000);
    result.bothStatuses = fake.entry('v11').labels;
    await shot(page, '04a-status-menu');
    await page.click('.statusmenu label:has-text("Reading")');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.listfields select');
    await page.selectOption('.listfields select', '90');
    await until('sent to VNDB', () => {
      const e = fake.entry('v11');
      return e.labels.includes(2) && !e.labels.includes(1) && e.vote === 90 && e.finished === today;
    }, 30000);
    result.pushed = fake.entry('v11');
    await page.locator('.listfields').scrollIntoViewIfNeeded();
    await shot(page, '04-game-page');

    // ---- a change made on VNDB comes back with Sync now
    fake.setEntry('v11', { labels: [2, 7, 10], vote: 50, started: '2026-01-01', finished: today, vn: { title: 'Linked Game' } });
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="vndb"]');
    await page.click('.tabpane[data-tab="vndb"] button:has-text("Sync with VNDB now")');
    await until('vote pulled', () => readGame('linked-aaaaaa').vote === 50);
    result.pulledAfterWebsiteChange = readGame('linked-aaaaaa').vote;
    await page.click('#dlg button:has-text("Cancel")');

    // ---- disconnect forgets the token
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="vndb"]');
    await page.click('.tabpane[data-tab="vndb"] button:has-text("Disconnect")');
    await until('disconnected', () => page.locator('.tabpane[data-tab="vndb"] input[type=password]').count().then((n) => n === 1));
    result.tokenRemoved = !fs.existsSync(path.join(userData, 'vndb-token.json'));
    await page.click('#dlg button:has-text("Cancel")');
    result.sidebarGone = (await page.locator('.navitem:has-text("Your VNDB list")').count()) === 0;
    console.log(JSON.stringify(result, null, 2));
    const bad = ['bothStatuses', 'badTokenRefused', 'tokenNotInConfig', 'tokenNotShared', 'tokenRemoved', 'sidebarGone'].filter((k) => !result[k]);
    if (bad.length) throw new Error(`failed: ${bad.join(', ')}`);
    console.log('VNDB SMOKE OK');
  } catch (e) {
    console.error('VNDB SMOKE FAILED:', e.message);
    console.log(JSON.stringify(result, null, 2));
    try { const p = app && (await app.firstWindow()); if (p) await shot(p, 'zz-failure'); } catch { /* none */ }
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    await srv.close();
  }
})();
