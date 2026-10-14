'use strict';
// End-to-end check of the library features: update pop-up, bulk import with VNDB matching,
// tags, categories, sorting, notes, companion tools, save export/import and the Japanese UI.
// Linux: DISPLAY=:97 node scripts/ui-smoke-features.js <shots dir>   (needs internet for VNDB)
// Windows / a packaged build: set VNS_EXE to the app's .exe.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZip } = require('../src/core/zip');

const WIN = process.platform === 'win32';
const shots = path.resolve(process.argv[2] || 'shots-features');
fs.mkdirSync(shots, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-uif-'));
let lastPage = null;
const shot = (page, n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
const write = (p, s = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = path.join(base, 'Desktop');
const cloudRoot = path.join(base, 'shared');
fs.mkdirSync(cloudRoot, { recursive: true });
const appdata = WIN ? path.join(home, 'Roaming') : path.join(home, '.config');
const env = WIN
  ? { APPDATA: appdata, LOCALAPPDATA: path.join(home, 'Local'), VNS_USER_DATA: path.join(home, 'vnshelf-settings') }
  : { HOME: home, XDG_CONFIG_HOME: appdata, XDG_DATA_HOME: path.join(home, '.local/share') };
fs.mkdirSync(appdata, { recursive: true });
if (WIN) {
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  write(path.join(appdata, 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: cloudRoot } }));
} else {
  fs.symlinkSync(cloudRoot, path.join(home, 'Dropbox'));
}

// A VN folder to import: two games (one with saves already), plus things that aren't games.
const vn = path.join(home, 'VN');
write(path.join(vn, 'light', '[light] 神咒神威神楽', 'kkk.exe'), Buffer.alloc(2048));
write(path.join(vn, 'light', '[light] 神咒神威神楽', 'data.xp3'));
write(path.join(vn, 'light', '[light] 神咒神威神楽', 'savedata', 'save001.dat'), 'K3 progress');
write(path.join(vn, 'Setoguchi', 'SWAN SONG', 'swansong.exe'), Buffer.alloc(4096));
write(path.join(vn, 'Setoguchi', 'SWAN SONG', 'data.xp3'));
write(path.join(vn, 'Installers', 'setup.exe'), Buffer.alloc(100));
write(path.join(vn, 'Cracker.exe'), Buffer.alloc(100));
const k3Save = path.join(vn, 'light', '[light] 神咒神威神楽', 'savedata', 'save001.dat');

// A runnable game and a companion tool for the tools check.
const toolMark = path.join(base, 'tool-started.txt');
let runGame;
let toolPath;
if (WIN) {
  runGame = path.join(home, 'Games', 'Tool Test', 'tooltest.cmd');
  write(runGame, '@echo off\r\nping -n 5 127.0.0.1 > nul\r\n');
  toolPath = path.join(home, 'Tools', 'hooker.cmd');
  write(toolPath, `@echo off\r\necho started> "${toolMark}"\r\nping -n 60 127.0.0.1 > nul\r\n`);
} else {
  runGame = path.join(home, 'Games', 'Tool Test', 'tooltest.sh');
  write(runGame, '#!/bin/sh\nsleep 4\n');
  fs.chmodSync(runGame, 0o755);
  toolPath = path.join(home, 'Tools', 'hooker.sh');
  write(toolPath, `#!/bin/sh\necho $$ > "${toolMark}"\nsleep 60\n`);
  fs.chmodSync(toolPath, 0o755);
}
const zipOut = path.join(base, 'k3-saves.zip');

(async () => {
  const result = {};
  const app = await electron.launch({
    executablePath: process.env.VNS_EXE || require('electron'),
    args: process.env.VNS_EXE ? [] : [path.join(__dirname, '..'), '--no-sandbox'],
    env: (() => {
      const e = { ...process.env, ...env, VNS_FAKE_UPDATE: JSON.stringify({ version: '9.9.9', notes: 'A big update\n- New things', page: 'https://github.com/stagefuel/vn-shelf/releases', asset: null }) };
      delete e.ELECTRON_RUN_AS_NODE;
      return e;
    })(),
  });
  const page = await app.firstWindow();
  lastPage = page;
  await page.setViewportSize({ width: 1280, height: 820 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const mockOpen = (p) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, p);

  // ---- first run
  await page.waitForSelector('dialog[open] .choice');
  await page.fill('dialog input[type=text]', 'Desktop');
  await page.click('dialog .choice:has-text("Dropbox")');
  await page.click('dialog button:has-text("Start")');
  await page.waitForSelector('#empty:not(.hidden)');

  // ---- update pop-up (fake release), then hide it
  await page.waitForSelector('.updatepop', { timeout: 15000 });
  await shot(page, 'f01-update-popup');
  result.updatePopup = await page.textContent('.updatepop .t');
  await page.click('.updatepop button:has-text("Hide")');
  result.updatePopupHidden = (await page.$('.updatepop')) === null;
  result.updatePill = await page.textContent('#updatePill');

  // ---- bulk import
  await mockOpen(vn);
  await page.click('#importBtn');
  await page.waitForSelector('dialog[open] .irow', { timeout: 30000 });
  result.importFound = await page.$$eval('dialog .irow', (r) => r.length);
  await page.waitForFunction(() => !document.querySelector('dialog .irow .faint.small') || ![...document.querySelectorAll('dialog .irow')].some((r) => r.textContent.includes('Matching on VNDB')), null, { timeout: 90000 });
  await sleep(500);
  await shot(page, 'f02-import-list');
  result.importMatches = await page.$$eval('dialog .irow .match .t', (r) => r.map((x) => x.textContent));
  await page.click('dialog button:has-text("Import selected")');
  await page.waitForSelector('dialog[open] h3:has-text("Imported")', { timeout: 120000 });
  result.importSummary = await page.textContent('dialog[open] .dhead');
  await shot(page, 'f03-import-done');
  await page.click('dialog[open] button:has-text("OK")');
  await page.waitForSelector('.card', { timeout: 20000 });
  result.cards = await page.$$eval('#grid .card', (c) => c.length);

  // ---- game page: VNDB info and tags
  await page.click('#grid .card:has-text("Kagura"), #grid .card:has-text("神咒")');
  await page.waitForSelector('#detailView .desc', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, 'f04-detail-about');
  result.k3SaveFolder = await page.textContent('.panel .row .path');
  result.tags = await page.$$eval('.tags .tagbtn', (b) => b.slice(0, 5).map((x) => x.textContent));
  const firstTag = result.tags[0];
  await page.click('.tags .tagbtn >> nth=0');
  await page.waitForSelector('#libraryView:not(.hidden) .libtoolbar h1');
  result.tagFilterHeading = await page.textContent('.libtoolbar h1');
  result.tagFilterCount = await page.$$eval('#grid .card', (c) => c.length);
  await shot(page, 'f05-tag-filter');

  // ---- categories
  await page.click('#grid .card >> nth=0');
  await page.waitForSelector('#detailView button.chip.add');
  await page.click('#detailView button.chip.add');
  await page.fill('dialog[open] input', 'Reading');
  await page.click('dialog[open] button:has-text("Add")');
  await page.waitForSelector('#sidebar .navitem:has-text("Reading")');
  await page.click('#sidebar .navitem:has-text("Reading")');
  await page.waitForSelector('.libtoolbar h1:has-text("Reading")');
  result.categoryCount = await page.$$eval('#grid .card', (c) => c.length);
  await shot(page, 'f06-category');

  // ---- sorting
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.selectOption('.sortsel', 'rating');
  await page.waitForTimeout(500);
  result.sortOrder = await page.$$eval('#grid .card .title', (t) => t.map((x) => x.textContent));
  result.sortSaved = await page.evaluate(() => vns.call('getSetup').then((s) => s.settings.sort));

  // ---- notes
  await page.click('#grid .card:has-text("Kagura"), #grid .card:has-text("神咒")');
  await page.waitForSelector('textarea.notes');
  await page.fill('textarea.notes', 'Route A done.\nOn chapter 3.');
  await page.click('.panel h2 >> nth=0');
  await page.waitForSelector('text=Saved', { timeout: 10000 });
  const gameDirs = fs.readdirSync(path.join(cloudRoot, 'VNShelf', 'games')).filter((d) => !d.startsWith('.'));
  result.notesSynced = gameDirs.some((d) => {
    try { return JSON.parse(fs.readFileSync(path.join(cloudRoot, 'VNShelf', 'games', d, 'game.json'), 'utf8')).notes === 'Route A done.\nOn chapter 3.'; } catch { return false; }
  });

  // ---- save export, change the save, import it back
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, zipOut);
  await page.click('button:has-text("Export saves")');
  await page.waitForSelector('.toast.good:has-text("Exported")', { timeout: 15000 });
  result.exportedEntries = readZip(fs.readFileSync(zipOut)).map((e) => e.name);
  fs.writeFileSync(k3Save, 'something else');
  await mockOpen(zipOut);
  await page.click('button:has-text("Import saves")');
  await page.waitForSelector('.toast.good:has-text("Imported")', { timeout: 20000 });
  result.saveAfterImport = fs.readFileSync(k3Save, 'utf8');
  await page.waitForTimeout(1000);
  result.historyKinds = await page.$$eval('.panel .box .row .grow > div:first-child', (r) => r.map((x) => x.textContent).filter((x) => /Backup|Uploaded/.test(x)));
  await shot(page, 'f07-after-import');

  // ---- companion tool starts with a game and closes with it
  await page.click('#settingsBtn');
  await page.click('dialog[open] button:has-text("+ Add a tool")');
  await page.fill('dialog[open] .toolrow input >> nth=0', 'Hooker');
  await page.fill('dialog[open] .toolrow input >> nth=1', toolPath);
  await page.check('dialog[open] .toolrow label:has-text("Start with every game") input');
  await shot(page, 'f08-settings-tools');
  await page.click('dialog[open] button:has-text("Save")');
  await page.waitForTimeout(500);
  await page.evaluate((exe) => { addGameFromExe(exe); }, runGame);
  await page.waitForSelector('dialog[open] button:has-text("Skip")', { timeout: 20000 });
  await page.click('dialog[open] button:has-text("Skip")');
  await page.waitForSelector('#playBtn');
  await page.waitForTimeout(500);
  await page.click('#playBtn');
  await page.click('dialog[open] button:has-text("Play without syncing")');
  for (let i = 0; i < 40 && !fs.existsSync(toolMark); i++) await sleep(250);
  result.toolStarted = fs.existsSync(toolMark);
  await page.waitForFunction(() => document.querySelector('#playBtn') && document.querySelector('#playBtn').textContent.includes('Play'), null, { timeout: 30000 });
  await sleep(1500);
  if (!WIN && result.toolStarted) {
    const pid = Number(fs.readFileSync(toolMark, 'utf8'));
    try { process.kill(pid, 0); result.toolClosedWithGame = false; } catch { result.toolClosedWithGame = true; }
  }

  // ---- mouse back / forward and Alt+arrows
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.waitForSelector('#libraryView:not(.hidden) #grid .card');
  await page.click('#grid .card >> nth=0');
  await page.waitForSelector('#detailView:not(.hidden) #playBtn');
  const sideButton = (button) => page.evaluate((b) => window.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true })), button);
  await sideButton(3);
  await page.waitForSelector('#libraryView:not(.hidden)');
  result.mouseBackToLibrary = true;
  await page.waitForTimeout(300);
  await sideButton(4);
  await page.waitForSelector('#detailView:not(.hidden) #playBtn');
  result.mouseForwardToGame = true;
  await page.waitForTimeout(300);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForSelector('#libraryView:not(.hidden)');
  result.altLeftBack = true;

  // ---- the + button and a background image
  result.addButton = await page.textContent('#addBtn');
  await mockOpen(path.join(__dirname, '..', 'build', 'icon.png'));
  await page.click('#settingsBtn');
  await page.click('dialog[open] .bgedit button:has-text("Choose image")');
  await page.waitForSelector('dialog[open] .bgthumb');
  await page.click('dialog[open] button:has-text("Save")');
  await page.waitForTimeout(500);
  result.backgroundOn = await page.evaluate(() => document.body.classList.contains('has-bg') && !!document.querySelector('#appBg').style.backgroundImage);
  await page.click('#sidebar .navitem:has-text("Home")');
  await page.waitForTimeout(500);
  await shot(page, 'f08b-home-background');
  result.homeCards = await page.$$eval('#homeView .recentrow .card', (c) => c.length);

  // ---- Japanese UI
  await page.click('#settingsBtn');
  await page.selectOption('dialog[open] select >> nth=0', 'ja');
  await page.click('dialog[open] button:has-text("Save")');
  await page.waitForSelector('#sidebar .navitem:has-text("ホーム")');
  await page.click('#sidebar .navitem:has-text("ホーム")');
  await page.waitForTimeout(500);
  await shot(page, 'f09-home-ja');
  result.homeJa = await page.textContent('#homeView .hometitle');
  await page.click('#sidebar .navitem:has-text("すべてのゲーム")');
  await page.click('#grid .card:has-text("Kagura"), #grid .card:has-text("神咒")');
  await page.waitForSelector('#detailView .panel h2');
  await page.waitForTimeout(800);
  await shot(page, 'f10-detail-ja');
  result.detailHeadingsJa = await page.$$eval('#detailView .panel h2', (h) => h.map((x) => x.textContent));
  await page.click('#settingsBtn');
  await page.waitForTimeout(400);
  await shot(page, 'f11-settings-ja');
  result.settingsTitleJa = await page.textContent('dialog[open] h3');
  await page.keyboard.press('Escape');

  await app.close();
  console.log(JSON.stringify(result, null, 1));
})().catch(async (e) => {
  console.error('SMOKE FAILED', e);
  if (lastPage) await lastPage.screenshot({ path: path.join(shots, 'FAILED.png') }).catch(() => {});
  process.exit(1);
});
