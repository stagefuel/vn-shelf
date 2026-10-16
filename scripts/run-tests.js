'use strict';
// Runs every test/*.test.js with Node's test runner. Lists files explicitly so it behaves the same
// on Windows (no shell globbing) and on every Node version. TMPDIR points at one folder for this run,
// deleted afterwards, so the tests' temp files never pile up (where /tmp is in memory, they add up).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-test-'));
let status = 1;
try {
  const testDir = path.join(__dirname, '..', 'test');
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(testDir, f));
  const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
  });
  status = r.status === null ? 1 : r.status;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
