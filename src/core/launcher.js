'use strict';
// Start a game and tell us when it has really finished.
//
// Many VNs start through a launcher .exe that spawns the real game and exits, and Locale
// Emulator does the same. So instead of waiting on the process we started, we watch for ANY
// running program whose .exe lives inside the game folder, and call the game closed once none
// have been seen for a few seconds.

const { spawn, execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** PIDs of running programs whose executable is inside `dir`. Returns null if the check itself failed. */
async function processesUnder(dir, platform = process.platform) {
  if (platform === 'win32') {
    const script = "$d=$env:VNS_DIR.TrimEnd('\\')+'\\'; " +
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
      'ForEach-Object { $_.ProcessId }';
    const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, VNS_DIR: dir },
    });
    if (out === null) return null;
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  // Linux (incl. games under Wine): match the exe link or the command line.
  const pids = [];
  let entries;
  try { entries = await fsp.readdir('/proc'); } catch { return null; }
  const winDir = dir.replace(/\//g, '\\');
  for (const pid of entries) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const exe = await fsp.readlink(`/proc/${pid}/exe`).catch(() => '');
      const cmd = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).replace(/\0/g, ' ');
      if (exe.startsWith(dir + '/') || cmd.includes(dir + '/') || cmd.includes(winDir + '\\')) pids.push(Number(pid));
    } catch { /* gone */ }
  }
  return pids;
}

/**
 * Launch a game. Returns an EventEmitter that emits:
 *   'started'  ()            the process was spawned
 *   'running'  (pids)        game processes seen
 *   'exit'     ({ reason })  the game is closed (reason: 'closed' | 'stopped' | 'failed')
 * and has .stop() to stop tracking manually.
 */
function launch({ exePath, installDir, args = '', localeEmulatorPath = '', useLocaleEmulator = false,
  platform = process.platform, pollMs = 2500, graceMs = 6000 }) {
  const ev = new EventEmitter();
  const cwd = path.dirname(exePath);
  const extra = args ? args.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, '')) : [];

  let cmd = exePath;
  let argv = extra;
  if (useLocaleEmulator && localeEmulatorPath) {
    cmd = localeEmulatorPath;
    argv = ['-run', exePath, ...extra];
  } else if (platform !== 'win32' && /\.exe$/i.test(exePath)) {
    cmd = 'wine';
    argv = [exePath, ...extra];
  }

  let child;
  let childAlive = true;
  let done = false;
  const startedAt = Date.now();
  let lastSeen = startedAt;
  let timer = null;

  const finish = (reason, error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ev.emit('exit', { reason, error, durationMs: Date.now() - startedAt });
  };

  try {
    child = spawn(cmd, argv, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  } catch (e) {
    setImmediate(() => finish('failed', e.message));
    return Object.assign(ev, { stop() {} });
  }
  child.on('error', (e) => { childAlive = false; finish('failed', e.message); });
  child.on('exit', () => { childAlive = false; });
  child.unref();
  setImmediate(() => ev.emit('started'));

  const tick = async () => {
    if (done) return;
    const pids = await processesUnder(installDir, platform);
    const now = Date.now();
    if (childAlive || (pids && pids.length) || pids === null) {
      // pids === null means the check failed; keep waiting rather than end early.
      lastSeen = now;
      if (pids && pids.length) ev.emit('running', pids);
    }
    if (!done && now - lastSeen >= graceMs && now - startedAt >= graceMs) return finish('closed');
    timer = setTimeout(tick, pollMs);
  };
  timer = setTimeout(tick, Math.min(pollMs, 1500));

  ev.stop = () => finish('stopped');
  return ev;
}

module.exports = { launch, processesUnder };
