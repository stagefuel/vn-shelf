'use strict';
// Builds a demo library and captures the README / wiki screenshots into docs/screenshots/.
// Linux: DISPLAY=:97 node scripts/screenshots.js   (needs internet for VNDB covers)
// Only titles whose VNDB cover is rated safe (image.sexual < 0.5) are used.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
// A fixed, tidy demo folder so paths shown on game pages look clean.
const base = path.join(os.tmpdir(), 'demo');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const home = base;
const appdata = path.join(home, '.config');
const cloud = path.join(base, '.cloud');
fs.mkdirSync(appdata, { recursive: true });
fs.mkdirSync(cloud, { recursive: true });
fs.symlinkSync(cloud, path.join(home, 'Dropbox'));
const write = (p, s = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// folder name → VNDB id (all covers rated safe on VNDB)
const DEMO = [
  ['STEINS;GATE', 'v2002', 'kirikiri'], ['Muv-Luv Alternative', 'v92', 'save'], ['Umineko no Naku Koro ni', 'v24', 'save'],
  ['Fate stay night', 'v11', 'kirikiri'], ['CLANNAD', 'v4', 'save'], ['Little Busters!', 'v5', 'save'],
  ['Higurashi no Naku Koro ni', 'v67', 'save'], ['Rewrite', 'v751', 'save'], ['Summer Pockets', 'v20424', 'save'],
  ['神咒神威神楽', 'v5844', 'kirikiri'], ['装甲悪鬼村正', 'v2016', 'save'], ['WHITE ALBUM2', 'v7771', 'save'],
  ['素晴らしき日々', 'v3144', 'bgi'], ['うたわれるもの', 'v3', 'save'],
];
const vnDir = path.join(home, 'Games', 'Visual novels');
for (const [name, , kind] of DEMO) {
  const d = path.join(vnDir, name);
  write(path.join(d, `${name.replace(/[^\w]+/g, '').slice(0, 12) || 'game'}.exe`), Buffer.alloc(2048));
  if (kind === 'kirikiri') { write(path.join(d, 'data.xp3')); write(path.join(d, 'savedata', 'save001.dat'), 'x'); }
  if (kind === 'bgi') { write(path.join(d, 'BGI.exe'), Buffer.alloc(4096)); write(path.join(d, 'UserData', 'save001.dat'), 'x'); }
  if (kind === 'save') write(path.join(d, 'save', 'save01.dat'), 'x');
}

async function launch() {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: appdata, XDG_DATA_HOME: path.join(home, '.local/share'), VNS_NO_UPDATE_CHECK: '1' };
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), '--no-sandbox'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  return { app, page };
}
const shot = async (page, name) => { await sleep(700); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('saved', name); };
const mockOpen = (app, f) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f);

