'use strict';
// End-to-end check on Linux: two fake PCs share one "Dropbox" folder.
// Run with: xvfb-run -a node scripts/ui-smoke.js <screenshot dir>
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shots = path.resolve(process.argv[2] || 'shots');
fs.mkdirSync(shots, { recursive: true });
const base = require('./smoke-tmp').smokeTmp('vns-ui-'); // deleted when the script ends
const cloudRoot = path.join(base, 'shared-dropbox');
fs.mkdirSync(cloudRoot, { recursive: true });

const WIN = process.platform === 'win32';

function makePc(name) {
  const home = path.join(base, name);
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const env = WIN
    ? { APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), VNS_USER_DATA: path.join(home, 'vnshelf-settings') }
    : { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') };
  if (WIN) {
    // Dropbox records its folder in %APPDATA%\Dropbox\info.json; point it at the shared folder.
    fs.mkdirSync(path.join(env.APPDATA, 'Dropbox'), { recursive: true });
    fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
    fs.writeFileSync(path.join(env.APPDATA, 'Dropbox', 'info.json'), JSON.stringify({ personal: { path: cloudRoot } }));
  } else {
    fs.symlinkSync(cloudRoot, path.join(home, 'Dropbox'));
  }
  const game = path.join(home, 'Games', '[light] 神咒神威神楽');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'data.xp3'), '');
  let exe;
  if (WIN) {
    exe = path.join(game, 'kkk.cmd');
    fs.writeFileSync(exe, `@echo off\r\nif not exist "%~dp0savedata" mkdir "%~dp0savedata"\r\necho progress from ${name} %RANDOM%>> "%~dp0savedata\\save001.dat"\r\nping -n 4 127.0.0.1 > nul\r\n`);
  } else {
    exe = path.join(game, 'kkk.sh');
    fs.writeFileSync(exe, `#!/bin/sh\nmkdir -p "$(dirname "$0")/savedata"\necho "progress from ${name} $(date +%s%N)" >> "$(dirname "$0")/savedata/save001.dat"\nsleep 3\n`);
    fs.chmodSync(exe, 0o755);
  }
  // A game with no recognisable engine that saves into AppData (~/.config on Linux).
  const g2 = path.join(home, 'Games', 'Mystery');
  fs.mkdirSync(g2, { recursive: true });
  let exe2;
  if (WIN) {
    exe2 = path.join(g2, 'mystery.cmd');
    fs.writeFileSync(exe2, '@echo off\r\nmkdir "%APPDATA%\\StudioX\\Mystery" 2>nul\r\nmkdir "%APPDATA%\\discord\\Cache" 2>nul\r\necho slot> "%APPDATA%\\StudioX\\Mystery\\sav01.sav"\r\necho noise> "%APPDATA%\\discord\\Cache\\data_0"\r\nping -n 4 127.0.0.1 > nul\r\n');
  } else {
    exe2 = path.join(g2, 'mystery.sh');
    fs.writeFileSync(exe2, `#!/bin/sh\nmkdir -p "$HOME/.config/StudioX/Mystery" "$HOME/.config/discord/Cache"\necho slot > "$HOME/.config/StudioX/Mystery/sav01.sav"\necho noise > "$HOME/.config/discord/Cache/data_0"\nsleep 3\n`);
    fs.chmodSync(exe2, 0o755);
  }
  return { name, home, game, exe, exe2, env };
}

