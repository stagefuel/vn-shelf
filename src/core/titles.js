'use strict';
// Turn what a game's window calls itself into a clean library title. Used only for games that
// aren't linked to VNDB and still carry the title guessed from their folder name: the window title
// is usually the game's real name, but often with a version number or the engine's name attached.

const GENERIC = new Set(['default ime', 'msctfime ui', 'loading', 'now loading', 'loading...', 'kirikiri', 'kirikiri z',
  'krkr', 'krkrz', "ren'py", 'renpy', 'unity', 'game', 'main', 'window', 'title', 'nscripter', 'onscripter', 'siglus',
  'siglusengine', 'catsystem2', 'bgi', 'artemis', 'rpg maker', 'rpgmv', 'nw.js', 'error', 'warning', 'config', 'setup']);

const ENGINE_TAIL = /\s*[-–—|:]\s*(kirikiri\s*z?|吉里吉里\s*z?|krkrz?|ren'?py.*|unity.*|siglus\s*engine|siglusengine|catsystem2?|bgi|artemis(\s*engine)?|n?onscripter.*|nscripter|rpg\s*maker.*|nw\.js)\s*$/i;
const VERSION_TAIL = /\s*[-–—|:]?\s*(ver(sion)?\.?\s*\d[\w.]*|v\d+(\.\d+)+[a-z]?|\d+\.\d+(\.\d+)+)\s*$/i;
const BRACKET_TAIL = /\s*[([【（「](体験版|trial|demo|試用版|ver[^)\]】）」]*|v\d[^)\]】）」]*|\d+\.\d+[^)\]】）」]*)[)\]】）」]\s*$/i;

/** A clean title, or null when the window title isn't a usable name. */
function cleanTitle(raw, { exe = '' } = {}) {
  let t = String(raw || '').replace(/[\s\u3000]+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(ENGINE_TAIL, '').replace(BRACKET_TAIL, '').replace(VERSION_TAIL, '').trim();
    if (t === before) break;
  }
  t = t.replace(/^[-–—|:・\s]+|[-–—|:・\s]+$/g, '');
  if (t.length < 2 || t.length > 120) return null;
  const lower = t.toLowerCase();
  if (GENERIC.has(lower)) return null;
  const exeBase = String(exe).toLowerCase().replace(/\.[^.]+$/, '');
  if (exeBase && (lower === exeBase || lower === String(exe).toLowerCase())) return null;
  return t;
}

module.exports = { cleanTitle };