(async () => {
  let { app, page } = await launch();
  await page.waitForSelector('dialog[open] .choice');
  await page.fill('dialog input[type=text]', 'Desktop');
  await page.click('dialog .choice:has-text("Dropbox")');
  await shot(page, 'setup');
  await page.click('dialog button:has-text("Start")');
  await page.waitForSelector('#empty:not(.hidden)');

  await page.evaluate(() => vns.call('saveSettings', { allowUmineko: true }));

  // The import dialog, as a user sees it.
  await mockOpen(app, vnDir);
  await page.click('#importBtn');
  await page.waitForSelector('dialog[open] .irow');
  await page.waitForFunction(() => ![...document.querySelectorAll('dialog .irow')].some((r) => r.textContent.includes('Matching on VNDB')), null, { timeout: 120000 });
  await page.evaluate(() => { document.querySelector('dialog .dbody').scrollTop = 0; });
  await shot(page, 'import');
  await page.click('dialog[open] button:has-text("Cancel")');

  // The real import, matched by exact VNDB id.
  const items = await page.evaluate(async ({ demo, dir }) => {
    const found = await vns.call('scanImport', dir);
    const out = [];
    for (const f of found) {
      const row = demo.find(([name]) => f.dir.endsWith(name));
      const match = row ? await vns.call('vndbBestMatch', row[1]) : null;
      out.push({ exe: f.exe, dir: f.dir, title: f.title, match });
      await new Promise((r) => setTimeout(r, 300));
    }
    return out;
  }, { demo: DEMO, dir: vnDir });
  await page.evaluate((list) => vns.call('importGames', list), items);
  const games = await page.evaluate(() => vns.call('listGames'));
  const byV = Object.fromEntries(games.map((g) => [g.vndbId, g]));
  const setCats = async (v, cats, notes) => page.evaluate(({ id, c, n }) => vns.call('updateGame', id, { categories: c, ...(n ? { notes: n } : {}) }), { id: byV[v].id, c: cats, n: notes });
  await setCats('v2002', ['Favourites', 'Reading'], 'Route: Kurisu → True End next.\nStopped at chapter 8 (Okabe at the lab).');
  await setCats('v92', ['Favourites', 'Finished']);
  await setCats('v24', ['Reading']);
  await setCats('v5844', ['Reading']);
  await setCats('v4', ['Finished']);
  await setCats('v3144', ['Favourites']);
  await app.close();

  // Give a few games some play history on this PC, then reopen.
  const cfgFile = path.join(appdata, 'VN Shelf', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const played = ['v2002', 'v5844', 'v24', 'v92', 'v3144', 'v2016', 'v7771', 'v11'];
  played.forEach((v, i) => {
    const g = byV[v];
    if (!g) return;
    cfg.games[g.id].lastPlayed = new Date(Date.now() - (i * 5 + 1) * 3600 * 1000).toISOString();
    cfg.games[g.id].playMinutes = [1260, 420, 960, 3100, 2200, 180, 1500, 600][i];
  });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

  ({ app, page } = await launch());
  await page.waitForSelector('#homeView .recentrow .card');
  // Upload everyone's demo saves so the covers read "Synced".
  await page.evaluate(async () => { for (const g of await vns.call('listGames')) await vns.call('syncNow', g.id).catch(() => {}); });
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.click('#sidebar .navitem:has-text("Home")');
  await page.waitForTimeout(2500);
  await page.waitForTimeout(1500);
  await shot(page, 'home');

  await page.click('#sidebar .navitem:has-text("All games")');
  await page.selectOption('.sortsel', 'rating');
  await page.waitForTimeout(1200);
  await shot(page, 'library');

  await page.click('#sidebar .navitem:has-text("Favourites")');
  await shot(page, 'category');

  await page.click('#sidebar .navitem:has-text("All games")');
  await page.click('#grid .card:has-text("STEINS;GATE")');
  await page.waitForSelector('#detailView .desc');
  await page.waitForTimeout(1500);
  await shot(page, 'game');
  await page.evaluate(() => { document.querySelector('main').scrollTop = 420; });
  await shot(page, 'game-details');

  // A blurred cover as the app background.
  const cover = path.join(cloud, 'VNShelf', 'games', byV.v11.id, byV.v11.cover || 'cover.jpg');
  await mockOpen(app, cover);
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="look"]');
  await page.waitForSelector('dialog[open] .bgedit');
  await page.click('dialog[open] .bgedit button:has-text("Choose image")');
  await page.waitForSelector('dialog[open] .bgthumb');
  await page.evaluate(() => {
    const [dim, blur] = document.querySelectorAll('dialog[open] .bgedit input[type=range]');
    dim.value = '0.62'; dim.dispatchEvent(new Event('input')); dim.dispatchEvent(new Event('change'));
    blur.value = '14'; blur.dispatchEvent(new Event('input')); blur.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(600);
  await shot(page, 'settings');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.click('#sidebar .navitem:has-text("Home")');
  await shot(page, 'home-background');

  // Japanese interface.
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="general"]');
  await page.selectOption('dialog[open] select >> nth=0', 'ja');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForSelector('#sidebar .navitem:has-text("ホーム")');
  await page.click('#sidebar .navitem:has-text("すべてのゲーム")');
  await page.click('#grid .card:has-text("Kajiri")');
  await page.waitForSelector('#detailView .desc');
  await page.waitForTimeout(1500);
  await shot(page, 'game-ja');

  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
})().catch(async (e) => { console.error('SCREENSHOTS FAILED', e); process.exit(1); });
