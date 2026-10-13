'use strict';
// Guard rails so a mis-picked folder can't turn into gigabytes of uploads:
//   1. some locations are never allowed as a save folder (all of AppData, the whole game folder, …)
//   2. files that are never saves are always skipped (programs, video, game archives, caches, logs)
//   3. each save folder has size/file-count limits: above the soft limit the user must confirm,
//      above the hard limit it is refused, both when adding it and on every sync.

const path = require('path');
const { relativeInside } = require('./paths');

const LIMITS = {
  softBytes: 50 * 1024 * 1024,
  softFiles: 1000,
  hardBytes: 500 * 1024 * 1024,
  hardFiles: 5000,
  maxFileBytes: 64 * 1024 * 1024,
};

// File types that are never save data.
const NEVER_EXT = new Set([
  // programs and libraries
  '.exe', '.dll', '.so', '.dylib', '.msi', '.bat', '.cmd', '.ps1', '.com', '.scr', '.app',
  // video and big media
  '.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.mpg', '.mpeg', '.ogv', '.m2ts', '.flv',
  // game data archives and disc images
  '.xp3', '.rpa', '.rpyc', '.pck', '.arc', '.pak', '.pfs', '.ypf', '.ain', '.ald', '.npa', '.rgss3a', '.rgss2a', '.rgssad',
  '.iso', '.mdf', '.mds', '.cue', '.cdi', '.nrg', '.zip', '.7z', '.rar', '.lzh', '.cab', '.tar', '.gz',
  // junk
  '.log', '.tmp', '.dmp', '.crdownload', '.part',
]);

// Folders (anywhere inside a save folder) that hold caches, never saves.
const NEVER_DIRS = new Set([
  'cache', 'caches', 'code cache', 'gpucache', 'dawncache', 'grshadercache', 'shadercache', 'shader_cache',
  'crashpad', 'crashdumps', 'crash reports', 'logs', 'log', 'temp', 'tmp', 'blob_storage', 'videodecodestats',
  'service worker', 'webcache', 'inetcache', 'd3dscache', 'nvidia', 'node_modules', '__pycache__', '.git',
]);

function skipDir(name) { return NEVER_DIRS.has(name.toLowerCase()); }

function skipFile(rel, size) {
  const ext = path.extname(rel).toLowerCase();
  if (NEVER_EXT.has(ext)) return 'type';
  if (size > LIMITS.maxFileBytes) return 'size';
  return null;
}

/**
 * Reject save locations that are far too broad.
 * @param {string} tokenPath  e.g. "<appdata>/Nitroplus/Muramasa"
 * @param {string[]} include   file patterns, if any
 * @param {object} [o]  { cloudDir, abs, platform } – abs is the resolved path on this PC
 * @returns {string|null} why it's not allowed, or null if fine
 */
function rejectPath(tokenPath, include = [], { cloudDir, abs, platform = process.platform } = {}) {
  const p = String(tokenPath).replace(/\/+$/, '');
  const roots = ['<appdata>', '<localappdata>', '<locallow>', '<documents>', '<savedgames>', '<home>'];
  if (roots.includes(p)) {
    return 'That is a whole system folder, not one game\'s save folder. Pick the game\'s own folder inside it.';
  }
  if (p === '<documents>/My Games') return 'Pick the game\'s own folder inside "My Games".';
  if (p === '<game>' && !(include && include.filter(Boolean).length)) {
    return 'That is the whole game folder. Pick its save subfolder, or limit it to the save files (for example Save*.dat).';
  }
  if (!p.startsWith('<')) {
    const parts = p.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1 || (parts.length === 2 && /^[A-Za-z]:$/.test(parts[0]))) {
      return 'That is a whole drive or top-level folder. Pick the game\'s save folder.';
    }
    if (/^([A-Za-z]:)?[\\/]*(windows|program files( \(x86\))?|users|programdata)$/i.test(p) || /^\/(etc|usr|var|home)\/?$/.test(p)) {
      return 'That is a system folder. Pick the game\'s save folder.';
    }
  }
  if (cloudDir && abs) {
    if (relativeInside(cloudDir, abs, platform) !== null || relativeInside(abs, cloudDir, platform) !== null) {
      return 'That folder overlaps the folder VN Shelf syncs through. Pick the game\'s own save folder.';
    }
  }
  return null;
}

/** Classify a measured folder: 'ok', 'confirm' (above soft limit) or 'refuse' (above hard limit). */
function judge({ files, bytes }, { confirmed = false } = {}) {
  if (files > LIMITS.hardFiles || bytes > LIMITS.hardBytes) return 'refuse';
  if (!confirmed && (files > LIMITS.softFiles || bytes > LIMITS.softBytes)) return 'confirm';
  return 'ok';
}

function describeSize({ files, bytes }) {
  const mb = bytes / (1024 * 1024);
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${mb.toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'}, ${size}`;
}

module.exports = { LIMITS, NEVER_EXT, NEVER_DIRS, skipDir, skipFile, rejectPath, judge, describeSize };
