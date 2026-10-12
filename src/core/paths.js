'use strict';
// Portable save paths. A save location is stored as "<token>/rest/of/path" so the
// same rule works on every PC regardless of username, drive letter or install dir.

const path = require('path');
const os = require('os');

// Tokens, most specific first. <game> is resolved per game, the rest per machine.
const TOKENS = ['<game>', '<locallow>', '<localappdata>', '<appdata>', '<savedgames>', '<documents>', '<home>'];

/**
 * Work out this machine's roots. In the app, `documents` comes from Electron's
 * app.getPath('documents') because Windows often redirects it into OneDrive.
 */
function defaultRoots({ env = process.env, platform = process.platform, home = os.homedir(), documents } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return {
      '<locallow>': path.win32.join(path.win32.dirname(local), 'LocalLow'),
      '<localappdata>': local,
      '<appdata>': env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'),
      '<savedgames>': path.win32.join(home, 'Saved Games'),
      '<documents>': documents || path.win32.join(home, 'Documents'),
      '<home>': home,
    };
  }
  return {
    '<localappdata>': env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'),
    '<appdata>': env.XDG_CONFIG_HOME || path.posix.join(home, '.config'),
    '<documents>': documents || path.posix.join(home, 'Documents'),
    '<home>': home,
  };
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function norm(p, platform) {
  const api = pathApi(platform);
  let n = api.normalize(p).replace(/[\\/]+$/, '');
  if (platform === 'win32') n = n.toLowerCase();
  return n;
}

/** Is `child` the same as, or inside, `parent`? Returns the relative part or null. */
function relativeInside(parent, child, platform = process.platform) {
  const api = pathApi(platform);
  const p = norm(parent, platform);
  const c = norm(child, platform);
  if (c === p) return '';
  const sep = api.sep;
  if (c.startsWith(p + sep)) {
    // Slice the original (case-preserved) child path.
    const original = api.normalize(child).replace(/[\\/]+$/, '');
    return original.slice(p.length + 1).split(/[\\/]+/).join('/');
  }
  return null;
}

/**
 * Turn an absolute path into a portable token path.
 * Returns { path, portable } — portable is false when no root matched.
 */
function tokenize(absPath, { roots, gameDir, platform = process.platform }) {
  const candidates = [];
  if (gameDir) candidates.push(['<game>', gameDir]);
  for (const t of TOKENS) if (t !== '<game>' && roots[t]) candidates.push([t, roots[t]]);
  // Longest matching root wins, so <game> inside Documents still becomes <game>.
  let best = null;
  for (const [token, root] of candidates) {
    const rel = relativeInside(root, absPath, platform);
    if (rel === null) continue;
    const len = norm(root, platform).length;
    if (!best || len > best.len || (len === best.len && token === '<game>')) best = { token, rel, len };
  }
  if (!best) return { path: absPath.split(/[\\/]+/).join('/'), portable: false };
  return { path: best.rel ? `${best.token}/${best.rel}` : best.token, portable: true };
}

/** Turn a token path back into an absolute path for this machine. */
function expand(tokenPath, { roots, gameDir, platform = process.platform }) {
  const api = pathApi(platform);
  const m = /^(<[a-z]+>)(?:\/(.*))?$/.exec(tokenPath);
  if (!m) return api.normalize(tokenPath);
  const [, token, rest] = m;
  let root;
  if (token === '<game>') root = gameDir;
  else root = roots[token];
  if (!root) throw new Error(`Unknown or unavailable location ${token} on this PC`);
  const parts = rest ? rest.split('/').filter(Boolean) : [];
  for (const part of parts) if (part === '..') throw new Error(`Path may not contain "..": ${tokenPath}`);
  return api.join(root, ...parts);
}

module.exports = { TOKENS, defaultRoots, tokenize, expand, relativeInside };
