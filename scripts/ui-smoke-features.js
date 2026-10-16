'use strict';
// End-to-end check of the library features: update pop-up and patch notes, bulk import with VNDB
// matching, tags, categories, sorting, notes, companion tools, save export/import, search
// suggestions, the game page, Home, Settings tabs, start with the computer and the Japanese UI.
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
const base = require('./smoke-tmp').smokeTmp('vns-uif-'); // deleted when the script ends
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
  write(runGame, '@echo off\r\nif not exist "%~dp0save" mkdir "%~dp0save"\r\necho slot> "%~dp0save\\save01.dat"\r\nping -n 5 127.0.0.1 > nul\r\n');
  toolPath = path.join(home, 'Tools', 'hooker.cmd');
  write(toolPath, `@echo off\r\necho started> "${toolMark}"\r\nping -n 60 127.0.0.1 > nul\r\n`);
} else {
  runGame = path.join(home, 'Games', 'Tool Test', 'tooltest.sh');
  write(runGame, '#!/bin/sh\nmkdir -p "$(dirname "$0")/save"\necho slot > "$(dirname "$0")/save/save01.dat"\nsleep 4\n');
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
      const e = { ...process.env, ...env, VNS_FAKE_UPDATE: JSON.stringify({ version: '9.9.9', notes: '### New\n- **Bold** thing\n  - nested item\n  continued line\n- Second thing', page: 'https://github.com/stagefuel/vn-shelf/releases', asset: null }) };
      delete e.ELECTRON_RUN_AS_NODE;
      return e;
    })(),
  });
  const page = await app.firstWindow();
  lastPage = page;
  await page.setViewportSize(process.env.VNS_VIEWPORT ? { width: +process.env.VNS_VIEWPORT.split('x')[0], height: +process.env.VNS_VIEWPORT.split('x')[1] } : { width: 1280, height: 820 });
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
  // The update window: current version only, and the notes formatted (lists, bold, nesting).
  await page.click('#updatePill');
  await page.waitForSelector('dialog[open] .notes-view .md');
  result.updateText = await page.textContent('dialog[open] .dhead p');
  result.updateNotes = await page.evaluate(() => {
    const md = document.querySelector('dialog[open] .notes-view .md');
    return { heading: md.querySelector('h5') && md.querySelector('h5').textContent, items: md.querySelectorAll('li').length,
      nested: md.querySelectorAll('ul ul li').length, bold: md.querySelector('strong') && md.querySelector('strong').textContent,
      continued: md.querySelector('ul ul li').parentNode.parentNode.textContent.includes('continued line') };
  });
  await shot(page, 'f01b-update-dialog');
  await page.click('dialog[open] button:has-text("Later")');

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
  await page.click('dialog[open] .tab[data-tab="games"]');
  await page.click('dialog[open] button:has-text("+ Add a tool")');
  await page.fill('dialog[open] .toolrow input >> nth=0', 'Hooker');
  await page.fill('dialog[open] .toolrow input >> nth=1', toolPath);
  await page.check('dialog[open] .toolrow label:has-text("Start with every game") input');
  await shot(page, 'f08-settings-tools');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForTimeout(500);
  await page.evaluate((exe) => { addGameFromExe(exe); }, runGame);
  await page.waitForSelector('dialog[open] button:has-text("Skip")', { timeout: 20000 });
  await page.click('dialog[open] button:has-text("Skip")');
  await page.waitForSelector('#playBtn');
  await page.waitForTimeout(500);
  await page.click('#playBtn');
  for (let i = 0; i < 40 && !fs.existsSync(toolMark); i++) await sleep(250);
  result.toolStarted = fs.existsSync(toolMark);
  // No save folder yet: after the game closes, VN Shelf shows where it saved.
  await page.waitForSelector('dialog[open] h3:has-text("Where does this game save")', { timeout: 40000 });
  result.detectedAfterPlay = await page.$$eval('dialog[open] .choice .mono', (r) => r.map((x) => x.textContent.trim()));
  await page.click('dialog[open] button:has-text("Use selected")');
  await page.waitForSelector('.toast.good:has-text("uploaded")', { timeout: 30000 });
  result.saveFolderAfterPlay = await page.$eval('.panel .row .path', (e) => e.textContent);
  await sleep(1500);
  if (!WIN && result.toolStarted) {
    const pid = Number(fs.readFileSync(toolMark, 'utf8'));
    try { process.kill(pid, 0); result.toolClosedWithGame = false; } catch { result.toolClosedWithGame = true; }
  }

  // ---- mouse back / forward and Alt+arrows
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.waitForSelector('#libraryView:not(.hidden) #grid .card');
  const backShown = () => page.evaluate(() => !document.querySelector('#backBtn').classList.contains('hidden'));
  result.backHiddenOnTab = !(await backShown());
  await page.click('#grid .card >> nth=0');
  await page.waitForSelector('#detailView:not(.hidden) #playBtn');
  result.backShownOnGame = await backShown();
  const sideButton = (button) => page.evaluate((b) => window.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true })), button);
  await sideButton(3);
  await page.waitForSelector('#libraryView:not(.hidden)');
  result.mouseBackToLibrary = !(await backShown());
  await page.waitForTimeout(300);
  await sideButton(4);
  await page.waitForSelector('#detailView:not(.hidden) #playBtn');
  result.mouseForwardToGame = true;
  await page.waitForTimeout(300);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForSelector('#libraryView:not(.hidden)');
  result.altLeftBack = true;

  // ---- game page: the new page shows at once, never the previous game's
  await page.click('#grid .card >> nth=0');
  await page.waitForSelector('#detailView:not(.hidden) #playBtn');
  await page.waitForTimeout(400); // back/forward ignore repeats within 250 ms
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForSelector('#libraryView:not(.hidden)');
  await page.waitForTimeout(300);
  result.instantGamePage = await page.evaluate(() => {
    const card = document.querySelectorAll('#grid .card')[1];
    const want = card.querySelector('.title').textContent;
    card.click(); // in the same moment, before anything has loaded
    const shown = document.querySelector('#detailView h1');
    return { want, shown: shown && shown.textContent };
  });
  await page.waitForTimeout(800);

  // ---- clicking "VN Shelf" goes Home
  await page.click('#brand');
  await page.waitForSelector('#homeView:not(.hidden)');
  result.brandGoesHome = true;

  // ---- search suggestions
  const q = firstTag.slice(0, Math.min(4, firstTag.length)).toLowerCase();
  await page.click('#search');
  await page.fill('#search', q);
  await page.waitForSelector('#suggest:not(.hidden) .sugitem');
  await shot(page, 'f05b-suggestions');
  result.suggestions = await page.$$eval('#suggest .sugitem', (r) => r.map((x) => `${x.querySelector('.kind').textContent}: ${x.querySelector('.label').textContent}`));
  const tagIndex = await page.$$eval('#suggest .sugitem', (r) => r.findIndex((x) => x.querySelector('.kind').textContent === 'Tag'));
  for (let i = 0; i <= tagIndex; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#libraryView:not(.hidden) .chip.on:has-text("Tag")');
  result.suggestionOpensTag = await page.textContent('.libtoolbar h1');
  result.suggestHiddenAfter = await page.evaluate(() => document.querySelector('#suggest').classList.contains('hidden'));

  // ---- the + button and a background image
  result.addButton = await page.textContent('#addBtn');
  await mockOpen(path.join(__dirname, '..', 'build', 'icon.png'));
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="look"]');
  await page.click('dialog[open] .bgedit button:has-text("Choose image")');
  await page.waitForSelector('dialog[open] .bgthumb');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForTimeout(500);
  result.backgroundOn = await page.evaluate(() => document.body.classList.contains('has-bg') && !!document.querySelector('#appBg').style.backgroundImage);
  await page.click('#sidebar .navitem:has-text("Home")');
  await page.waitForTimeout(500);
  await shot(page, 'f08b-home-background');
  result.homeHero = await page.evaluate(() => {
    const hero = document.querySelector('#homeView .homehero');
    return hero && { title: hero.querySelector('h1').textContent, facts: [...hero.querySelectorAll('.fact .k')].map((x) => x.textContent), play: !!hero.querySelector('button.play.big') };
  });

  // ---- Settings tabs: patch notes, GitHub link, start with the computer
  await page.click('#settingsBtn');
  result.settingsTabs = await page.$$eval('dialog[open] .tab', (b) => b.map((x) => x.textContent));
  await page.click('dialog[open] .tab[data-tab="about"]');
  await page.click('dialog[open] button:has-text("View patch notes")');
  await page.waitForSelector('dialog[open] .notes-view .md li');
  result.patchNotesItems = await page.$$eval('dialog[open] .notes-view .md li', (l) => l.length);
  result.githubButton = !!(await page.$('dialog[open] button:has-text("GitHub page")'));
  await shot(page, 'f08c-settings-about');
  await page.click('dialog[open] .tab[data-tab="general"]');
  await page.check('dialog[open] label:has-text("Start VN Shelf when") input');
  await shot(page, 'f08d-settings-general');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForTimeout(500);
  const autostart = WIN ? null : path.join(appdata, 'autostart', 'vn-shelf.desktop');
  result.startWithSystemOn = WIN
    ? await app.evaluate(({ app: a }) => a.getLoginItemSettings().openAtLogin)
    : fs.existsSync(autostart) && /--hidden/.test(fs.readFileSync(autostart, 'utf8'));
  await page.click('#settingsBtn');
  await page.uncheck('dialog[open] label:has-text("Start VN Shelf when") input');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForTimeout(500);
  result.startWithSystemOff = WIN ? !(await app.evaluate(({ app: a }) => a.getLoginItemSettings().openAtLogin)) : !fs.existsSync(autostart);

  // ---- reading status
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.click('#grid .card:has-text("SWAN SONG")');
  await page.waitForSelector('#detailView .statussel');
  await page.click('#detailView .statussel');
  await page.click('.statusmenu label:has-text("Finished")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sidebar .navitem:has-text("Finished")');
  await page.click('#sidebar .navitem:has-text("Finished")');
  await page.waitForSelector('.libtoolbar h1:has-text("Finished")');
  result.statusFilter = await page.$$eval('#grid .card .title', (t) => t.map((x) => x.textContent));
  result.statusOnCard = await page.textContent('#grid .card .sub');
  await shot(page, 'f12-status');

  // ---- status ribbon, a sort per view, My order (drag), install updates setting
  result.ribbon = await page.$$eval('#grid .card .ribbon', (r) => r.map((x) => x.className));
  await page.selectOption('#libraryView .sortsel', 'played');
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.waitForSelector('.libtoolbar h1:has-text("All games")');
  await page.selectOption('#libraryView .sortsel', 'custom');
  await page.waitForSelector('#grid.arranging .card');
  const order = () => page.$$eval('#grid .card', (c) => c.map((x) => x.dataset.id));
  const before = await order();
  await page.dragAndDrop(`#grid .card[data-id="${before[2]}"]`, `#grid .card[data-id="${before[0]}"]`, { targetPosition: { x: 5, y: 40 } });
  await page.waitForTimeout(500);
  const afterCovers = await order();
  result.arrangeCovers = afterCovers[0] === before[2];
  await page.click('.viewsw button >> nth=2');
  await page.waitForSelector('#grid.arranging .lrow');
  const rows = () => page.$$eval('#grid .lrow', (c) => c.map((x) => x.dataset.id));
  const r0 = await rows();
  const box = await page.$eval(`#grid .lrow[data-id="${r0[0]}"]`, (e) => { const b = e.getBoundingClientRect(); return { h: b.height }; });
  await page.dragAndDrop(`#grid .lrow[data-id="${r0[0]}"]`, `#grid .lrow[data-id="${r0[r0.length - 1]}"]`, { targetPosition: { x: 20, y: box.h - 3 } });
  await page.waitForTimeout(500);
  const r1 = await rows();
  result.arrangeList = r1[r1.length - 1] === r0[0];
  result.customOrderSaved = await page.evaluate(() => vns.call('getSetup').then((x) => x.settings.customOrder.length));
  await page.click('.viewsw button >> nth=0');
  await page.click('#sidebar .navitem:has-text("Finished")');
  await page.waitForSelector('.libtoolbar h1:has-text("Finished")');
  result.sortPerView = { finished: await page.$eval('#libraryView .sortsel', (x) => x.value) };
  await page.click('#sidebar .navitem:has-text("All games")');
  await page.waitForSelector('.libtoolbar h1:has-text("All games")');
  result.sortPerView.all = await page.$eval('#libraryView .sortsel', (x) => x.value);
  await shot(page, 'f12b-my-order');
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="about"]');
  await page.selectOption('dialog[open] #updInstall', 'auto');
  await shot(page, 'f12c-updates');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForTimeout(400);
  result.updateInstall = await page.evaluate(() => vns.call('getSetup').then((x) => x.settings.updateInstall));

  // ---- theme and fonts
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="look"]');
  await page.selectOption('dialog[open] .bgedit select >> nth=0', 'sakura');
  await page.waitForTimeout(300);
  await shot(page, 'f13-theme');
  result.fontChoices = await page.$$eval('dialog[open] .fontrow select >> nth=0', (s) => s[0] ? s[0].options.length : 0).catch(() => 0);
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForTimeout(500);
  result.themeAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  result.themeSaved = await page.evaluate(() => vns.call('getSetup').then((x) => x.settings.theme && x.settings.theme.preset));

  // ---- Japanese UI
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="general"]');
  await page.selectOption('dialog[open] select >> nth=0', 'ja');
  await page.click('dialog[open] .dfoot button:has-text("Save")');
  await page.waitForSelector('#sidebar .navitem:has-text("ホーム")');
  await page.click('#sidebar .navitem:has-text("ホーム")');
  await page.waitForTimeout(500);
  await shot(page, 'f09-home-ja');
  result.homeJa = await page.textContent('#homeView .homehero .eyebrow');
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
