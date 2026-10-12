'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('../src/core/launcher');

// A "launcher" that starts the real game in the background and exits at once,
// the way many VN launchers and Locale Emulator behave.
test('keeps tracking after a launcher exits while the real game runs', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-l-'));
  const game = path.join(dir, 'realgame.sh');
  fs.writeFileSync(game, '#!/bin/sh\nsleep 4\n');
  fs.chmodSync(game, 0o755);
  const starter = path.join(dir, 'launcher.sh');
  fs.writeFileSync(starter, `#!/bin/sh\n"${game}" &\nexit 0\n`);
  fs.chmodSync(starter, 0o755);
  const t0 = Date.now();
  const info = await new Promise((resolve) => {
    launch({ exePath: starter, installDir: dir, pollMs: 300, graceMs: 1000 }).on('exit', resolve);
  });
  const secs = (Date.now() - t0) / 1000;
  assert.strictEqual(info.reason, 'closed');
  assert.ok(secs >= 4, `ended after ${secs}s, before the real game closed`);
  assert.ok(secs < 8, `took ${secs}s to notice the game closed`);
});

test('a program that cannot start reports failure', async () => {
  const info = await new Promise((resolve) => {
    launch({ exePath: path.join(os.tmpdir(), 'does-not-exist-vns.sh'), installDir: os.tmpdir(), pollMs: 200, graceMs: 500 }).on('exit', resolve);
  });
  assert.strictEqual(info.reason, 'failed');
});
