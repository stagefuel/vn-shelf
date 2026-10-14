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

// ---- Windows: uses a copy of ping.exe as a stand-in "game" (ping -n N waits ~N-1 seconds).
// The game runs ~12 s because a cold PowerShell (e.g. on a CI runner) can take several seconds to report.
function winGameDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-lw-'));
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE'), path.join(dir, 'game.exe'));
  return dir;
}

test('Windows: tracks a game exe until it exits', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const { execFile } = require('child_process');
  const dir = winGameDir();
  let sawPids = false;
  let closedAt = 0;
  // The stand-in game would run ~60 s; it is closed 2 s after the PowerShell watcher first sees it,
  // so a slow (cold) machine only makes the test take longer instead of failing it.
  const info = await new Promise((resolve) => {
    const ev = launch({ exePath: path.join(dir, 'game.exe'), installDir: dir, args: '-n 60 127.0.0.1', pollMs: 500, graceMs: 2500 });
    ev.on('running', (pids) => {
      if (sawPids) return;
      sawPids = true;
      setTimeout(() => { closedAt = Date.now(); for (const p of pids) execFile('taskkill', ['/PID', String(p), '/F'], () => {}); }, 2000);
    });
    ev.on('exit', resolve);
  });
  assert.strictEqual(info.reason, 'closed');
  assert.ok(sawPids, 'PowerShell watcher reported the game process');
  const after = (Date.now() - closedAt) / 1000;
  assert.ok(closedAt && after < 15, `noticed the game closing ${after}s after it closed`);
});

test('Windows: a .cmd launcher that starts the game and exits is followed to the real game', { skip: process.platform !== 'win32' }, async () => {
  const dir = winGameDir();
  fs.writeFileSync(path.join(dir, 'launch.cmd'), '@start "" "%~dp0game.exe" -n 8 127.0.0.1\r\n@exit /b 0\r\n');
  const t0 = Date.now();
  const info = await new Promise((resolve) => {
    launch({ exePath: path.join(dir, 'launch.cmd'), installDir: dir, pollMs: 500, graceMs: 2500 }).on('exit', resolve);
  });
  const secs = (Date.now() - t0) / 1000;
  assert.strictEqual(info.reason, 'closed');
  assert.ok(secs >= 7, `ended after ${secs}s, before the real game closed`);
});

test('play time counts only while the game runs: not the launcher gap or the wait after it closes', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-lp-'));
  const game = path.join(dir, 'game.sh');
  fs.writeFileSync(game, '#!/bin/sh\nsleep 3\n');
  fs.chmodSync(game, 0o755);
  const info = await new Promise((resolve) => {
    launch({ exePath: game, installDir: dir, pollMs: 200, graceMs: 2000 }).on('exit', resolve);
  });
  assert.strictEqual(info.reason, 'closed');
  assert.ok(info.durationMs >= info.playedMs + 1500, `tracking ran ${info.durationMs} ms, which includes the wait after closing`);
  assert.ok(info.playedMs >= 2700 && info.playedMs <= 3600, `counted ${info.playedMs} ms for a 3 s game`);
});

test('Windows admin games: asks for rights, and "No" ends cleanly as declined', async () => {
  const { EventEmitter } = require('events');
  // A start that Windows refuses with "requires elevation" (Node: EACCES), then the owner's answer.
  const refuse = () => { const c = new EventEmitter(); c.unref = () => {}; c.pid = undefined; setImmediate(() => c.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))); return c; };
  for (const [answer, want] of [[{ declined: true }, 'declined'], [{ error: 'boom' }, 'failed']]) {
    let asked = 0;
    const events = [];
    const info = await new Promise((resolve) => {
      const ev = launch({ exePath: 'C:\\Games\\X\\x.exe', installDir: 'C:\\Games\\X', platform: 'win32', pollMs: 100, graceMs: 300,
        spawnImpl: refuse, elevateImpl: async (cmd) => { asked++; assert.strictEqual(cmd, 'C:\\Games\\X\\x.exe'); return answer; } });
      ev.on('elevating', () => events.push('elevating'));
      ev.on('exit', resolve);
    });
    assert.strictEqual(asked, 1);
    assert.deepStrictEqual(events, ['elevating']);
    assert.strictEqual(info.reason, want);
  }
});

test('watch-only: follows a game that is already running and reports when it closes', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-lwo-'));
  const game = path.join(dir, 'game.sh');
  fs.writeFileSync(game, '#!/bin/sh\nsleep 2\n');
  fs.chmodSync(game, 0o755);
  spawn(game, [], { stdio: 'ignore', detached: true }).unref();
  await new Promise((r) => setTimeout(r, 300));
  const info = await new Promise((resolve) => {
    launch({ exePath: null, installDir: dir, pollMs: 200, graceMs: 800 }).on('exit', resolve);
  });
  assert.strictEqual(info.reason, 'closed');
  assert.ok(info.playedMs >= 1000, `counted ${info.playedMs} ms`);
});
