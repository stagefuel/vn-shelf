'use strict';
// Start a game and tell us when it has really finished, and for how long it really ran.
//
// Many VNs start through a launcher .exe that spawns the real game and exits, and Locale
// Emulator does the same. So instead of waiting on the process we started, we watch for ANY
// running program whose .exe lives inside the game folder (plus, on Windows, programs the game
// itself started that we aren't allowed to look into, such as one running as administrator), and
// call the game closed once none have been seen for a few seconds.
//
// Play time counts only the time something of the game's was seen running: the gap between a
// launcher closing and the game appearing doesn't count, the grace period after it closes doesn't
// count, and neither does time the PC spent asleep (the checks stop while it sleeps, and a long
// gap between two checks is never counted).

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
 * Windows: one long-running PowerShell that reports, every ~2 s, the game's running processes:
 * programs whose .exe is inside `dir`, plus descendants of `rootPids` whose path Windows won't show
 * us (a game running as administrator). Visible programs outside the folder that the game opened
 * (a browser for its website, say) don't count, or the game would never look closed.
 * One PowerShell for the whole session is far cheaper than starting one per check.
 */
function windowsWatcher(dir, intervalMs, rootPids = []) {
  const script = "$d=$env:VNS_DIR.TrimEnd('\\')+'\\'; [Console]::Out.AutoFlush=$true; " +
    '$fam=@{}; foreach ($r in ($env:VNS_ROOTS -split \',\' | Where-Object { $_ })) { $fam[[int]$r]=1 }; ' +
    'while ($true) { ' +
    '$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath); ' +
    '$alive=@{}; foreach ($p in $all) { $alive[[int]$p.ProcessId]=1 }; ' +
    'foreach ($k in @($fam.Keys)) { if (-not $alive.ContainsKey($k)) { $fam.Remove($k) } }; ' +
    'do { $added=$false; foreach ($p in $all) { $i=[int]$p.ProcessId; ' +
    'if (-not $fam.ContainsKey($i) -and $fam.ContainsKey([int]$p.ParentProcessId)) { $fam[$i]=1; $added=$true } } } while ($added); ' +
    '$out = foreach ($p in $all) { $i=[int]$p.ProcessId; $x=$p.ExecutablePath; ' +
    'if (($x -and $x.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)) -or ($fam.ContainsKey($i) -and -not $x)) { $i } }; ' +
    "[Console]::Out.WriteLine('PIDS ' + ($out -join ',')); " +
    `Start-Sleep -Milliseconds ${intervalMs} }`;
  const w = { pids: null, failed: false, proc: null };
  try {
    w.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, VNS_DIR: dir, VNS_ROOTS: rootPids.join(',') }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
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

/**
 * Windows: start a program through Windows' own "Do you want to allow this app to make changes?"
 * prompt, for games that need administrator rights (a normal start fails with error 740).
 * Resolves { pid } or { declined: true } (the owner said No) or { error }.
 */
function startElevated(cmd, argv, cwd) {
  const script = '$ErrorActionPreference="Stop"; try { ' +
    '$a=@{ FilePath=$env:VNS_CMD; WorkingDirectory=$env:VNS_CWD; Verb="RunAs"; PassThru=$true }; ' +
    'if ($env:VNS_ARGS) { $a.ArgumentList=$env:VNS_ARGS }; ' +
    '$p = Start-Process @a; [Console]::Out.Write("PID " + $p.Id) } catch { ' +
    '$e=$_.Exception; while ($e -and -not ($e -is [ComponentModel.Win32Exception])) { $e=$e.InnerException }; ' +
    'if ($e -and $e.NativeErrorCode -eq 1223) { [Console]::Out.Write("DECLINED") } else { [Console]::Out.Write("ERROR " + $_.Exception.Message) } }';
  const quoted = argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  return execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, VNS_CMD: cmd, VNS_CWD: cwd, VNS_ARGS: quoted }, timeout: 120000,
  }).then((out) => {
    const text = String(out || '').trim();
    if (text.startsWith('PID ')) return { pid: Number(text.slice(4)) };
    if (text === 'DECLINED') return { declined: true };
    return { error: text.replace(/^ERROR /, '') || 'couldn\'t start with administrator rights' };
  });
}

