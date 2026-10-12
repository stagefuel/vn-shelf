'use strict';
// Find the cloud storage folders already on this PC (Google Drive, OneDrive, Dropbox, ...).
// VN Shelf never talks to these services directly: their desktop apps upload whatever
// lands in the folder, so we only need to know where the folder is.

const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const fsu = require('./fsutil');

// Google Drive for desktop names its root after the UI language.
const MY_DRIVE_NAMES = ['My Drive', 'マイドライブ', 'Mi unidad', 'Meine Ablage', 'Mon Drive', 'Il mio Drive',
  'Meu Drive', 'Mijn Drive', 'Мой диск', '我的云端硬盘', '我的雲端硬碟', '내 드라이브'];

async function firstDir(paths) {
  for (const p of paths) if (p && (await fsu.isDir(p))) return p;
  return null;
}

function parseSyncthingFolders(xml) {
  const out = [];
  const re = /<folder\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = (n) => {
      const a = new RegExp(`\\b${n}="([^"]*)"`).exec(m[1]);
      return a ? a[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'") : '';
    };
    const p = attr('path');
    if (p) out.push({ label: attr('label') || attr('id'), path: p.replace(/^~/, os.homedir()) });
  }
  return out;
}

async function detectWindows({ env = process.env, home = os.homedir() } = {}) {
  const found = [];
  const add = (provider, label, p) => { if (p) found.push({ provider, label, path: p }); };
  const appdata = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  // Google Drive for desktop: a virtual drive (usually G:) with "My Drive" at its root,
  // or a "My Drive" / legacy "Google Drive" folder in the user folder.
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    for (const name of MY_DRIVE_NAMES) {
      const p = path.join(root, name);
      if (await fsu.isDir(p)) add('gdrive', `Google Drive (${letter}:)`, p);
    }
  }
  for (const name of [...MY_DRIVE_NAMES, 'Google Drive']) {
    const p = path.join(home, name);
    if (await fsu.isDir(p)) add('gdrive', 'Google Drive', p);
  }

  // OneDrive sets environment variables for each account it has signed in.
  const od = new Set();
  for (const k of ['OneDriveConsumer', 'OneDriveCommercial', 'OneDrive']) if (env[k]) od.add(env[k]);
  try {
    for (const n of await fsp.readdir(home)) if (/^OneDrive( - .+)?$/.test(n)) od.add(path.join(home, n));
  } catch { /* ignore */ }
  for (const p of od) {
    if (!(await fsu.isDir(p))) continue;
    const org = /^OneDrive - (.+)$/.exec(path.basename(p));
    add('onedrive', org ? `OneDrive (${org[1]})` : 'OneDrive', p);
  }

  // Dropbox records its folder in info.json.
  for (const f of [path.join(appdata, 'Dropbox', 'info.json'), path.join(local, 'Dropbox', 'info.json')]) {
    const info = await fsu.readJson(f);
    if (!info) continue;
    for (const [kind, v] of Object.entries(info)) {
      if (v && v.path && (await fsu.isDir(v.path))) add('dropbox', kind === 'business' ? 'Dropbox (work)' : 'Dropbox', v.path);
    }
    break;
  }

  add('icloud', 'iCloud Drive', await firstDir([path.join(home, 'iCloudDrive')]));
  add('mega', 'MEGA', await firstDir([path.join(home, 'MEGA'), path.join(home, 'Documents', 'MEGAsync'), path.join(home, 'MEGAsync')]));
  add('box', 'Box', await firstDir([path.join(home, 'Box')]));
  if (await firstDir([path.join(appdata, 'pCloud'), path.join(local, 'pCloud')])) {
    add('pcloud', 'pCloud Drive', await firstDir(['P:\\', path.join(home, 'pCloud Drive')]));
  }

  const st = await fsp.readFile(path.join(local, 'Syncthing', 'config.xml'), 'utf8').catch(() => null);
  if (st) for (const f of parseSyncthingFolders(st)) add('syncthing', `Syncthing: ${f.label}`, f.path);

  return dedupe(found);
}

async function detectPosix({ home = os.homedir() } = {}) {
  const found = [];
  const add = (provider, label, p) => { if (p) found.push({ provider, label, path: p }); };
  add('dropbox', 'Dropbox', await firstDir([path.join(home, 'Dropbox')]));
  add('gdrive', 'Google Drive', await firstDir([path.join(home, 'Google Drive'), path.join(home, 'GoogleDrive')]));
  add('onedrive', 'OneDrive', await firstDir([path.join(home, 'OneDrive')]));
  add('mega', 'MEGA', await firstDir([path.join(home, 'MEGA')]));
  for (const cfg of [path.join(home, '.local', 'state', 'syncthing', 'config.xml'), path.join(home, '.config', 'syncthing', 'config.xml')]) {
    const st = await fsp.readFile(cfg, 'utf8').catch(() => null);
    if (st) { for (const f of parseSyncthingFolders(st)) add('syncthing', `Syncthing: ${f.label}`, f.path); break; }
  }
  return dedupe(found);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const k = f.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function detect(opts = {}) {
  return (opts.platform || process.platform) === 'win32' ? detectWindows(opts) : detectPosix(opts);
}

module.exports = { detect, parseSyncthingFolders, MY_DRIVE_NAMES };
