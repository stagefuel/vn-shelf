'use strict';
// Remembers the SHA-1 of save files by path, size and modified time, so checking whether saves
// changed doesn't re-read every file each time. Kept in one JSON file on this PC.
//
// A file modified within a few seconds of being hashed isn't trusted later ("racily clean", as git
// calls it): on drives with coarse timestamps (FAT32/exFAT: 2 s) it could change again without its
// modified time moving.

const fsu = require('./fsutil');

const RACY_MS = 3000;
const FORGET_AFTER_MS = 90 * 24 * 3600 * 1000; // entries for files not seen in 90 days are dropped

class HashCache {
  /** @param {string|null} file  where to keep it; null keeps it in memory only */
  constructor(file = null) {
    this.file = file;
    this.map = new Map(); // path -> { s: size, m: mtime (ns, string), h: hash, at: hashed at (ms), seen: ms }
    this.dirty = false;
    this.timer = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    const data = await fsu.readJson(this.file, null);
    const now = Date.now();
    if (data && typeof data === 'object') {
      for (const [p, e] of Object.entries(data)) if (e && now - (e.seen || 0) < FORGET_AFTER_MS) this.map.set(p, e);
    }
  }

  /** The cached hash if the file is unchanged, else null. `mtimeNs` is a BigInt or string. */
  get(p, size, mtimeNs) {
    const e = this.map.get(p);
    if (!e || e.s !== size || e.m !== String(mtimeNs)) return null;
    if (e.at - Number(BigInt(mtimeNs) / 1000000n) < RACY_MS) return null;
    e.seen = Date.now();
    return e.h;
  }

  set(p, size, mtimeNs, hash, hashedAt = Date.now()) {
    this.map.set(p, { s: size, m: String(mtimeNs), h: hash, at: hashedAt, seen: Date.now() });
    this.dirty = true;
    this.scheduleSave();
  }

  /** Hash a file, using the cache when its size and modified time haven't changed. */
  async hash(p, st = null) {
    const stat = st || (await require('fs').promises.stat(p, { bigint: true }));
    const size = Number(stat.size);
    const hit = this.get(p, size, stat.mtimeNs);
    if (hit) return hit;
    const at = Date.now();
    const h = await fsu.hashFile(p);
    this.set(p, size, stat.mtimeNs, h, at);
    return h;
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save().catch(() => {}); }, 2000);
    if (this.timer.unref) this.timer.unref();
  }

  async save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await fsu.writeJson(this.file, Object.fromEntries(this.map));
  }
}

module.exports = { HashCache };
