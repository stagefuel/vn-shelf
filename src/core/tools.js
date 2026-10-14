'use strict';
// Companion tools: programs started alongside a game (a text hooker such as LunaHook/Textractor,
// meikipop, Magpie for upscaling…) and, if wanted, closed again when the game closes.

const { spawn, execFile } = require('child_process');
const path = require('path');

/** Split an argument string the way a shell would for quoted arguments. */
function splitArgs(s) {
  return (String(s || '').match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
}

/** Fill {gameExe}, {gameDir} and {title} in a tool's arguments. */
function expandArgs(args, ctx) {
  return splitArgs(args).map((a) => a
    .replace(/\{gameExe\}/g, ctx.gameExe || '')
    .replace(/\{gameDir\}/g, ctx.gameDir || '')
    .replace(/\{title\}/g, ctx.title || ''));
}

function commandFor(tool, platform) {
  const argv = tool._argv || [];
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(tool.path)) return { cmd: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/c', tool.path, ...argv] };
  if (platform !== 'win32' && /\.exe$/i.test(tool.path)) return { cmd: 'wine', argv: [tool.path, ...argv] };
  return { cmd: tool.path, argv };
}

/**
 * Start tools for a game. Returns handles to pass to stopTools().
 * @param {Array<{id,name,path,args,delaySec,closeWithGame}>} tools
 * @param {{gameExe,gameDir,title}} ctx
 */
function startTools(tools, ctx, { platform = process.platform, onError = () => {} } = {}) {
  const handles = [];
  for (const t of tools) {
    const h = { tool: t, child: null, timer: null, stopped: false };
    const run = () => {
      if (h.stopped) return;
      try {
        const { cmd, argv } = commandFor({ ...t, _argv: expandArgs(t.args, ctx) }, platform);
        h.child = spawn(cmd, argv, { cwd: path.dirname(t.path), detached: true, stdio: 'ignore', windowsHide: false });
        h.child.on('error', (e) => onError(t, e));
        h.child.unref();
      } catch (e) { onError(t, e); }
    };
    const delay = Math.max(0, Number(t.delaySec) || 0) * 1000;
    if (delay) h.timer = setTimeout(run, delay); else run();
    handles.push(h);
  }
  return handles;
}

/** Close the tools that should close with the game (the whole process tree on Windows). */
async function stopTools(handles, { platform = process.platform } = {}) {
  await Promise.all(handles.map((h) => new Promise((resolve) => {
    h.stopped = true;
    clearTimeout(h.timer);
    if (!h.tool.closeWithGame || !h.child || !h.child.pid || h.child.exitCode !== null) return resolve();
    if (platform === 'win32') {
      execFile('taskkill', ['/PID', String(h.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try { process.kill(-h.child.pid, 'SIGTERM'); } catch { try { h.child.kill('SIGTERM'); } catch { /* gone */ } }
      resolve();
    }
  })));
}

module.exports = { startTools, stopTools, expandArgs, splitArgs };