/** Is any program from inside `dir` running right now? (A one-off check, e.g. before replacing saves.) */
async function isRunningFrom(dir, platform = process.platform) {
  if (!dir) return false;
  if (platform !== 'win32') return ((await linuxProcessesUnder(dir)) || []).length > 0;
  const script = "$d=$env:VNS_DIR.TrimEnd('\\')+'\\'; " +
    '@(Get-CimInstance Win32_Process -Property ExecutablePath | Where-Object { $_.ExecutablePath -and ' +
    "$_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) }).Count";
  const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, VNS_DIR: dir }, timeout: 20000,
  });
  return Number(String(out || '0').trim()) > 0;
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
 *   'started'   ()            the process was spawned
 *   'elevating' ()            Windows is asking the owner for administrator rights
 *   'running'   (pids)        game processes seen
 *   'exit'      ({ reason, error, durationMs, playedMs })  the game is closed
 *               reason: 'closed' | 'stopped' | 'failed' | 'declined' (No to the administrator prompt)
 *               playedMs: time the game was actually running (see the top of this file)
 * and has .stop() to stop tracking manually.
 */
function launch({ exePath, installDir, args = '', localeEmulatorPath = '', useLocaleEmulator = false,
  platform = process.platform, pollMs = 2500, graceMs = 6000, spawnImpl = spawn, elevateImpl = startElevated }) {
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
  // Play time: the sum of the gaps between consecutive checks that both saw the game running.
  let playedMs = 0;
  let lastAliveCheck = startedAt; // the start counts as a sighting: the game was just launched
  const maxGap = pollMs * 3; // longer than this between two checks = the PC slept; don't count it

  const finish = (reason, error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (watcher && watcher.stop) watcher.stop();
    ev.emit('exit', { reason, error, durationMs: Date.now() - startedAt, playedMs: Math.round(playedMs) });
  };

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
    const alive = childAlive || (pids && pids.length) || pids === null;
    if (alive) {
      if (lastAliveCheck !== null && now - lastAliveCheck <= maxGap) playedMs += now - lastAliveCheck;
      lastAliveCheck = now;
      lastSeen = now;
      if (pids && pids.length) ev.emit('running', pids);
    } else {
      // Gone since the last check: count up to halfway, the best guess of when it closed.
      if (lastAliveCheck !== null && now - lastAliveCheck <= maxGap) playedMs += (now - lastAliveCheck) / 2;
      lastAliveCheck = null;
    }
    if (!done && now - lastSeen >= graceMs && now - startedAt >= graceMs) return finish('closed');
    timer = setTimeout(tick, pollMs);
  };

  const startWatching = (rootPids) => {
    watcher = platform === 'win32' ? windowsWatcher(installDir, Math.min(pollMs, 2000), rootPids) : null;
    timer = setTimeout(tick, Math.min(pollMs, 1500));
  };

  // A game that needs administrator rights: ask Windows for them, then follow it by its process id.
  const elevate = async () => {
    childAlive = false;
    ev.emit('elevating');
    const r = await elevateImpl(cmd, argv, cwd);
    if (done) return;
    if (r.declined) return finish('declined', 'The game needs administrator rights, and permission wasn\'t given.');
    if (!r.pid) return finish('failed', r.error || 'couldn\'t start with administrator rights');
    lastSeen = Date.now();
    lastAliveCheck = lastSeen;
    startWatching([r.pid]);
  };

  try {
    child = spawnImpl(cmd, argv, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  } catch (e) {
    if (platform === 'win32' && e.code === 'EACCES') { elevate(); return Object.assign(ev, { stop: () => finish('stopped') }); }
    setImmediate(() => finish('failed', e.message));
    return Object.assign(ev, { stop() {} });
  }
  let spawned = false;
  child.on('spawn', () => { spawned = true; });
  child.on('error', (e) => {
    childAlive = false;
    // Windows answers error 740 ("requires elevation"), which Node reports as EACCES.
    if (platform === 'win32' && e.code === 'EACCES' && !spawned) { clearTimeout(timer); if (watcher && watcher.stop) watcher.stop(); watcher = null; elevate(); return; }
    finish('failed', e.message);
  });
  child.on('exit', () => { childAlive = false; });
  child.unref();
  setImmediate(() => ev.emit('started'));
  startWatching(child.pid ? [child.pid] : []);

  ev.stop = () => finish('stopped');
  return ev;
}

module.exports = { launch, linuxProcessesUnder, windowsWatcher, startElevated, isRunningFrom };
