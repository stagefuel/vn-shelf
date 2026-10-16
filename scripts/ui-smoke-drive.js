'use strict';
// Drive mode end to end: two fake PCs sign in to a fake Google Drive, sync a game, and hit the
// save-folder safety checks. Linux: DISPLAY=:97 node scripts/ui-smoke-drive.js <shots dir>
// Windows / a packaged build: set VNS_EXE to the app's .exe.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeDrive } = require('../test/helpers/fake-drive');

const shots = path.resolve(process.argv[2] || 'shots-drive');
fs.mkdirSync(shots, { recursive: true });
const base = require('./smoke-tmp').smokeTmp('vns-uid-'); // deleted when the script ends
let lastPage = null;
let fdGlobal = null;
const WIN = process.platform === 'win32';
const shot = (page, n) => page.screenshot({ path: path.join(shots, `${n}.png`) });

function makePc(name) {
  const home = path.join(base, name);
  // Where <appdata> points for this fake PC.
  const appdata = WIN ? path.join(home, 'Roaming') : path.join(home, '.config');
  fs.mkdirSync(appdata, { recursive: true });
  const env = WIN
    ? { APPDATA: appdata, LOCALAPPDATA: path.join(home, 'Local'), VNS_USER_DATA: path.join(home, 'vnshelf-settings') }
    : { HOME: home, XDG_CONFIG_HOME: appdata, XDG_DATA_HOME: path.join(home, '.local/share') };
  if (WIN) fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const game = path.join(home, 'Games', 'Muramasa');
  fs.mkdirSync(game, { recursive: true });
  let exe;
  if (WIN) {
    exe = path.join(game, 'muramasa.cmd');
    fs.writeFileSync(exe, `@echo off\r\nmkdir "%APPDATA%\\Nitroplus\\Muramasa\\1.00" 2>nul\r\necho progress from ${name}>> "%APPDATA%\\Nitroplus\\Muramasa\\1.00\\save001.dat"\r\nping -n 4 127.0.0.1 > nul\r\n`);
  } else {
    exe = path.join(game, 'muramasa.sh');
    fs.writeFileSync(exe, `#!/bin/sh\nmkdir -p "$HOME/.config/Nitroplus/Muramasa/1.00"\necho "progress from ${name}" >> "$HOME/.config/Nitroplus/Muramasa/1.00/save001.dat"\nsleep 3\n`);
    fs.chmodSync(exe, 0o755);
  }
  // An enormous folder someone might pick by mistake.
  const huge = path.join(appdata, 'BigApp', 'Data');
  for (let i = 0; i < 1200; i++) { fs.mkdirSync(huge, { recursive: true }); fs.writeFileSync(path.join(huge, `chunk${i}.dat`), 'x'); }
  return { name, home, game, exe, env, appdata };
}

async function start(pc, fd) {
  const packaged = process.env.VNS_EXE;
  const env = { ...process.env, ...pc.env, VNS_NO_UPDATE_CHECK: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [path.join(__dirname, '..'), '--no-sandbox'],
    env: {
      ...env,
      VNS_GOOGLE_CLIENT_ID: 'fake-client', VNS_GOOGLE_CLIENT_SECRET: 'fake-secret',
      VNS_GOOGLE_AUTH_URL: `${fd.base}/auth`, VNS_GOOGLE_TOKEN_URL: fd.tokenUrl, VNS_GOOGLE_REVOKE_URL: fd.revokeUrl,
      VNS_DRIVE_API: fd.apiBase, VNS_DRIVE_UPLOAD: fd.uploadBase,
    },
  });
  // Play the browser: Google "approves" and redirects straight back to the app's local helper.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      const u = new URL(url);
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'ok');
      back.searchParams.set('state', u.searchParams.get('state'));
      await fetch(back);
    };
  });
  const page = await app.firstWindow();
  lastPage = page;
  await page.setViewportSize(process.env.VNS_VIEWPORT ? { width: +process.env.VNS_VIEWPORT.split('x')[0], height: +process.env.VNS_VIEWPORT.split('x')[1] } : { width: 1280, height: 820 });
  page.on('pageerror', (e) => console.log(`[${pc.name} pageerror]`, e.message));
  return { app, page };
}

async function mockDialog(app, file) {
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
}

