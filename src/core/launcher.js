'use strict';
// Start a game and tell us when it has really finished, and for how long it really ran.
//
// Many VNs start through a launcher .exe that spawns the real game and exits, and Locale
// Emulator does the same. So instead of waiting on the process we started, we watch for ANY
// running program whose .exe lives inside the game folder (plus, on Windows, programs the game
// itself started that we aren't allowed to look into, such as one running as administrator), and
// call the game closed once none have been seen for a few seconds: about 2 s once it has been
// running a while, longer just after starting (a launcher handing over to the game).
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
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d=$env:VNS_DIR.TrimEnd('\\')+'\\'; [Console]::Out.AutoFlush=$true; " +
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
    // The game's window title: usually the game's real name (used to tidy up folder-name titles).
    "$tt=''; foreach ($i in @($out)) { try { $w=[Diagnostics.Process]::GetProcessById($i).MainWindowTitle; if ($w) { $tt=$w; break } } catch {} }; " +
    "if ($tt) { [Console]::Out.WriteLine('TITLE ' + $tt) }; " +
    `Start-Sleep -Milliseconds ${intervalMs} }`;
  const w = { pids: null, failed: false, proc: null, title: null };
  try {
    w.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, VNS_DIR: dir, VNS_ROOTS: rootPids.join(',') }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    w.failed = true;
    return w;
  }
  let buf = '';
  w.proc.stdout.setEncoding('utf8');
  w.proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('PIDS')) w.pids = line.slice(4).split(',').map((x) => Number(x.trim())).filter(Boolean);
      else if (line.startsWith('TITLE ')) w.title = line.slice(6).trim();
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

/** Ask programs to close, like clicking their X (the game may ask "Quit?"). */
async function closeWindows(pids, platform = process.platform) {
  if (platform !== 'win32') {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    return true;
  }
  const script = "$n=0; foreach ($i in ($env:VNS_PIDS -split ',')) { try { $p=Get-Process -Id ([int]$i) -ErrorAction Stop; " +
    'if ($p.MainWindowHandle -ne 0) { if ($p.CloseMainWindow()) { $n++ } } } catch {} }; [Console]::Out.Write($n)';
  const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, VNS_PIDS: pids.join(',') }, timeout: 20000,
  });
  return Number(String(out || '0').trim()) > 0;
}

/** Force programs closed (with their child processes). */
async function killPids(pids, platform = process.platform) {
  if (platform !== 'win32') {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    return true;
  }
  await Promise.all(pids.map((pid) => execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20000 })));
  return true;
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
 *   'title'     (text)        the game window's title, once it has stayed the same for two checks (Windows)
 *   'exit'      ({ reason, error, durationMs, playedMs })  the game is closed
 *               reason: 'closed' | 'stopped' | 'failed' | 'declined' (No to the administrator prompt)
 *               playedMs: time the game was actually running (see the top of this file)
 * and has .stop() to stop tracking manually, .close() to ask the game to close (like its X button),
 * and .kill() to force it closed.
 * With `luna` ({ cmd, argv, cwd }) the game is started through LunaTranslator: Luna itself keeps
 * running, so only the game's own programs count, and the game gets up to `startupMs` to appear.
 * With exePath null nothing is started: it only watches a game that's already running (from installDir).
 */
function launch({ exePath, installDir, args = '', localeEmulatorPath = '', useLocaleEmulator = false, luna = null,
  platform = process.platform, pollMs = 1000, graceMs = 8000, closeGraceMs = Math.min(2500, graceMs), settleMs = 20000,
  startupMs = 60000, spawnImpl = spawn, elevateImpl = startElevated, closeImpl = closeWindows, killImpl = killPids }) {
  const ev = new EventEmitter();
  const cwd = exePath ? path.dirname(exePath) : installDir;
  const extra = args ? args.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, '')) : [];

  let cmd = exePath;
  let argv = extra;
  let workDir = cwd;
  if (!exePath) {
    // Watch-only.
  } else if (luna) {
    cmd = luna.cmd;
    argv = luna.argv;
    workDir = luna.cwd || path.dirname(luna.cmd);
  } else if (useLocaleEmulator && localeEmulatorPath) {
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
  const maxGap = Math.max(pollMs * 3, 8000); // longer than this between two checks = the PC slept; don't count it
  let firstSeen = null;
  let lastPids = [];
  let pendingTitle = null;
  let lastTitle = null;

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
    if (watcher && watcher.title) {
      if (watcher.title === pendingTitle && watcher.title !== lastTitle) { lastTitle = watcher.title; ev.emit('title', lastTitle); }
      pendingTitle = watcher.title;
    }
    if (alive) {
      if (lastAliveCheck !== null && now - lastAliveCheck <= maxGap) playedMs += now - lastAliveCheck;
      lastAliveCheck = now;
      lastSeen = now;
      if (pids && pids.length) {
        if (firstSeen === null) firstSeen = now;
        lastPids = pids;
        ev.emit('running', pids);
      }
    } else {
      // Gone since the last check: count up to halfway, the best guess of when it closed.
      if (lastAliveCheck !== null && now - lastAliveCheck <= maxGap) playedMs += (now - lastAliveCheck) / 2;
      lastAliveCheck = null;
    }
    if (luna && firstSeen === null) {
      // Through Luna: nothing of the game yet. Give it time to appear.
      if (now - startedAt >= startupMs) return finish('failed', 'The game didn\'t start from LunaTranslator.');
    } else {
      // Settled games close quickly; just after starting, allow for a launcher handing over.
      const grace = firstSeen !== null && now - firstSeen >= settleMs ? closeGraceMs : graceMs;
      if (!done && now - lastSeen >= grace && now - startedAt >= grace) return finish('closed');
    }
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
    const r = await elevateImpl(cmd, argv, workDir);
    if (done) return;
    if (r.declined) return finish('declined', 'The game needs administrator rights, and permission wasn\'t given.');
    if (!r.pid) return finish('failed', r.error || 'couldn\'t start with administrator rights');
    lastSeen = Date.now();
    lastAliveCheck = lastSeen;
    startWatching([r.pid]);
  };

  // The game's programs as last seen, else the one we started (while it's still running).
  const targets = () => (lastPids.length ? lastPids : child && childAlive && child.pid && !luna ? [child.pid] : []);
  ev.close = () => (targets().length ? closeImpl(targets(), platform) : Promise.resolve(false));
  ev.kill = () => (targets().length ? killImpl(targets(), platform) : Promise.resolve(false));

  if (!exePath) {
    childAlive = false;
    setImmediate(() => ev.emit('started'));
    startWatching([]);
    ev.stop = () => finish('stopped');
    return ev;
  }

  try {
    child = spawnImpl(cmd, argv, { cwd: workDir, detached: true, stdio: 'ignore', windowsHide: false });
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
  child.on('exit', (code) => {
    childAlive = false;
    if (luna && code && firstSeen === null) finish('failed', `LunaTranslator closed before the game started (code ${code}).`);
  });
  child.unref();
  setImmediate(() => ev.emit('started'));
  if (luna) {
    // Luna stays open after the game closes: only the game's own programs count.
    childAlive = false;
    startWatching([]);
  } else startWatching(child.pid ? [child.pid] : []);

  ev.stop = () => finish('stopped');
  return ev;
}

module.exports = { launch, linuxProcessesUnder, windowsWatcher, startElevated, isRunningFrom, closeWindows, killPids };
