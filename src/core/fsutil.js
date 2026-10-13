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

async function hashFile(p) {
  // Reading the whole file also forces cloud placeholders (OneDrive/Drive "online-only") to download.
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function copyFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
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
async function writeJson(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, p);
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
  exists, isDir, globToRegex, makeMatcher, walk, hashFile, copyFile, rmrf,
  readJson, writeJson, moveDir, timestamp, safeName,
};
