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
game('linked-aaaaaa', { title: 'Linked Game', vndbId: 'v11', vndb: { id: 'v11', description: 'A story.', released: '2020-01-01', length: 'long', languages: ['ja'], platforms: ['win'], tags: [{ id: 'g1', name: 'Romance', rating: 2.5, spoiler: 0 }], fetchedAt: '2026-01-01T00:00:00Z' } });
game('wanted-bbbbbb', { title: 'Wanted Game' });
game('remote-cccccc', { title: 'Remote Game', exe: 'remote.exe' }); // added on the other PC, not set up here
const onlyExe = path.join(base, 'Games', 'OnlyGame', 'only.exe');
write(onlyExe);
const remoteExe = path.join(base, 'Games', 'Remote', 'remote.exe');
write(remoteExe);
const coverPng = path.join(base, 'cover.png');
fs.writeFileSync(coverPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAOCAIAAACZwRr8AAAAE0lEQVR4nGM4YROFBzGMSg82aQCGgL9p8HvqBQAAAABJRU5ErkJggg==', 'base64'));
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
  fake.setEntry('v14', { labels: [10], vn: { title: 'Favourite Elsewhere' } });
  // Game-page extras: Japanese and English screenshot sets (only the Japanese should show), a relation
  // to a game in the library, a spoiler character, staff and a brand.
  const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=';
  const shotOf = (lang) => ({ url: px, thumbnail: px, dims: [800, 600], thumbnail_dims: [136, 102], release: { languages: [{ lang }] } });
  fake.extras.set('v11', {
    screenshots: [shotOf('en'), shotOf('ja'), shotOf('ru'), shotOf('ja')],
    relations: [{ id: 'v13', relation: 'seq', relation_official: true, title: 'Wanted Game', released: '2021-01-01' }, { id: 'v99', relation: 'fan', relation_official: true, title: 'A Fandisc', released: '2022-01-01' },
      ...Array.from({ length: 14 }, (_, i) => ({ id: `v${200 + i}`, relation: 'set', relation_official: true, title: `Same Setting ${i + 1}`, released: '2023-01-01' }))],
    staff: [{ id: 's1', name: 'Writer Person', original: '書き手', role: 'scenario', note: null }],
    developers: [{ id: 'p1', name: 'Brand Co', original: 'ブランド' }],
  });
  const cv = (n, type) => ({ url: `https://t.vndb.org/cv/${n}.jpg`, thumbnail: px, type, sexual: 0 });
  fake.vns.set('v11', { title: 'Linked Game', image: cv(1) });
  fake.releases.set('v11', [{ engine: 'SiglusEngine', official: true, platforms: ['win'], languages: [{ lang: 'ja' }], images: [cv(2, 'pkgfront'), cv(3, 'pkgback')] }]);
  fake.characters.set('v11', [
    { id: 'c1', name: 'Heroine', original: 'ヒロイン', vns: [{ id: 'v11', role: 'primary', spoiler: 0 }], traits: [{ id: 'i1', name: 'Kind', group_name: 'Personality', spoiler: 0 }] },
    { id: 'c2', name: 'Twist', vns: [{ id: 'v11', role: 'main', spoiler: 2 }], traits: [] },
  ]);
  fake.works.set('s1', [{ id: 'v11', title: 'Linked Game', released: '2020-01-01', staff: [{ id: 's1', role: 'scenario' }] }, { id: 'v77', title: 'Another Work', released: '2019-01-01', staff: [{ id: 's1', role: 'scenario' }] }]);
  fake.names.set('s1', { name: 'Writer Person', original: '書き手' });
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

    // ---- a category that's a VNDB label lists the label's VNs that aren't in the library, on their own row
    await page.click('.navitem:has-text("Favourites")');
    await until('list-only row', () => page.locator('#listOnly .listcard').count().then((n) => n === 1));
    result.listOnlyRow = {
      own: await page.locator('#grid .card').count(),
      below: await page.locator('#listOnly .listcard').textContent(),
      separate: await page.evaluate(() => document.querySelector('#listOnly').getBoundingClientRect().top >= document.querySelector('#grid .card:last-child').getBoundingClientRect().bottom),
    };
    if (result.listOnlyRow.own !== 1 || !result.listOnlyRow.below.includes('Favourite Elsewhere') || !result.listOnlyRow.separate) throw new Error(`list-only row wrong: ${JSON.stringify(result.listOnlyRow)}`);
    await shot(page, '02b-category-with-list');
    await page.uncheck('#libToolbar input[type=checkbox]');
    await until('row hidden', () => page.locator('#listOnly .listcard').count().then((n) => n === 0));
    result.listOnlyHidden = true;
    await page.click('#settingsBtn');
    await page.click('.tab[data-tab="vndb"]');
    await page.check('.tabpane[data-tab="vndb"] input[type=checkbox]');
    await page.click('#dlg button:has-text("Cancel")');
    await until('row back', () => page.locator('#listOnly .listcard').count().then((n) => n === 1));

    // ---- Your VNDB list: VNs not in the library; one can be linked to "Wanted Game"
    await page.click('.navitem:has-text("Your VNDB list")');
    await until('list cards', () => page.locator('#vndbView .listcard').count().then((n) => n === 3));
    result.listSaved = fs.existsSync(path.join(userData, 'vndb-list-view.json'));
    await shot(page, '03-vndb-list');
    await page.click('#vndbView button:has-text("Link to")');
    await until('linked', () => readGame('wanted-bbbbbb').vndbId === 'v13');
    await until('linked game pulled', () => readGame('wanted-bbbbbb').status === 'finished');
    result.linked = { vndbId: readGame('wanted-bbbbbb').vndbId, status: readGame('wanted-bbbbbb').status, vote: readGame('wanted-bbbbbb').vote };
    await until('two cards left', () => page.locator('#vndbView .listcard').count().then((n) => n === 2));
    // + Add asks where the game is first: cancelling adds nothing, picking the .exe adds it set up here.
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await page.click('#vndbView .listcard:has-text("Only On The List") button:has-text("+ Add")');
    await sleep(1500);
    if (fs.readdirSync(path.join(cloudDir, 'games')).map(readGame).some((x) => x.vndbId === 'v12')) throw new Error('cancelled Add still added the game');
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, onlyExe);
    await page.click('#vndbView .listcard:has-text("Only On The List") button:has-text("+ Add")');
    const added = await until('added from list', () => {
      const ids = fs.readdirSync(path.join(cloudDir, 'games')).filter((n) => !n.startsWith('.'));
      const g = ids.map(readGame).find((x) => x.vndbId === 'v12');
      return g && g.status === 'wishlist' ? g : null;
    });
    result.added = { title: added.title, status: added.status, exePath: JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).games[added.id].exePath };
    if (result.added.exePath !== onlyExe) throw new Error(`added game not set up on this PC: ${result.added.exePath}`);

    // ---- adding a game the other PC already added offers to set it up here
    const ex = await page.evaluate((f) => window.vns.call('addGame', f), remoteExe);
    if (!ex.existing || ex.existing.id !== 'remote-cccccc') throw new Error(`no "already in your library": ${JSON.stringify(ex)}`);
    await page.evaluate((f) => window.vns.call('setUpHere', 'remote-cccccc', f), remoteExe);
    result.setUpHere = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).games['remote-cccccc'].exePath === remoteExe;
    if (!result.setUpHere) throw new Error('setUpHere did not set the program');
    await until('one card left', () => page.locator('#vndbView .listcard').count().then((n) => n === 1));

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

    // ---- VNDB extras on the game page
    await page.waitForSelector('.vnextras h2:has-text("Characters")', { timeout: 20000 });
    result.extras = {
      sections: await page.$$eval('.vnextras h2', (x) => x.map((y) => y.textContent)),
      screenshots: await page.locator('.xshots .shot').count(),
      related: await page.$$eval('.vnextras .card.mini', (x) => x.map((y) => y.textContent)),
      characters: await page.locator('.vnextras .charcard').count(),
    };
    // Layout: rating & dates in the header, Categories first on the right, screenshots and staff in
    // About, both panels the same height, Related and Characters side by side with Show more.
    result.layout = await page.evaluate(() => {
      const [l, r] = document.querySelectorAll('.panels > .panel');
      const about = l.querySelector('.box');
      const xs = [...document.querySelectorAll('.xcols > .xcol')];
      return {
        listInHero: !!document.querySelector('.hero .herolist .listfields select'),
        firstRight: r.querySelector('h2').textContent,
        notesRight: [...r.querySelectorAll('h2')].map((x) => x.textContent).join('|').search(/notes/i) < [...r.querySelectorAll('h2')].map((x) => x.textContent).join('|').search(/launch/i) && !!r.querySelector('.notesbox'),
        shotsInAbout: !!about.querySelector('.xshots .shot'),
        shotsBeforeFacts: about.querySelector('.xshots').compareDocumentPosition(about.querySelector('.facts')) === Node.DOCUMENT_POSITION_FOLLOWING,
        staffAfterTags: about.querySelector('.tags').compareDocumentPosition(about.querySelector('.xstaff')) === Node.DOCUMENT_POSITION_FOLLOWING,
        panelHeights: [l.getBoundingClientRect().bottom, r.getBoundingClientRect().bottom, l.lastElementChild.getBoundingClientRect().bottom, r.lastElementChild.getBoundingClientRect().bottom].map(Math.round),
        cols: xs.map((x) => [x.querySelector('h2').textContent, Math.round(x.getBoundingClientRect().left)]),
        relatedShown: xs[0].querySelectorAll('.card.mini:not([hidden])').length,
        relatedAll: xs[0].querySelectorAll('.card.mini').length,
        moreBtn: (xs[0].querySelector('.morebtn:not([hidden])') || {}).textContent || null,
      };
    });
    const L = result.layout;
    if (!L.listInHero || !/categories/i.test(L.firstRight) || !L.notesRight || !L.shotsInAbout || !L.shotsBeforeFacts || !L.staffAfterTags) throw new Error(`layout wrong: ${JSON.stringify(L)}`);
    if (Math.abs(L.panelHeights[2] - L.panelHeights[3]) > 2) throw new Error(`panels end at different heights: ${L.panelHeights}`);
    if (L.cols.length !== 2 || L.cols[0][1] === L.cols[1][1]) throw new Error(`related/characters not side by side: ${JSON.stringify(L.cols)}`);
    if (!(L.relatedShown < L.relatedAll) || !L.moreBtn) throw new Error(`related not limited: ${JSON.stringify(L)}`);
    await page.click('.xcol:has-text("Related") .morebtn');
    result.layout.relatedAfterMore = await page.locator('.xcol:has-text("Related") .card.mini:visible').count();
    if (result.layout.relatedAfterMore !== L.relatedAll) throw new Error('Show more did not show every related VN');
    await page.click('.xcol:has-text("Related") .morebtn');
    await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
    await shot(page, '05a-layout-top');
    await page.locator('.xstaff').scrollIntoViewIfNeeded();
    await shot(page, '05c-layout-middle');
    await page.locator('.xcols').scrollIntoViewIfNeeded();
    await shot(page, '05b-layout-bottom');
    // ---- Change cover: VNDB's covers to pick from, or your own image cropped to fit
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, coverPng);
    await page.click('button:has-text("Change cover")');
    await until('covers listed', () => page.locator('.coverpick .coveropt').count().then((n) => n === 2));
    await shot(page, '05d-cover-picker');
    await page.click('#dlg button:has-text("Upload image")');
    await page.waitForSelector('.cropframe');
    await page.locator('.cropzoom input').fill('2');
    await shot(page, '05e-crop');
    await page.click('#dlg button:has-text("Use this")');
    result.cover = await until('cropped cover saved', () => { const g = readGame('linked-aaaaaa'); return g.cover === 'cover.jpg' ? g.cover : null; });
    // No engine known from the files, so the hero shows VNDB's.
    result.extras.engine = await page.locator('.hero .vndbengine').textContent();
    if (result.extras.engine !== 'Engine (VNDB): SiglusEngine') throw new Error(`VNDB engine not shown: ${result.extras.engine}`);
    if (result.extras.screenshots !== 2) throw new Error(`expected the 2 Japanese screenshots, got ${result.extras.screenshots}`);
    if (result.extras.characters !== 1) throw new Error('spoiler character should be hidden');
    if (!result.extras.related.some((x) => x.includes('Wanted Game') && x.includes('In your library'))) throw new Error('related game not marked as in the library');
    await page.click('.xshots .shot >> nth=0');
    await page.waitForSelector('.lightbox');
    await page.keyboard.press('ArrowRight');
    result.lightboxCount = await page.textContent('.lightbox .lbcount');
    await page.keyboard.press('Escape');
    result.lightboxClosedStaysOnPage = !(await page.$('.lightbox')) && await page.isVisible('#detailView');
    await page.click('.vnextras button:has-text("Show 1 spoiler characters")');
    result.spoilerShown = await page.locator('.vnextras .charcard').count();
    await page.click('.vnextras .charcard >> nth=0');
    await page.waitForSelector('.chardlg');
    result.characterDialog = await page.textContent('.chardlg');
    await page.click('#dlg button:has-text("Close")');
    await page.locator('.xstaff .person:has-text("書き手")').scrollIntoViewIfNeeded();
    await shot(page, '05-extras');
    await page.click('.xstaff .person:has-text("書き手")');
    await page.waitForSelector('#worksView .card.mini');
    result.works = await page.$$eval('#worksView .card.mini', (x) => x.map((y) => y.textContent));
    await shot(page, '06-works');
    await page.click('#backBtn');
    await page.waitForSelector('#detailView:not(.hidden)');

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
    const bad = ['lightboxClosedStaysOnPage', 'bothStatuses', 'badTokenRefused', 'tokenNotInConfig', 'tokenNotShared', 'tokenRemoved', 'sidebarGone'].filter((k) => !result[k]);
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
