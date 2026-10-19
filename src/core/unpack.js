'use strict';
// Unpacking a downloaded VN with 7-Zip: archives (.rar, multi-part .rar, .zip, .7z, .lzh) are
// extracted; disc images (.iso, .mdf, .bin/.cue, .cdi, .img) are left for you to mount and install;
// a plain folder is used as it is.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const ARCHIVE = /\.(rar|zip|7z|lzh|lha)$/i;
const DISC = /\.(iso|mdf|mds|bin|cue|cdi|img|ccd|sub|nrg)$/i;
const PART = /\.part0*(\d+)\.rar$/i;

/** 7-Zip: the path from settings, then the usual install places, then the PATH. */
async function find7z(configured) {
  const tries = [configured];
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
      if (pf) tries.push(path.join(pf, '7-Zip', '7z.exe'));
    }
  }
  for (const t of tries) {
    if (t && fs.existsSync(t)) return t;
  }
  const names = process.platform === 'win32' ? ['7z.exe'] : ['7z', '7zz', '7za'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * What to do with a downloaded item's files (paths relative to its folder):
 * { extract: [first file of each archive set], discs: [...], other: [...] }.
 * Only part 1 of a multi-part rar is extracted (7-Zip finds the rest); archives inside folders
 * named like extras/bonus/crack/update are left alone, as are archives next to a disc image.
 */
function plan(files) {
  const extract = [];
  const discs = [];
  const other = [];
  const hasDisc = files.some((f) => /\.(iso|mdf|cue|cdi|ccd|img)$/i.test(f));
  for (const f of files) {
    const base = path.posix.basename(f);
    const m = PART.exec(base);
    if (DISC.test(base)) discs.push(f);
    else if (m) { if (Number(m[1]) === 1) extract.push(f); else other.push(f); }
    else if (ARCHIVE.test(base) && !hasDisc && !/(^|\/)(extras?|bonus|tokuten|特典|crack|update|patch(es)?)\//i.test(f)) extract.push(f);
    else other.push(f);
  }
  return { extract, discs, other };
}

/** Run 7-Zip to extract `archive` into `outDir`. onProgress gets 0–100. */
function extract(sevenZip, archive, outDir, { onProgress, password } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['x', '-y', '-bsp1', '-bb0', `-o${outDir}`, password ? `-p${password}` : '-p', archive];
    const p = spawn(sevenZip, args, { windowsHide: true });
    let err = '';
    p.stdout.on('data', (d) => {
      const m = /(\d+)%/.exec(String(d));
      if (m && onProgress) onProgress(Number(m[1]));
    });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      if (/wrong password|encrypted/i.test(err)) return reject(Object.assign(new Error('This archive needs a password.'), { code: 'password' }));
      reject(new Error(`7-Zip couldn't extract ${path.basename(archive)}${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}.`));
    });
  });
}

/** Remove what extraction made redundant: the archives themselves, once everything extracted. */
async function removeArchives(dir, extracted) {
  for (const f of extracted) {
    const m = PART.exec(path.basename(f));
    const set = m ? (await fsp.readdir(path.join(dir, path.dirname(f)))).filter((n) => n.startsWith(path.basename(f).slice(0, m.index)) && PART.test(n))
      .map((n) => path.join(path.dirname(f), n)) : [f];
    for (const s of set) await fsp.rm(path.join(dir, s), { force: true });
  }
}

/**
 * Pack a folder into one .zip with 7-Zip, for uploading. `skip`: folders inside it (relative, "/")
 * to leave out, such as the game's own save folders. Stored without compression: game data is
 * compressed already, so this is fast and barely bigger. onProgress gets 0–100; aborting stops it.
 */
async function pack(sevenZip, dir, outZip, { skip = [], onProgress, signal } = {}) {
  const skipSet = skip.map((x) => x.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()).filter(Boolean);
  const files = [];
  const walk = async (rel) => {
    for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skipSet.some((x) => r.toLowerCase() === x || r.toLowerCase().startsWith(`${x}/`))) continue;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && !/\.uploading\.tmp$/i.test(e.name)) files.push(r);
    }
  };
  await walk('');
  if (!files.length) throw new Error('There is nothing to upload in that folder.');
  await fsp.mkdir(path.dirname(outZip), { recursive: true });
  await fsp.rm(outZip, { force: true });
  const list = `${outZip}.list`;
  await fsp.writeFile(list, `${files.join('\n')}\n`, 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(sevenZip, ['a', '-tzip', '-mx=0', '-mcu=on', '-bsp1', '-bb0', '-scsUTF-8', outZip, `@${list}`], { cwd: dir, windowsHide: true });
      let err = '';
      const stop = () => { try { p.kill(); } catch { /* gone */ } };
      if (signal) { if (signal.aborted) stop(); signal.addEventListener('abort', stop, { once: true }); }
      p.stdout.on('data', (d) => { const m = /(\d+)%/.exec(String(d)); if (m && onProgress) onProgress(Number(m[1])); });
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', reject);
      p.on('close', (code) => {
        if (signal && signal.aborted) return reject(Object.assign(new Error('Stopped.'), { code: 'aborted' }));
        if (code === 0) return resolve();
        reject(new Error(`7-Zip couldn't pack the folder${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}.`));
      });
    });
  } catch (e) {
    await fsp.rm(outZip, { force: true }).catch(() => {});
    throw e;
  } finally {
    await fsp.rm(list, { force: true }).catch(() => {});
  }
  return { file: outZip, files: files.length };
}

module.exports = { find7z, plan, extract, removeArchives, pack, ARCHIVE, DISC };