(async () => {
  const fd = await startFakeDrive({ pageSize: 50 });
  fdGlobal = fd;
  const A = makePc('Desktop');
  const B = makePc('Laptop');
  const result = {};

  // ---------------- PC A: sign in to Drive, add a game, set saves, play
  let { app, page } = await start(A, fd);
  await page.waitForSelector('dialog[open] .choice');
  await page.fill('dialog input[type=text]', 'Desktop');
  await page.click('dialog .choice:has-text("Google Drive (sign in)")');
  await page.waitForSelector('dialog .choice.sel:has-text("Signed in as")', { timeout: 15000 });
  await shot(page, 'd01-setup-drive');
  await page.click('dialog button:has-text("Start")');
  await page.waitForSelector('#empty:not(.hidden)');

  await page.evaluate((exe) => { addGameFromExe(exe); }, A.exe);
  await page.waitForSelector('dialog[open] button:has-text("Skip")', { timeout: 20000 });
  await page.click('dialog button:has-text("Skip")');
  await page.waitForSelector('#detailView:not(.hidden) button:has-text("Type a path")');

  // Safety: a whole system folder is refused...
  await page.click('button:has-text("Type a path")');
  await page.fill('dialog .field input >> nth=0', '<appdata>');
  await page.click('dialog button:has-text("Add")');
  await page.waitForSelector('dialog[open] h3:has-text("Can\'t sync that folder")');
  await shot(page, 'd02-refused');
  result.refusedSystemFolder = true;
  await page.click('dialog button:has-text("OK")');
  // ...and an enormous folder needs confirmation (cancelled here).
  await page.click('button:has-text("Type a path")');
  await page.fill('dialog .field input >> nth=0', '<appdata>/BigApp/Data');
  await page.click('dialog button:has-text("Add")');
  await page.waitForSelector('dialog[open] h3:has-text("unusually big")');
  await shot(page, 'd03-confirm-big');
  result.confirmedBigFolder = true;
  await page.click('dialog button:has-text("Cancel")');
  // The real save folder.
  await page.click('button:has-text("Type a path")');
  await page.fill('dialog .field input >> nth=0', '<appdata>/Nitroplus/Muramasa');
  await page.click('dialog button:has-text("Add")');
  await page.waitForSelector('.panel .row .path:has-text("Nitroplus/Muramasa")');
  await page.click('#playBtn');
  await page.waitForSelector('.toast.good:has-text("uploaded")', { timeout: 40000 });
  await page.waitForTimeout(1000);
  await shot(page, 'd04-after-play');
  await app.close();

  // ---------------- PC B: sign in, see the game, locate, play (pulls first)
  ({ app, page } = await start(B, fd));
  await page.waitForSelector('dialog[open] .choice');
  await page.fill('dialog input[type=text]', 'Laptop');
  await page.click('dialog .choice:has-text("Google Drive (sign in)")');
  await page.waitForSelector('dialog .choice.sel:has-text("Signed in as")', { timeout: 15000 });
  await page.click('dialog button:has-text("Start")');
  await page.waitForSelector('.card:has-text("Muramasa"), .homehero:has-text("Muramasa")', { timeout: 20000 });
  await page.waitForTimeout(1000);
  await shot(page, 'd05-laptop-library');
  await mockDialog(app, B.exe);
  await page.click('.card:has-text("Muramasa"), .homehero:has-text("Muramasa") h1');
  await page.waitForSelector('#playBtn');
  await page.click('#playBtn');
  await page.click('dialog button:has-text("Find the .exe")');
  await page.waitForSelector('.toast.good:has-text("uploaded")', { timeout: 40000 });
  await page.waitForTimeout(1000);
  await shot(page, 'd06-laptop-after-play');
  result.laptopSave = fs.readFileSync(path.join(B.appdata, 'Nitroplus', 'Muramasa', '1.00', 'save001.dat'), 'utf8');

  // Sign out from Settings
  await page.click('#settingsBtn');
  await page.click('dialog[open] .tab[data-tab="saves"]');
  await page.waitForSelector('dialog[open] button:has-text("Sign out")');
  await shot(page, 'd07-settings');
  await page.click('dialog button:has-text("Sign out")');
  await page.waitForSelector('dialog[open] h3:has-text("Welcome")', { timeout: 10000 });
  result.signedOutBackToSetup = true;
  await app.close();

  result.driveFiles = [...fd.state.files.values()].map((f) => f.name).filter((n) => !n.startsWith('b-')).sort();
  result.blobs = [...fd.state.files.values()].filter((f) => f.name.startsWith('b-')).length;
  console.log(JSON.stringify(result, null, 1));
  await fd.close();
})().catch(async (e) => {
  console.error('SMOKE FAILED', e);
  if (lastPage) {
    await lastPage.screenshot({ path: path.join(shots, 'FAILED.png') }).catch(() => {});
    const diag = await lastPage.evaluate(async () => {
      const r = {};
      for (const m of ['getSetup', 'listGames']) { try { r[m] = await vns.call(m); } catch (e) { r[m] = `ERROR ${e.message}`; } }
      return r;
    }).catch((e) => `diag failed: ${e.message}`);
    console.error('DIAG', JSON.stringify(diag, null, 1));
    if (fdGlobal) console.error('FAKE DRIVE', JSON.stringify([...fdGlobal.state.files.values()].map((f) => ({ id: f.id, name: f.name, parents: f.parents, app: f.appProperties, trashed: f.trashed })), null, 0));
  }
  process.exit(1);
});
