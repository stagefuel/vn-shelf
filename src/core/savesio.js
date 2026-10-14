'use strict';
// Save export/import as a .zip: export this PC's current saves for a game; import a zip made by
// VN Shelf (on any PC) after backing up what's here. Works the same in folder and Drive mode.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createZip, readZip } = require('./zip');

const MANIFEST = 'vnshelf-export.json';

async function exportSaves(engine, game, installDir) {
  const local = await engine.scanLocal(game, installDir);
  const entries = [];
  for (const [key, abs] of Object.entries(local.files)) {
    const st = await fsp.stat(abs);
    entries.push({ name: `saves/${key}`, data: await fsp.readFile(abs), mtime: st.mtime });
  }
  entries.unshift({
    name: MANIFEST,
    data: Buffer.from(JSON.stringify({
      format: 1,
      app: 'VN Shelf',
      game: { id: game.id, title: game.title, vndbId: game.vndbId || null },
      rules: (game.saves || []).map((r) => ({ id: r.id, path: r.path, include: r.include || [] })),
      device: engine.deviceName,
      exportedAt: new Date().toISOString(),
      hashes: local.hashes,
    }, null, 2)),
  });
  return { zip: createZip(entries), files: Object.keys(local.files).length };
}

/** Look inside an export without changing anything. */
function inspect(buf) {
  const entries = readZip(buf);
  const m = entries.find((e) => e.name === MANIFEST);
  if (!m) throw Object.assign(new Error('That zip was not made by VN Shelf\'s save export.'), { code: 'not-export' });
  const manifest = JSON.parse(m.data.toString('utf8'));
  return { manifest, entries: entries.filter((e) => e.name.startsWith('saves/')) };
}

/**
 * Put an exported zip's saves on this PC. Current saves are backed up to History first, and only
 * the save locations that are in the zip are replaced. Rules are matched by id, then by path.
 * @returns {{files: number, skipped: number, fromGame: string}}
 */
async function importSaves(engine, game, installDir, buf) {
  const { manifest, entries } = inspect(buf);
  const byId = new Map((game.saves || []).map((r) => [r.id, r]));
  const byPath = new Map((game.saves || []).map((r) => [`${r.path}|${(r.include || []).join(',')}`, r]));
  const map = new Map();
  for (const r of manifest.rules || []) {
    const mine = byId.get(r.id) || byPath.get(`${r.path}|${(r.include || []).join(',')}`);
    if (mine) map.set(r.id, mine.id);
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vns-import-'));
  try {
    const hashes = {};
    const used = new Set();
    let skipped = 0;
    for (const e of entries) {
      const key = e.name.slice('saves/'.length);
      const slash = key.indexOf('/');
      const target = map.get(key.slice(0, slash));
      const rel = key.slice(slash + 1);
      if (slash < 0 || !target || rel.split('/').some((p) => p === '..' || p === '')) { skipped++; continue; }
      const newKey = `${target}/${rel}`;
      const dest = path.join(tmp, ...newKey.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, e.data);
      hashes[newKey] = crypto.createHash('sha1').update(e.data).digest('hex');
      used.add(target);
    }
    if (!used.size) {
      throw Object.assign(new Error('None of the saves in that zip match this game\'s save locations.'), { code: 'no-match' });
    }
    await engine.requireCloud();
    const local = await engine.scanLocal(game, installDir);
    await engine.backupLocal(game, local, 'before-import');
    // Only the locations present in the zip are replaced; others are left alone.
    const subset = { ...game, saves: game.saves.filter((r) => used.has(r.id)) };
    await engine.apply(subset, installDir, tmp, hashes, local);
    return { files: Object.keys(hashes).length, skipped, fromGame: manifest.game ? manifest.game.title : '' };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

module.exports = { exportSaves, importSaves, inspect, MANIFEST };
