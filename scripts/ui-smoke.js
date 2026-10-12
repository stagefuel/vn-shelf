'use strict';
// End-to-end check on Linux: two fake PCs share one "Dropbox" folder.
// Run with: xvfb-run -a node scripts/ui-smoke.js <screenshot dir>
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shots = path.resolve(process.argv[2] || 'shots');
fs.mkdirSync(shots, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-ui-'));
const cloudRoot = path.join(base, 'shared-dropbox');
fs.mkdirSync(cloudRoot, { recursive: true });

function makePc(name) {
  const home = path.join(base, name);
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  // Point "Dropbox" in this home at the shared folder so provider detection finds it.
  fs.symlinkSync(cloudRoot, path.join(home, 'Dropbox'));
  const game = path.join(home, 'Games', '[light] 神咒神威神楽');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'data.xp3'), '');
  const exe = path.join(game, 'kkk.sh');
  fs.writeFileSync(exe, `#!/bin/sh\nmkdir -p "$(dirname "$0")/savedata"\necho "progress from ${name} $(date +%s%N)" >> "$(dirname "$0")/savedata/save001.dat"\nsleep 3\n`);
  fs.chmodSync(exe, 0o755);
  // A game with no recognisable engine that saves into AppData (~/.config on Linux).
  const g2 = path.join(home, 'Games', 'Mystery');
  fs.mkdirSync(g2, { recursive: true });
  const exe2 = path.join(g2, 'mystery.sh');
  fs.writeFileSync(exe2, `#!/bin/sh\nmkdir -p "$HOME/.config/StudioX/Mystery" "$HOME/.config/discord/Cache"\necho slot > "$HOME/.config/StudioX/Mystery/sav01.sav"\necho noise > "$HOME/.config/discord/Cache/data_0"\nsleep 3\n`);
  fs.chmodSync(exe2, 0o755);
  return { name, home, game, exe, exe2 };
}

async function start(pc) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, HOME: pc.home, XDG_CONFIG_HOME: path.join(pc.home, '.config'), XDG_DATA_HOME: path.join(pc.home, '.local/share') },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 820 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${pc.name} console]`, m.text()); });
  page.on('pageerror', (e) => console.log(`[${pc.name} pageerror]`, e.message));
  return { app, page };
}

async function mockDialog(app, file) {
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
}

const shot = (page, n) => page.screenshot({ path: path.join(shots, `${n}.png`) });

(async () => {
  let saveOncePath = null;
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
  // Save-once on an unknown game
  await page.evaluate((exe) => { addGameFromExe(exe); }, A.exe2);
  await page.waitForSelector('dialog[open] button:has-text("Skip")', { timeout: 20000 });
  await page.click('dialog button:has-text("Skip")');
  await page.waitForSelector('#detailView:not(.hidden) button:has-text("Save once")');
  await page.waitForTimeout(800);
  await page.click('button:has-text("Save once")');
  await page.click('dialog button:has-text("Start the game")');
  await page.waitForSelector('dialog[open] .choice', { timeout: 30000 });
  await page.waitForTimeout(300);
  await shot(page, '06a-saveonce');
  await page.click('dialog button:has-text("Use selected")');
  await page.waitForTimeout(1200);
  saveOncePath = await page.$eval('.panel .row .path', (e) => e.textContent);
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
  await page.waitForSelector('.card');
  await page.waitForTimeout(1200);
  await shot(page, '07-laptop-library');
  await mockDialog(app, B.exe);
  await page.click('.card:has-text("Kajiri")');
  await page.waitForSelector('#playBtn');
  await page.click('#playBtn');
  await page.click('dialog button:has-text("Find the .exe")');
  await page.waitForSelector('.toast.good', { timeout: 30000 });
  const pulledFirst = fs.readFileSync(path.join(B.game, 'savedata', 'save001.dat'), 'utf8');
  await page.waitForTimeout(800);
  await shot(page, '08-laptop-after-play');
  const hist = await page.$$eval('.panel .box .row', (rows) => rows.length);
  await app.close();

  // ---------------- conflict: both change
  fs.writeFileSync(path.join(A.game, 'savedata', 'save001.dat'), 'desktop offline progress');
  ({ app, page } = await start(A));
  await page.waitForSelector('.card');
  await page.click('.card:has-text("Kajiri")');
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

  console.log(JSON.stringify({ shots, saveOncePath, pulledOnLaptop: pulledFirst.trim(), cloud: fs.readdirSync(path.join(cloudRoot, 'VNShelf', 'games')), historyRowsOnLaptop: hist }, null, 1));
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