async function start(pc) {
  // VNS_EXE = a packaged build to test (e.g. "VN Shelf.exe" on Windows); otherwise run from source.
  const packaged = process.env.VNS_EXE;
  const env = { ...process.env, ...pc.env, VNS_NO_UPDATE_CHECK: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [path.join(__dirname, '..'), '--no-sandbox'],
    env,
  });
  const page = await app.firstWindow();
  lastPage = page;
  await page.setViewportSize({ width: 1280, height: 820 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${pc.name} console]`, m.text()); });
  page.on('pageerror', (e) => console.log(`[${pc.name} pageerror]`, e.message));
  return { app, page };
}

async function mockDialog(app, file) {
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
}

let lastPage = null;
const shot = (page, n) => page.screenshot({ path: path.join(shots, `${n}.png`) });

(async () => {
  let saveOncePath = null;
  let copiedLook = null;
  const A = makePc('Desktop');
  const B = makePc('Laptop');

  // ---------------- PC A
  let { app, page } = await start(A);
  await page.waitForSelector('dialog[open] .choice');
  await page.waitForTimeout(400);
  await shot(page, '01-setup');
  await page.fill('dialog input[type=text]', 'Desktop');
  await page.click('dialog .choice:has-text("Dropbox")');
  await page.click('dialog button:has-text("Start")');
  await page.waitForSelector('#empty:not(.hidden)');
  await shot(page, '02-empty');

  await page.evaluate((exe) => { addGameFromExe(exe); }, A.exe);
  await page.waitForSelector('dialog[open] .vnres', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, '03-vndb');
  await page.click('dialog .vnres >> nth=0');
  await page.waitForSelector('#detailView:not(.hidden) .suggest .row', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, '04-detail-suggest');
  await page.click('.suggest .row button:has-text("Use") >> nth=0');
  await page.waitForTimeout(800);
  await page.click('#playBtn');
  await page.waitForSelector('.toast.good:has-text("uploaded")', { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot(page, '05-after-play');
  // An unknown game with no save folder: just Play. When it closes, VN Shelf asks where it saved
  // (from what changed while it ran) and does the first upload.
  await page.evaluate((exe) => { addGameFromExe(exe); }, A.exe2);
  await page.waitForSelector('dialog[open] button:has-text("Skip")', { timeout: 20000 });
  await page.click('dialog button:has-text("Skip")');
  await page.waitForSelector('#detailView:not(.hidden) #playBtn');
  await page.waitForTimeout(800);
  await page.click('#playBtn');
  await page.waitForSelector('dialog[open] h3:has-text("Where does this game save")', { timeout: 40000 });
  await page.waitForTimeout(300);
  await shot(page, '06a-detected-after-play');
  const detected = await page.$$eval('dialog[open] .choice .mono', (r) => r.map((x) => x.textContent));
  if (detected.some((d) => /discord/i.test(d))) throw new Error(`noise offered as a save folder: ${detected}`);
  await page.click('dialog button:has-text("Use selected")');
  await page.waitForSelector('.toast.good:has-text("uploaded")', { timeout: 30000 });
  await page.waitForTimeout(1200);
  saveOncePath = await page.$eval('.panel .row .path', (e) => e.textContent);
  // Share a look for the other PC to copy later.
  await page.evaluate(() => vns.call('saveSettings', { theme: { preset: 'midnight', colors: { accent: '#ff8800' } } }));
  await page.waitForTimeout(4000);
  await shot(page, '06b-saveonce-added');
  await page.click('#backBtn');
  await page.waitForTimeout(1500);
  await shot(page, '06-library');
  await app.close();

  // ---------------- PC B
  ({ app, page } = await start(B));
  await page.waitForSelector('dialog[open] .choice');
  await page.fill('dialog input[type=text]', 'Laptop');
  await page.click('dialog .choice:has-text("Dropbox")');
  await page.click('dialog button:has-text("Start")');
  await page.waitForSelector('.card, .homehero');
  await page.waitForTimeout(1200);
  await shot(page, '07-laptop-library');
  await mockDialog(app, B.exe);
  await page.click('.card:has-text("Kajiri"), .homehero:has-text("Kajiri") h1');
  await page.waitForSelector('#playBtn');
  await page.click('#playBtn');
  await page.click('dialog button:has-text("Find the .exe")');
  await page.waitForSelector('.toast.good', { timeout: 30000 });
  const pulledFirst = fs.readFileSync(path.join(B.game, 'savedata', 'save001.dat'), 'utf8');
  await page.waitForTimeout(800);
  await shot(page, '08-laptop-after-play');
  const hist = await page.$$eval('.panel .box .row', (rows) => rows.length);
  // Copy the Desktop's look onto the Laptop.
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="general"]');
  await page.click('dialog[open] button:has-text("Copy settings from another PC")');
  await page.waitForSelector('dialog[open] .choice:has-text("Desktop")', { timeout: 15000 });
  await page.click('dialog[open] button:has-text("Copy settings")');
  await page.waitForSelector('.toast.good:has-text("Desktop")', { timeout: 15000 });
  copiedLook = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
  if (copiedLook.bg !== '#0b1020' || copiedLook.accent !== '#ff8800') throw new Error(`settings not copied: ${JSON.stringify(copiedLook)}`);
  await shot(page, '08b-laptop-copied-look');
  await app.close();

  // ---------------- conflict: both change
  fs.writeFileSync(path.join(A.game, 'savedata', 'save001.dat'), 'desktop offline progress');
  ({ app, page } = await start(A));
  await page.waitForSelector('.card, .homehero');
  await page.click('.card:has-text("Kajiri"), .homehero:has-text("Kajiri") h1');
  await page.waitForSelector('#playBtn');
  await page.waitForTimeout(800);
  await page.click('button:has-text("Sync now")');
  await page.waitForSelector('dialog[open] .sides', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, '09-conflict');
  await page.click('dialog button:has-text("Keep this PC")');
  await page.waitForTimeout(1500);
  await shot(page, '10-history');
  await app.close();

  console.log(JSON.stringify({ shots, saveOncePath, copiedLook, pulledOnLaptop: pulledFirst.trim(), cloud: fs.readdirSync(path.join(cloudRoot, 'VNShelf', 'games')), historyRowsOnLaptop: hist }, null, 1));
})().catch(async (e) => {
  console.error('SMOKE FAILED', e);
  if (lastPage) await lastPage.screenshot({ path: path.join(shots, 'FAILED.png') }).catch(() => {});
  process.exit(1);
});
