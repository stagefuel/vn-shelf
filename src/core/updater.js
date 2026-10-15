'use strict';
// In-app updates from GitHub releases. The portable .exe is replaced in place: the new file is
// downloaded next to it, checked, and a small script swaps it in after VN Shelf closes.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const REPO = 'stagefuel/vn-shelf';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=15`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}

/** Negative if a < b, 0 if equal, positive if a > b (semver, pre-releases sort before releases). */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * The newest release newer than `current`, or null.
 * @returns {Promise<null|{version, notes, page, publishedAt, asset: {name, url, size, sha256}}>}
 */
async function checkForUpdate(current, { fetchImpl = fetch, includePrerelease = true } = {}) {
  const res = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VN-Shelf' } });
  if (!res.ok) throw new Error(`Couldn't check for updates (${res.status}).`);
  const list = await res.json();
  let best = null;
  for (const r of list) {
    if (r.draft || (r.prerelease && !includePrerelease)) continue;
    if (!parseVersion(r.tag_name) || compareVersions(r.tag_name, current) <= 0) continue;
    if (best && compareVersions(r.tag_name, best.tag_name) <= 0) continue;
    best = r;
  }
  if (!best) return null;
  const a = (best.assets || []).find((x) => /portable\.exe$/i.test(x.name));
  return {
    version: best.tag_name.replace(/^v/, ''),
    notes: best.body || '',
    page: best.html_url || RELEASES_PAGE,
    publishedAt: best.published_at,
    asset: a ? {
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
      sha256: a.digest && /^sha256:/.test(a.digest) ? a.digest.slice(7).toLowerCase() : null,
    } : null,
  };
}

/** Download an update asset to `dest`, checking its size and (when GitHub gives one) its SHA-256. */
async function download(asset, dest, { fetchImpl = fetch, onProgress } = {}) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(asset.url)) {
    throw new Error('Refusing to download an update from outside GitHub releases.');
  }
  const res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'VN-Shelf' } });
  if (!res.ok || !res.body) throw new Error(`Update download failed (${res.status}).`);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      hash.update(b);
      got += b.length;
      if (!out.write(b)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress({ received: got, total: asset.size });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  if (asset.size && got !== asset.size) { await fsp.rm(tmp, { force: true }); throw new Error('Update download was incomplete.'); }
  const digest = hash.digest('hex');
  if (asset.sha256 && digest !== asset.sha256) { await fsp.rm(tmp, { force: true }); throw new Error('Update download failed its checksum.'); }
  await fsp.rename(tmp, dest);
  return { path: dest, sha256: digest };
}

/**
 * The file name the updated exe should get: "VN-Shelf-0.4.0-portable.exe" becomes
 * "VN-Shelf-0.4.1-portable.exe". A name without the old version in it is kept as it is.
 */
function updatedExePath(currentExe, oldVersion, newVersion) {
  const dir = path.dirname(currentExe);
  const base = path.basename(currentExe);
  if (!oldVersion || !newVersion || !base.includes(oldVersion)) return currentExe;
  return path.join(dir, base.split(oldVersion).join(newVersion));
}

/**
 * Windows: a script that waits for VN Shelf to exit, puts the new .exe in place (under `targetExe`,
 * the new version's name, removing the old file), and starts it.
 * `pids`: VN Shelf's process and the portable launcher that started it; both must be gone first.
 * `args`: extra arguments for the new exe (e.g. --hidden). Returns the script path; run it detached, then quit the app.
 */
async function writeSwapScript({ currentExe, newExe, targetExe = currentExe, pid, pids = [pid], dir, args = [] }) {
  const q = (s) => s.replace(/"/g, '');
  const waits = [...new Set(pids.filter(Boolean))];
  const renamed = path.resolve(targetExe).toLowerCase() !== path.resolve(currentExe).toLowerCase();
  const script = [
    '@echo off',
    'setlocal',
    `set "CUR=${q(currentExe)}"`,
    `set "NEW=${q(newExe)}"`,
    `set "TARGET=${q(targetExe)}"`,
    'set "LOG=%~dpn0.log"',
    `echo %DATE% %TIME% waiting for VN Shelf (pid ${waits.join(', ')}) to close>"%LOG%"`,
    'set /a WAITED=0',
    ':wait',
    'if %WAITED% GEQ 120 goto closed',
    ...waits.map((p) => `tasklist /FI "PID eq ${p}" /NH 2>nul | find " ${p} " >nul && goto waitmore`),
    'goto closed',
    ':waitmore',
    'set /a WAITED+=1',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':closed',
    'echo %TIME% closed, replacing the program>>"%LOG%"',
    'set /a TRIES=0',
    ':swap',
    'move /y "%NEW%" "%TARGET%" >>"%LOG%" 2>&1 && goto swapped',
    'set /a TRIES+=1',
    'if %TRIES% GEQ 30 goto failed',
    'ping -n 2 127.0.0.1 >nul',
    'goto swap',
    ':swapped',
    ...(renamed ? [
      'echo %TIME% removing the old version>>"%LOG%"',
      'set /a TRIES=0',
      ':delold',
      'del /f /q "%CUR%" >>"%LOG%" 2>&1',
      'if not exist "%CUR%" goto start',
      'set /a TRIES+=1',
      'if %TRIES% GEQ 15 goto start',
      'ping -n 2 127.0.0.1 >nul',
      'goto delold',
    ] : []),
    'goto start',
    ':failed',
    'echo %TIME% could not replace the program; starting the old one>>"%LOG%"',
    'set "TARGET=%CUR%"',
    ':start',
    'echo %TIME% starting VN Shelf>>"%LOG%"',
    `start "" "%TARGET%"${args.map((a) => ` "${q(a)}"`).join('')}`,
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n');
  const file = path.join(dir, `vnshelf-update-${waits[0]}.cmd`);
  await fsp.writeFile(file, script);
  return file;
}

/**
 * Run the swap script so it outlives VN Shelf. Tested on Windows 10: the script must get its own
 * console (`start /min`). Started as a plain child it dies when VN Shelf exits, and started detached
 * without a console its tasklist/ping calls hang.
 */
function launchSwapScript(script) {
  const cmd = process.env.ComSpec || 'cmd.exe';
  require('child_process').spawn(cmd, ['/d', '/c', 'start', '""', '/min', cmd, '/d', '/c', script], {
    stdio: 'ignore', windowsHide: true, detached: true,
  }).unref();
}

module.exports = { checkForUpdate, download, writeSwapScript, updatedExePath, launchSwapScript, compareVersions, parseVersion, RELEASES_PAGE, REPO };
