'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/** Convert a simple glob ("**", "*", "?") to a RegExp matched against a forward-slash relative path. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function makeMatcher(include, exclude) {
  const inc = (include && include.length ? include : ['**']).map(globToRegex);
  const exc = (exclude || []).map(globToRegex);
  return (rel) => inc.some((r) => r.test(rel)) && !exc.some((r) => r.test(rel));
}

/**
 * List files under `dir` as forward-slash relative paths.
 * `prune(relDir, name)` may return true to skip a directory.
 */
async function walk(dir, { filter, prune, maxDepth = 32, limit = Infinity } = {}) {
  const out = [];
  async function rec(abs, rel, depth) {
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (prune && prune(r, e.name)) continue;
        await rec(a, r, depth + 1);
      } else if (e.isFile()) {
        if (!filter || filter(r)) out.push(r);
      }
    }
  }
  await rec(dir, '', 0);
  return out;
}

/**
 * Retry an operation that can fail for a moment on Windows: a game that has just closed (or an
 * antivirus / sync app) may still hold the file. Other errors fail straight away.
 */
async function withRetry(fn, { tries = 6, delayMs = 150 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

async function hashFile(p) {
  // Reading the whole file also forces cloud placeholders (OneDrive/Drive "online-only") to download.
  return withRetry(() => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  }));
}

/**
 * A copy a sync app made of a file it couldn't merge, not a file of ours: Dropbox's
 * "save (Desktop's conflicted copy 2026-10-14).dat", its Japanese "競合コピー", OneDrive's
 * "save-COMPUTERNAME.dat" (when `computers` names that PC) and Google Drive's "save (1).dat".
 * Only used for cloud-side files that no manifest lists, so a real "save (1).dat" is never lost.
 */
function isSyncDuplicate(name, computers = []) {
  const base = String(name).replace(/\.[^.\\/]*$/, '');
  if (/\([^()]*(conflicted copy|競合コピー|conflict)[^()]*\)/i.test(name)) return true;
  if (/ \(\d+\)$/.test(base)) return true;
  return computers.some((c) => c && base.toLowerCase().endsWith(`-${String(c).toLowerCase()}`));
}

async function copyFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await withRetry(() => fsp.copyFile(src, dest));
  // Keep the original modified time; some engines show it in their save menus.
  try {
    const st = await fsp.stat(src);
    await fsp.utimes(dest, st.atime, st.mtime);
  } catch { /* best effort */ }
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

async function readJson(p, fallback = null) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
}

/** Write JSON via a temp file + rename so a sync client never sees a half-written file. */
const writeQueues = new Map(); // path -> promise of the write in progress
function writeJson(p, data) {
  // Writes to the same file run one after another: Windows refuses to rename over a file while
  // another rename of it is in progress (EPERM), and the last write must win.
  const body = JSON.stringify(data, null, 2);
  const prev = writeQueues.get(p) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeJsonNow(p, body));
  writeQueues.set(p, next);
  next.finally(() => { if (writeQueues.get(p) === next) writeQueues.delete(p); }).catch(() => {});
  return next;
}

async function writeJsonNow(p, body) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // Unique per call, in case another process writes the same file at the same moment.
  const tmp = `${p}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, body);
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(tmp, p); return; } catch (e) {
      // Antivirus, indexers and sync clients can hold a file for a moment on Windows.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 8) { await fsp.rm(tmp, { force: true }); throw e; }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** Rename, falling back to copy+delete (e.g. across drives, or when a sync client holds a handle briefly). */
async function moveDir(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await fsp.rename(src, dest); return; } catch (e) {
      if (e.code === 'EXDEV') break;
      if (attempt === 4) break;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true });
  await rmrf(src);
}

function timestamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function safeName(s) {
  return String(s).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pc';
}

module.exports = {
  exists, isDir, globToRegex, makeMatcher, walk, hashFile, copyFile, rmrf, withRetry, isSyncDuplicate,
  readJson, writeJson, moveDir, timestamp, safeName,
};
