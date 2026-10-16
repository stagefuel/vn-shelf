'use strict';
// The UI smoke tests' temp folder (Electron profile, fake games, downloads): deleted when the
// script ends, however it ends.
const fs = require('fs');
const os = require('os');
const path = require('path');

function smokeTmp(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const clean = () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { clean(); process.exit(1); });
  return base;
}

module.exports = { smokeTmp };
