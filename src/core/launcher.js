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

/**
 * Windows: one long-running PowerShell that reports, every 2 s, the PIDs of programs whose
 * .exe is inside `dir`. Cheaper than starting PowerShell on every check.
 */
function windowsWatcher(dir, intervalMs) {
  const script = "$d=$env:VNS_DIR.TrimEnd('\\')+'\\'; [Console]::Out.AutoFlush=$true; " +
    'while ($true) { ' +
    '$p = Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | ' +
    'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
    'ForEach-Object { $_.ProcessId }; ' +
    "[Console]::Out.WriteLine('PIDS ' + ($p -join ',')); " +
    `Start-Sleep -Milliseconds ${intervalMs} }`;
  const w = { pids: null, failed: false, proc: null };
  try {
    w.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, VNS_DIR: dir }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    w.failed = true;
    return w;
  }
  let buf = '';
  w.proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('PIDS')) w.pids = line.slice(4).split(',').map((x) => Number(x.trim())).filter(Boolean);
    }
  });
  w.proc.on('error', () => { w.failed = true; });
  w.proc.on('exit', () => { w.failed = true; });
  w.stop = () => { try { w.proc.kill(); } catch { /* gone */ } };
  return w;
}

/** Linux (incl. games under Wine): PIDs whose exe or command line points inside `dir`. */
async function linuxProcessesUnder(dir) {
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
  } else if (platform === 'win32' && /\.(bat|cmd)$/i.test(exePath)) {
    // Node refuses to spawn batch files directly; run them through cmd.
    cmd = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/c', exePath, ...extra];
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
  let watcher = null;

  const finish = (reason, error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (watcher && watcher.stop) watcher.stop();
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

  watcher = platform === 'win32' ? windowsWatcher(installDir, Math.min(pollMs, 2000)) : null;

  const tick = async () => {
    if (done) return;
    let pids;
    if (watcher) {
      // Until the watcher reports, assume running. If PowerShell isn't usable, fall back
      // to the process we started (launchers that exit early then need "Stop tracking").
      pids = watcher.failed ? [] : watcher.pids;
    } else {
      pids = await linuxProcessesUnder(installDir);
    }
    const now = Date.now();
    if (childAlive || (pids && pids.length) || pids === null) {
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

module.exports = { launch, linuxProcessesUnder, windowsWatcher };
