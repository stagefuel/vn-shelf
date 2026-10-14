'use strict';
// UI translation. Strings are written in English in the code and looked up here by that text,
// so a missing translation simply shows the English. Placeholders look like {name}.
/* exported t, setLanguage, currentLanguage, translateMessage */

let LANG = 'en';

function setLanguage(pref) {
  const nav = (navigator.language || 'en').toLowerCase();
  LANG = pref === 'ja' || (pref !== 'en' && nav.startsWith('ja')) ? 'ja' : 'en';
  document.documentElement.lang = LANG;
  return LANG;
}

function currentLanguage() { return LANG; }

function fill(s, params) {
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m)) : s;
}

function t(en, params) {
  const s = LANG === 'ja' && JA[en] !== undefined ? JA[en] : en;
  return fill(s, params);
}

/** Translate a message that came from the main process (errors, status lines). */
function translateMessage(msg) {
  if (LANG !== 'ja' || !msg) return msg;
  if (JA[msg] !== undefined) return JA[msg];
  for (const [re, ja] of JA_PATTERNS) {
    const m = re.exec(msg);
    if (m) return ja.replace(/\$(\d)/g, (x, i) => translateMessage(m[Number(i)]));
  }
  // Lists like detection reasons: "inside the game folder, named after the game".
  if (msg.includes(', ')) {
    const parts = msg.split(', ').map((p) => translateMessage(p));
    if (parts.some((p, i) => p !== msg.split(', ')[i])) return parts.join('、');
  }
  return msg;
}

// Filled in below (generated from the strings used in app.js, then translated by hand).
const JA = {};
const JA_PATTERNS = [];
