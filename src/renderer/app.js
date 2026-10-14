'use strict';
/* global vns, t, setLanguage, currentLanguage, translateMessage */

// ------------------------------------------------------------------ helpers

const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function cleanError(e) {
  return translateMessage(String((e && e.message) || e).replace(/^Error invoking remote method 'api': (Error: )?/, ''));
}

async function call(method, ...args) {
  try {
    return await vns.call(method, ...args);
  } catch (e) {
    toast(cleanError(e), 'bad');
    throw e;
  }
}

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 4000);
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  if (s < 86400 * 14) return t('{n} days ago', { n: Math.round(s / 86400) });
  return new Date(iso).toLocaleDateString(currentLanguage());
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString(currentLanguage())} ${d.toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit' })}`;
}

function hours(minutes) {
  const hrs = Math.round((minutes || 0) / 6) / 10;
  return t('{n} h', { n: hrs });
}

function joinPath(a, b) {
  const sep = setup && setup.platform === 'win32' ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b;
}

/** replaceChildren that skips null/false entries instead of printing "null". */
function replaceKids(el, ...kids) { el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)); }

function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; }

function plural(n, one, many) { return t(n === 1 ? one : many, { n }); }

// ------------------------------------------------------------------ dialog

/**
 * Show the shared dialog. `buttons`: [{ label, value, cls, validate }]. Resolves with the clicked
 * value, or null on Escape.
 */
function dialog({ title, text, body, buttons = [{ label: t('OK'), value: true, cls: 'primary' }], wide }) {
  const dlg = $('#dlg');
  const form = $('#dlgBody');
  form.replaceChildren();
  dlg.style.width = wide ? 'min(860px, calc(100vw - 32px))' : '';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(v);
    };
    form.append(h('div', { class: 'dhead' }, h('h3', {}, title), text ? h('p', {}, text) : null));
    if (body) form.append(h('div', { class: 'dbody' }, body));
    const foot = h('div', { class: 'dfoot' });
    for (const b of buttons) {
      foot.append(h('button', { type: 'button', class: b.cls || '', onclick: async () => {
        if (b.validate && !(await b.validate())) return;
        finish(typeof b.value === 'function' ? b.value() : b.value);
      } }, b.label));
    }
    form.append(foot);
    dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
    dlg.showModal();
    form.dlgFinish = finish;
  });
}

function closeDialog(v = null) {
  const f = $('#dlgBody');
  if (f.dlgFinish && $('#dlg').open) f.dlgFinish(v);
}

// ------------------------------------------------------------------ state

let setup = null;
let games = [];
let view = 'home'; // home | library | detail
let prevView = 'home';
let currentId = null;
const filter = { category: null, tag: null };
const live = {};      // id -> { state, message }
const badges = {};    // id -> gameStatus result
let showSpoilers = false;

const BADGE_TEXT = () => ({
  synced: t('Synced'), upload: t('To upload'), download: t('Newer saves'), conflict: t('Conflict'), offline: t('Offline'),
  'no-saves': t('No save folder'), 'not-installed': t('Not on this PC'), running: t('Playing'), syncing: t('Syncing'), error: t('Error'),
});

const SORTS = () => [
  ['title', t('Title')], ['played', t('Last played')], ['added', t('Recently added')], ['released', t('Release date')],
  ['rating', t('VNDB rating')], ['length', t('Length')], ['playtime', t('Time played')],
];

const LENGTH_TEXT = () => ({
  'very-short': t('Very short (< 2 h)'), short: t('Short (2–10 h)'), medium: t('Medium (10–30 h)'),
  long: t('Long (30–50 h)'), 'very-long': t('Very long (> 50 h)'),
});

function badgeFor(g) {
  const l = live[g.id];
  if (l && ['running', 'syncing', 'scanning'].includes(l.state)) return l.state === 'running' ? 'running' : 'syncing';
  if (!g.installed) return 'not-installed';
  const b = badges[g.id];
  return b ? b.badge : null;
}

const statusWaiting = [];
let statusRunning = 0;
/** Refresh a game's sync badge. Several run at once (each may talk to Google Drive), the rest wait. */
function refreshStatus(id) {
  return new Promise((resolve) => { statusWaiting.push({ id, resolve }); pumpStatus(); });
}

function pumpStatus() {
  while (statusRunning < 6 && statusWaiting.length) {
    const { id, resolve } = statusWaiting.shift();
    statusRunning++;
    (async () => {
      try {
        badges[id] = await vns.call('gameStatus', id);
      } catch { badges[id] = { badge: 'error' }; }
      updateCards(id);
      if (view === 'detail' && currentId === id) updateStatusLine();
    })().finally(() => { statusRunning--; resolve(); pumpStatus(); });
  }
}

function categoriesAll() {
  const set = new Set(setup.settings.categories || []);
  for (const g of games) for (const c of g.categories || []) set.add(c);
  return [...set].sort((a, b) => a.localeCompare(b, currentLanguage()));
}

// ------------------------------------------------------------------ shell: sidebar, views

function applyStaticText() {
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of document.querySelectorAll('[data-t-title]')) el.title = t(el.dataset.tTitle);
}

function renderSidebar() {
  const cats = categoriesAll();
  const count = (c) => games.filter((g) => (g.categories || []).includes(c)).length;
  const item = (label, active, onclick, extra) => h('div', { class: `navitem${active ? ' active' : ''}`, onclick }, label, extra || null);
  const nav = $('#sidebar');
  replaceKids(nav,
    item(t('Home'), view === 'home', () => showHome()),
    item(t('All games'), view === 'library' && !filter.category && !filter.tag, () => showLibrary({ category: null, tag: null }), h('span', { class: 'count' }, games.length)),
    h('div', { class: 'navhead' }, t('Categories'),
      h('button', { class: 'ghost tiny', title: t('New category'), onclick: newCategory }, '+')),
    ...cats.map((c) => item(h('span', { class: 'catname' }, c), view === 'library' && filter.category === c,
      () => showLibrary({ category: c, tag: null }),
      h('span', { class: 'count' }, count(c)))),
  );
}

function setView(v) {
  if (v !== 'detail') prevView = v;
  view = v;
  $('#homeView').classList.toggle('hidden', v !== 'home');
  $('#libraryView').classList.toggle('hidden', v !== 'library');
  $('#detailView').classList.toggle('hidden', v !== 'detail');
  $('main').scrollTop = 0;
  renderSidebar();
}

// ---- navigation history (Back/Forward buttons, mouse side buttons, Alt+←/→)

const nav = { stack: [], index: -1, lastMove: 0 };

function navState() {
  if (view === 'detail') return { view, id: currentId };
  if (view === 'library') return { view, filter: { ...filter } };
  return { view: 'home' };
}

function samePlace(a, b) { return !!a && !!b && JSON.stringify(a) === JSON.stringify(b); }

/** Record where we are now (call after showing a view). */
function pushNav() {
  const st = navState();
  if (samePlace(nav.stack[nav.index], st)) return updateBackBtn();
  nav.stack = nav.stack.slice(0, nav.index + 1);
  nav.stack.push(st);
  if (nav.stack.length > 100) nav.stack.shift();
  nav.index = nav.stack.length - 1;
  updateBackBtn();
}

// The Back button shows on game pages and tag lists only; Home and the sidebar's tabs (All games,
// categories) are reached from the sidebar. The mouse's back button and Alt+← still work everywhere.
function updateBackBtn() {
  const offTab = view === 'detail' || (view === 'library' && !!filter.tag);
  $('#backBtn').classList.toggle('hidden', nav.index <= 0 || !offTab);
}

async function restoreNav(st) {
  if (st.view === 'detail' && games.some((g) => g.id === st.id)) { currentId = st.id; setView('detail'); await renderDetail(st.id, { noAuto: true }); }
  else if (st.view === 'library') { Object.assign(filter, st.filter || {}); setView('library'); renderGrid(); }
  else { setView(games.length ? 'home' : 'library'); if (view === 'home') renderHome(); else renderGrid(); }
  updateBackBtn();
}

function navMove(step) {
  // The mouse's side buttons can arrive twice on Windows (mouse event + app command): ignore repeats.
  if (Date.now() - nav.lastMove < 250 || $('#dlg').open) return;
  const i = nav.index + step;
  if (i < 0 || i >= nav.stack.length) return;
  nav.lastMove = Date.now();
  nav.index = i;
  restoreNav(nav.stack[i]);
}

async function loadGames() {
  games = await call('listGames');
  if (view === 'home') renderHome();
  else if (view === 'library') renderGrid();
  renderSidebar();
  for (const g of games) refreshStatus(g.id);
}

function cardFor(g) {
  const art = h('div', { class: 'art' },
    g.coverUrl ? h('img', { src: g.coverUrl, alt: '', loading: 'lazy', draggable: 'false' }) : h('div', { class: 'placeholder' }, g.title));
  const b = badgeFor(g);
  if (b) art.append(h('span', { class: `badge ${b}` }, BADGE_TEXT()[b] || b));
  if (g.installed && !(live[g.id] && ['running', 'syncing'].includes(live[g.id].state))) {
    art.append(h('button', { class: 'quickplay', onclick: (e) => { e.stopPropagation(); play(g.id); } }, t('▶ Play')));
  }
  const sub = g.lastPlayed ? t('Played {when}', { when: ago(g.lastPlayed) }) : (g.titleAlt || g.developer || '');
  return h('div', { class: `card${g.installed ? '' : ' uninstalled'}`, tabindex: '0', 'data-id': g.id,
    onclick: () => openDetail(g.id), onkeydown: (e) => { if (e.key === 'Enter') openDetail(g.id); } },
  art,
  h('div', { class: 'title' }, g.title),
  h('div', { class: 'sub' }, sub));
}

function updateCards(id) {
  const g = games.find((x) => x.id === id);
  if (!g) return;
  for (const old of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`)) old.replaceWith(cardFor(g));
}

// ------------------------------------------------------------------ home

function showHome() {
  setView(games.length ? 'home' : 'library');
  if (view === 'home') renderHome(); else renderGrid();
  pushNav();
}

/** Home: one row of the most recently played games (or the newest, before anything is played). */
function renderHome() {
  const played = games.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed));
  const list = played.length ? played : [...games].sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  replaceKids($('#homeView'),
    h('h2', { class: 'hometitle' }, played.length ? t('Recently played') : t('Recently added')),
    h('div', { class: 'recentrow' }, list.slice(0, 24).map(cardFor)));
}

// ------------------------------------------------------------------ library grid

function showLibrary(f) {
  if (f) Object.assign(filter, f);
  setView('library');
  renderGrid();
  pushNav();
}

function matchesSearch(g, q) {
  if (!q) return true;
  const tags = g.vndb && g.vndb.tags ? g.vndb.tags.filter((x) => showSpoilers || !x.spoiler).map((x) => x.name) : [];
  const hay = [g.title, g.titleAlt, g.developer, ...(g.vndb ? g.vndb.aliases || [] : []), ...tags, ...(g.categories || [])].join(' \n ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function sortGames(list, key) {
  const by = {
    title: (a, b) => a.title.localeCompare(b.title, 'ja'),
    played: (a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || '')),
    added: (a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')),
    released: (a, b) => String((b.vndb || {}).released || '').localeCompare(String((a.vndb || {}).released || '')),
    rating: (a, b) => ((b.vndb || {}).rating || 0) - ((a.vndb || {}).rating || 0),
    length: (a, b) => ((b.vndb || {}).lengthMinutes || 0) - ((a.vndb || {}).lengthMinutes || 0),
    playtime: (a, b) => (b.playMinutes || 0) - (a.playMinutes || 0),
  }[key] || ((a, b) => a.title.localeCompare(b.title, 'ja'));
  return [...list].sort((a, b) => by(a, b) || a.title.localeCompare(b.title, 'ja'));
}

function renderGrid() {
  const q = $('#search').value.trim().toLowerCase();
  let list = games.filter((g) => matchesSearch(g, q));
  if (filter.category) list = list.filter((g) => (g.categories || []).includes(filter.category));
  if (filter.tag) list = list.filter((g) => g.vndb && (g.vndb.tags || []).some((x) => x.id === filter.tag.id));
  list = sortGames(list, setup.settings.sort);

  const sortSel = h('select', { class: 'sortsel', title: t('Sort by') },
    SORTS().map(([k, label]) => h('option', { value: k, selected: setup.settings.sort === k }, label)));
  sortSel.addEventListener('change', async () => {
    setup = await call('saveSettings', { sort: sortSel.value });
    renderGrid();
  });
  const chips = [];
  if (filter.category) chips.push(h('span', { class: 'chip on' }, `${t('Category')}: ${filter.category}`, h('button', { class: 'x', title: t('Clear'), onclick: () => showLibrary({ category: null }) }, '×')));
  if (filter.tag) chips.push(h('span', { class: 'chip on' }, `${t('Tag')}: ${filter.tag.name}`, h('button', { class: 'x', title: t('Clear'), onclick: () => showLibrary({ tag: null }) }, '×')));
  const heading = filter.category || (filter.tag ? filter.tag.name : t('All games'));
  const extra = filter.category ? h('button', { class: 'ghost small', onclick: () => manageCategory(filter.category) }, t('Rename or delete…')) : null;
  replaceKids($('#libToolbar'),
    h('h1', {}, heading), h('span', { class: 'dim' }, plural(list.length, '{n} game', '{n} games')), extra, ...chips,
    h('div', { class: 'spacer' }), h('span', { class: 'dim small' }, t('Sort by')), sortSel);
  $('#grid').replaceChildren(...list.map(cardFor));
  $('#empty').classList.toggle('hidden', games.length > 0);
  $('#noMatch').classList.toggle('hidden', !(games.length > 0 && list.length === 0));
}

// ------------------------------------------------------------------ categories

async function newCategory() {
  const input = h('input', { type: 'text', placeholder: t('e.g. Reading, Finished, Nukige, Favourites') });
  const name = await dialog({
    title: t('New category'),
    body: input,
    buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Create'), value: () => input.value.trim(), cls: 'primary', validate: () => !!input.value.trim() }],
  });
  if (!name) return;
  setup = await call('saveSettings', { categories: [...(setup.settings.categories || []), name] });
  renderSidebar();
}

async function manageCategory(cat) {
  const input = h('input', { type: 'text', value: cat });
  const v = await dialog({
    title: t('Category "{name}"', { name: cat }),
    text: t('Renaming changes it on every game in it. Deleting removes the category only; the games stay in your library.'),
    body: input,
    buttons: [
      { label: t('Delete category'), value: 'delete', cls: 'ghost danger' },
      { label: t('Cancel'), value: null, cls: 'ghost' },
      { label: t('Rename'), value: 'rename', cls: 'primary', validate: () => !!input.value.trim() },
    ],
  });
  if (!v) return;
  const to = input.value.trim();
  for (const g of games.filter((x) => (x.categories || []).includes(cat))) {
    const next = (g.categories || []).filter((c) => c !== cat);
    if (v === 'rename') next.push(to);
    await call('updateGame', g.id, { categories: next });
  }
  const list = (setup.settings.categories || []).filter((c) => c !== cat);
  if (v === 'rename') list.push(to);
  setup = await call('saveSettings', { categories: list });
  await loadGames();
  if (v === 'rename') showLibrary({ category: to }); else showLibrary({ category: null });
}

// ------------------------------------------------------------------ play & sync flows

async function conflictDialog(info) {
  const c = info.cloud || {};
  const l = info.local || {};
  return dialog({
    title: t('Saves changed on both PCs'),
    text: t('This PC and another PC both have new saves since they last synced. Pick which to keep. The other copy is kept in History, so nothing is lost.'),
    body: h('div', { class: 'sides' },
      h('div', { class: 'side' }, h('h4', {}, t('This PC ({name})', { name: l.deviceName || '' })), h('div', { class: 's' }, plural(l.files, '{n} file', '{n} files'))),
      h('div', { class: 'side' }, h('h4', {}, `${c.deviceName || t('Other PC')}`),
        h('div', { class: 's' }, t('{files}, uploaded {when}', { files: plural(c.files, '{n} file', '{n} files'), when: when(c.pushedAt) })))),
    buttons: [
      { label: t('Cancel'), value: null, cls: 'ghost' },
      { label: t('Use {name}\'s', { name: c.deviceName || t('Other PC') }), value: 'cloud' },
      { label: t('Keep this PC\'s'), value: 'local', cls: 'primary' },
    ],
  });
}

async function play(id, opts = {}) {
  let r;
  try { r = await call('play', id, opts); } catch { return; }
  if (r.started || r.busy) return;
  const g = games.find((x) => x.id === id) || {};
  const msg = translateMessage(r.message || '');
  switch (r.needs) {
    case 'locate': {
      const ok = await dialog({
        title: t('Not set up on this PC yet'),
        text: t('Show VN Shelf where {exe} is on this PC. Saves will come down from the shared folder before it starts.', { exe: g.exe || t('the game\'s .exe') }),
        buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Find the .exe…'), value: true, cls: 'primary' }],
      });
      if (ok && (await call('locateGame', id))) { await loadGamesKeepView(); return play(id, opts); }
      return;
    }
    case 'no-saves': {
      const v = await dialog({
        title: t('No save folder set'),
        text: t('VN Shelf doesn\'t know where this game saves yet, so nothing will sync. Set it up on the game page (Auto-detect, Save once, or pick the folder).'),
        buttons: [{ label: t('Play without syncing'), value: 'play', cls: 'ghost' }, { label: t('Set up saves'), value: 'setup', cls: 'primary' }],
      });
      if (v === 'play') return play(id, { ...opts, noSaves: true });
      if (v === 'setup') return openDetail(id);
      return;
    }
    case 'offline': {
      const v = await dialog({
        title: t('Shared folder not reachable'),
        text: `${msg} ${t('Is your cloud app (Google Drive, OneDrive…) running? You can play anyway; saves upload once the folder is back.')}`,
        buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Retry'), value: 'retry' }, { label: t('Play anyway'), value: 'go', cls: 'primary' }],
      });
      if (v === 'retry') return play(id, opts);
      if (v === 'go') return play(id, { ...opts, offline: true });
      return;
    }
    case 'locked': {
      const v = await dialog({
        title: t('Open on {name}?', { name: r.lock.deviceName }),
        text: t('This game was started on {name} at {when} and hasn\'t finished syncing from there. If you\'ve closed it there, give the cloud app a moment, then retry.', { name: r.lock.deviceName, when: when(r.lock.since) }),
        buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Retry'), value: 'retry' }, { label: t('Play anyway'), value: 'go', cls: 'primary' }],
      });
      if (v === 'retry') return play(id, opts);
      if (v === 'go') return play(id, { ...opts, ignoreLock: true });
      return;
    }
    case 'conflict': {
      const v = await conflictDialog(r.info);
      if (v) return play(id, { ...opts, resolution: v });
      return;
    }
    case 'too-big': {
      const v = await dialog({
        title: t('A save location needs fixing'),
        text: msg,
        buttons: [{ label: t('Play without syncing'), value: 'play', cls: 'ghost' }, { label: t('Open the game page'), value: 'fix', cls: 'primary' }],
      });
      if (v === 'play') return play(id, { ...opts, offline: true });
      if (v === 'fix') return openDetail(id, { noAuto: true });
      return;
    }
    case 'signed-out': {
      const v = await dialog({
        title: t('Signed out of Google Drive'),
        text: `${msg} ${t('You can also play now; saves upload after you sign in.')}`,
        buttons: [{ label: t('Play anyway'), value: 'play', cls: 'ghost' }, { label: t('Open Settings'), value: 'settings', cls: 'primary' }],
      });
      if (v === 'play') return play(id, { ...opts, offline: true });
      if (v === 'settings') return settingsDialog(false);
      return;
    }
    case 'incomplete': {
      const v = await dialog({
        title: t('Still downloading'),
        text: msg,
        buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Retry'), value: 'retry', cls: 'primary' }],
      });
      if (v === 'retry') return play(id, opts);
      return;
    }
    default:
  }
}

async function syncNow(id, opts = {}) {
  let r;
  try { r = await call('syncNow', id, opts); } catch { return; }
  if (r.needs === 'conflict') {
    const v = await conflictDialog(r.info);
    if (v) return syncNow(id, { resolution: v });
  } else if (r.needs) {
    toast(translateMessage(r.message) || t('Couldn\'t sync right now.'), 'bad');
  }
  refreshStatus(id);
  if (view === 'detail' && currentId === id) renderDetail(id);
}

async function loadGamesKeepView() {
  games = await call('listGames');
  if (view === 'library') renderGrid();
  else if (view === 'home') renderHome();
  else if (currentId) renderDetail(currentId);
  renderSidebar();
}

// ------------------------------------------------------------------ add game

async function addGameFromExe(exe) {
  if (!setup.configured) { await settingsDialog(true); if (!setup.configured) return; }
  let g;
  try { g = await call('addGame', exe); } catch { return; }
  await vndbDialog(g, true);
  await openDetail(g.id, { suggest: true });
}

async function addGameFlow() {
  const exe = await call('pickFile', t('Choose the game\'s .exe'), [{ name: t('Programs'), extensions: ['exe', 'bat', 'lnk', 'sh', 'AppImage'] }, { name: t('All files'), extensions: ['*'] }]);
  if (exe) await addGameFromExe(exe);
}

function vndbResult(v, onclick) {
  return h('div', { class: 'vnres', onclick },
    v.image ? h('img', { src: v.image, alt: '', class: v.imageSexual >= 1.5 ? 'nsfw' : null }) : h('div', { class: 'noimg' }),
    h('div', {}, h('div', { class: 't' }, v.title), h('div', { class: 's' }, [v.titleAlt, v.developer, (v.released || '').slice(0, 4)].filter(Boolean).join(' · '))));
}

async function vndbDialog(g, isNew) {
  const input = h('input', { type: 'text', value: g.titleAlt || g.title, placeholder: t('Title, or a VNDB id like v1234') });
  const results = h('div', {}, h('div', { class: 'faint' }, t('Searching…')));
  let chosen = null;
  const run = async () => {
    results.replaceChildren(h('div', { class: 'faint' }, t('Searching…')));
    let list = [];
    try { list = await vns.call('searchVndb', input.value); } catch (e) {
      results.replaceChildren(h('div', { class: 'faint' }, t('VNDB search failed: {error}. You can skip this and add a cover yourself.', { error: cleanError(e) })));
      return;
    }
    if (!list.length) { results.replaceChildren(h('div', { class: 'faint' }, t('No matches. Try the Japanese title or a shorter name.'))); return; }
    results.replaceChildren(...list.map((v) => vndbResult(v, () => { chosen = v; closeDialog('pick'); })));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  const p = dialog({
    title: isNew ? t('Which game is this?') : t('Find on VNDB'),
    text: t('Pick the match to get its cover, description and tags. Nothing else is sent anywhere.'),
    body: [h('div', { class: 'val', style: 'display:flex;gap:8px' }, input, h('button', { type: 'button', onclick: run }, t('Search'))), results],
    buttons: [{ label: isNew ? t('Skip') : t('Cancel'), value: null, cls: 'ghost' }],
    wide: true,
  });
  run();
  const v = await p;
  if (v === 'pick' && chosen) {
    try { await call('applyVndb', g.id, chosen); } catch { /* toasted */ }
  }
}

// ------------------------------------------------------------------ bulk import

async function importFolderFlow() {
  if (!setup.configured) { await settingsDialog(true); if (!setup.configured) return; }
  const dir = await call('pickFolder', t('Choose a folder with games in it (e.g. your VN folder)'));
  if (!dir) return;
  toast(t('Looking for games in {dir}…', { dir }));
  let found;
  try { found = await call('scanImport', dir); } catch { return; }
  const fresh = found.filter((f) => !f.already);
  if (!fresh.length) {
    await dialog({ title: t('No new games found'), text: found.length ? t('Every game in that folder is already in your library.') : t('No game programs were found in that folder or its subfolders.') });
    return;
  }
  const rows = fresh.map((f) => ({ ...f, on: true, match: undefined, query: f.title }));
  const list = h('div', { class: 'importlist' });
  const status = h('div', { class: 'faint' });
  let stopped = false;

  const renderRow = (r) => {
    const box = h('input', { type: 'checkbox', checked: r.on });
    box.addEventListener('change', () => { r.on = box.checked; updateCount(); });
    const exeSel = h('select', {}, r.exes.map((e) => h('option', { value: e, selected: baseName(r.exe) === e }, e)));
    exeSel.addEventListener('change', () => { r.exe = joinPath(r.dir, exeSel.value); });
    const q = h('input', { type: 'text', value: r.query, class: 'q' });
    const searchBtn = h('button', { type: 'button', class: 'small', onclick: async () => {
      r.query = q.value;
      r.match = undefined;
      redraw(r);
      try { r.match = await vns.call('vndbBestMatch', r.query); } catch (e) { r.match = null; toast(cleanError(e), 'bad'); }
      redraw(r);
    } }, t('Search'));
    let matchEl;
    if (r.match === undefined) matchEl = h('div', { class: 'faint small' }, t('Matching on VNDB…'));
    else if (!r.match) matchEl = h('div', { class: 'faint small' }, t('No VNDB match (it will use the folder name)'));
    else {
      matchEl = h('div', { class: 'match' }, vndbResult(r.match, null),
        h('button', { type: 'button', class: 'ghost tiny', title: t('Don\'t link to VNDB'), onclick: () => { r.match = null; redraw(r); } }, '×'));
    }
    return h('div', { class: `irow${r.on ? '' : ' off'}`, 'data-dir': r.dir },
      box,
      h('div', { class: 'grow' },
        h('div', { class: 'mono small' }, r.dir),
        h('div', { class: 'ictl' }, h('span', { class: 'faint small' }, t('Program')), exeSel, h('span', { class: 'faint small' }, 'VNDB'), q, searchBtn),
        matchEl));
  };
  const redraw = (r) => {
    const old = list.querySelector(`.irow[data-dir="${CSS.escape(r.dir)}"]`);
    if (old) old.replaceWith(renderRow(r));
  };
  const updateCount = () => { status.textContent = t('{n} of {total} selected', { n: rows.filter((r) => r.on).length, total: rows.length }); };
  list.replaceChildren(...rows.map(renderRow));
  updateCount();

  // Match each on VNDB one at a time (VNDB asks apps not to flood it).
  (async () => {
    for (const r of rows) {
      if (stopped) return;
      try { r.match = await vns.call('vndbBestMatch', r.query); } catch { r.match = null; }
      redraw(r);
      await new Promise((res) => setTimeout(res, 350));
    }
  })();

  const ok = await dialog({
    title: t('Import {n} games', { n: rows.length }),
    text: t('Untick anything that isn\'t a game, check the program and VNDB match, then import. Save folders are found automatically where possible.'),
    body: [status, list],
    wide: true,
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Import selected'), value: true, cls: 'primary' }],
  });
  stopped = true;
  if (!ok) return;
  const chosen = rows.filter((r) => r.on).map((r) => ({ exe: r.exe, dir: r.dir, title: r.title, match: r.match || null }));
  if (!chosen.length) return;
  const prog = h('div', { class: 'toast' }, t('Importing…'));
  $('#toasts').append(prog);
  const off = vns.on('import-progress', (p) => {
    if (p.phase === 'add') prog.textContent = t('Importing {n} of {total}: {title}', { n: p.done + 1, total: p.total, title: p.title });
  });
  let res = [];
  try { res = await call('importGames', chosen); } catch { /* toasted */ }
  off();
  prog.remove();
  const withSaves = res.filter((r) => r.savePath).length;
  const failed = res.filter((r) => r.error);
  await loadGames();
  await dialog({
    title: t('Imported {n} games', { n: res.length - failed.length }),
    text: t('{saves} already have their save folder set. The rest need it set on their game page (Auto-detect or Save once).', { saves: withSaves }),
    body: failed.length ? h('div', { class: 'files' }, failed.map((f) => `${f.title}: ${translateMessage(f.error)}`).join('\n')) : null,
  });
  showLibrary({ category: null, tag: null });
}

// ------------------------------------------------------------------ settings / first run

async function storageChooser(current) {
  const wrap = h('div', { style: 'display:grid;gap:8px' }, h('div', { class: 'faint' }, t('Looking for cloud storage apps…')));
  let selected = current.backend === 'gdrive' ? { backend: 'gdrive' } : (current.cloudDir ? { cloudDir: current.cloudDir } : null);
  const preview = h('div', { class: 'faint mono' });
  const setPreview = () => {
    if (!selected) preview.textContent = '';
    else if (selected.backend === 'gdrive') preview.textContent = t('Saves will be kept in a "VN Shelf" folder in your Google Drive{email}.', { email: setup.googleEmail ? ` (${setup.googleEmail})` : '' });
    else preview.textContent = t('Saves will be kept in: {dir}', { dir: selected.cloudDir });
  };
  const list = await vns.call('detectProviders').catch(() => []);
  const choices = [];
  const pick = (el, value) => {
    for (const c of choices) c.classList.remove('sel');
    if (el) el.classList.add('sel');
    selected = value;
    setPreview();
  };

  const parts = [];
  if (setup.driveAvailable) {
    const sub = h('div', { class: 'p' });
    const setSub = () => {
      sub.textContent = setup.googleSignedIn
        ? t('Signed in as {email}. Nothing else to install.', { email: setup.googleEmail || t('your Google account') })
        : t('Sign in with Google. No Drive app needed; VN Shelf can only see the files it creates.');
    };
    setSub();
    const driveEl = h('div', { class: `choice${selected && selected.backend === 'gdrive' ? ' sel' : ''}`, onclick: async () => {
      if (!setup.googleSignedIn) {
        sub.textContent = t('Finish signing in in your browser…');
        try {
          await vns.call('googleSignIn');
          setup = await vns.call('getSetup');
        } catch (e) {
          toast(cleanError(e), 'bad');
          setSub();
          return;
        }
        setSub();
      }
      pick(driveEl, { backend: 'gdrive' });
    } }, h('div', { class: 'grow' }, h('div', {}, t('Google Drive (sign in)')), sub));
    choices.push(driveEl);
    parts.push(h('div', { class: 'faint' }, t('Sync directly with Google Drive:')), driveEl,
      h('div', { class: 'faint', style: 'margin-top:6px' }, t('Or keep saves in a folder that a cloud app, Syncthing or a NAS keeps in sync:')));
  }
  for (const p of list) {
    const target = joinPath(p.path, 'VNShelf');
    const el = h('div', { class: `choice${selected && selected.cloudDir === target ? ' sel' : ''}`, onclick: () => pick(el, { cloudDir: target }) },
      h('div', { class: 'grow' }, h('div', {}, p.label), h('div', { class: 'p' }, p.path)));
    choices.push(el);
    parts.push(el);
  }
  const other = h('div', { class: 'choice', onclick: async () => {
    const dir = await vns.call('pickFolder', t('Choose a synced folder (Google Drive, OneDrive, Dropbox, Syncthing, NAS…)'));
    if (!dir) return;
    pick(other, { cloudDir: baseName(dir).toLowerCase() === 'vnshelf' ? dir : joinPath(dir, 'VNShelf') });
  } }, h('div', { class: 'grow' }, h('div', {}, t('Another folder…')), h('div', { class: 'p' }, t('Any folder a cloud app or Syncthing keeps in sync, a NAS share, or a USB drive'))));
  choices.push(other);
  parts.push(other);
  if (selected && selected.cloudDir && !list.some((p) => joinPath(p.path, 'VNShelf') === selected.cloudDir)) other.classList.add('sel');
  if (!list.length) parts.splice(setup.driveAvailable ? 3 : 0, 0, h('div', { class: 'faint' }, t('No cloud storage apps found on this PC.')));
  wrap.replaceChildren(...parts, preview);
  setPreview();
  return { el: wrap, get: () => selected };
}

function toolsEditor() {
  const tools = (setup.settings.tools || []).map((x) => ({ ...x }));
  const wrap = h('div', { class: 'tools' });
  const draw = () => {
    wrap.replaceChildren(
      ...tools.map((tl, i) => {
        const name = h('input', { type: 'text', value: tl.name || '', placeholder: t('Name, e.g. LunaHook') });
        name.addEventListener('input', () => { tl.name = name.value; });
        const p = h('input', { type: 'text', value: tl.path || '', placeholder: t('Program') });
        p.addEventListener('input', () => { tl.path = p.value.trim(); });
        const args = h('input', { type: 'text', value: tl.args || '', placeholder: t('Options (optional). {gameExe}, {gameDir} and {title} are filled in.') });
        args.addEventListener('input', () => { tl.args = args.value; });
        const delay = h('input', { type: 'number', min: '0', max: '120', value: String(tl.delaySec || 0), class: 'num' });
        delay.addEventListener('input', () => { tl.delaySec = Number(delay.value) || 0; });
        const close = h('input', { type: 'checkbox', checked: tl.closeWithGame !== false });
        close.addEventListener('change', () => { tl.closeWithGame = close.checked; });
        const all = h('input', { type: 'checkbox', checked: !!tl.allGames });
        all.addEventListener('change', () => { tl.allGames = all.checked; });
        return h('div', { class: 'toolrow' },
          h('div', { class: 'val' }, name, h('button', { type: 'button', class: 'small ghost danger', onclick: () => { tools.splice(i, 1); draw(); } }, t('Remove'))),
          h('div', { class: 'val' }, p, h('button', { type: 'button', class: 'small', onclick: async () => {
            const f = await vns.call('pickFile', t('Choose the program'), [{ name: t('Programs'), extensions: ['exe', 'bat', 'cmd', 'lnk', 'sh', 'AppImage'] }, { name: t('All files'), extensions: ['*'] }]);
            if (f) { tl.path = f; p.value = f; if (!tl.name) { tl.name = baseName(f).replace(/\.[^.]+$/, ''); name.value = tl.name; } }
          } }, t('Browse…'))),
          args,
          h('div', { class: 'val wrap' },
            h('label', { class: 'check' }, t('Start after'), delay, t('seconds')),
            h('label', { class: 'check' }, close, t('Close it when the game closes')),
            h('label', { class: 'check' }, all, t('Start with every game'))));
      }),
      h('button', { type: 'button', class: 'small', onclick: () => { tools.push({ name: '', path: '', args: '', delaySec: 0, closeWithGame: true, allGames: false }); draw(); } }, t('+ Add a tool')),
    );
  };
  draw();
  return { el: wrap, get: () => tools.filter((x) => x.path) };
}

async function settingsDialog(first = false) {
  const s = setup.settings;
  const name = h('input', { type: 'text', value: s.deviceName, placeholder: t('e.g. Desktop, Laptop') });
  const chooser = await storageChooser({ backend: setup.backend, cloudDir: s.cloudDir });
  const langSel = h('select', {},
    [['auto', t('Automatic (follow Windows)')], ['en', 'English'], ['ja', '日本語']].map(([v, l]) => h('option', { value: v, selected: s.language === v }, l)));
  const depth = h('input', { type: 'number', min: '1', max: '100', value: String(s.historyDepth) });
  const liveBox = h('input', { type: 'checkbox', checked: s.liveMode });
  const upd = h('input', { type: 'checkbox', checked: s.autoUpdate !== false });
  const lePath = h('input', { type: 'text', value: s.localeEmulatorPath || '', placeholder: t('Path to LEProc.exe (optional)') });
  const tools = toolsEditor();
  const body = [
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Language')), langSel),
    first ? null : h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Background (this PC)')), backgroundEditor()),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Name of this PC (shown on the other PC)')), name),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Where to keep saves — choose the same cloud service on every PC')), chooser.el),
  ];
  if (!first) {
    body.push(
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Older versions to keep per game')), depth),
      h('div', { class: 'field' }, h('label', { class: 'check' }, liveBox, t('Upload saves while playing (about 10 seconds after each save)'))),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Locale Emulator (for games that need Japanese locale)')),
        h('div', { class: 'val' }, lePath, h('button', { type: 'button', onclick: async () => {
          const f = await vns.call('pickFile', t('Find LEProc.exe'), [{ name: 'LEProc', extensions: ['exe'] }]);
          if (f) lePath.value = f;
        } }, t('Browse…')))),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Companion tools on this PC (text hooker, meikipop, Magpie…). Pick which start with each game on its page.')), tools.el),
      setup.googleSignedIn ? h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Google account')),
        h('div', { class: 'val' }, h('div', { class: 'grow' }, setup.googleEmail || t('Signed in')),
          h('button', { type: 'button', class: 'small', onclick: async () => {
            setup = await call('googleSignOut');
            closeDialog(false);
            toast(t('Signed out of Google. VN Shelf no longer has access to your Drive.'), 'good');
            if (!setup.configured) await settingsDialog(true);
            await loadGames();
          } }, t('Sign out')))) : null,
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Updates')),
        h('div', { class: 'val wrap' }, h('label', { class: 'check' }, upd, t('Check for updates when VN Shelf starts')),
          h('button', { type: 'button', class: 'small', onclick: () => checkUpdatesNow() }, t('Check now')))),
      h('div', { class: 'faint' }, t('Switching where saves are kept doesn\'t move games already added; add them again on the new storage.')),
      h('div', { class: 'faint' }, `VN Shelf ${setup.version}`),
    );
  }
  const ok = await dialog({
    title: first ? t('Welcome to VN Shelf') : t('Settings'),
    text: first ? t('Pick where your saves are kept. Use the same cloud service on each PC and they\'ll share saves automatically.') : null,
    body,
    buttons: [
      ...(first ? [] : [{ label: t('Cancel'), value: false, cls: 'ghost' }]),
      { label: first ? t('Start') : t('Save'), value: true, cls: 'primary', validate: () => {
        if (!chooser.get()) { toast(t('Choose where to keep saves.'), 'bad'); return false; }
        return true;
      } },
    ],
  });
  applyBackground(setup.settings.background);
  if (!ok) return;
  const patch = { deviceName: name.value, ...chooser.get(), language: langSel.value };
  if (!first) Object.assign(patch, { historyDepth: depth.value, liveMode: liveBox.checked, localeEmulatorPath: lePath.value.trim(), autoUpdate: upd.checked, tools: tools.get() });
  setup = await call('saveSettings', patch);
  setLanguage(setup.settings.language);
  applyStaticText();
  showUpdatePill(lastUpdate);
  await loadGames();
  if (view === 'detail' && currentId) renderDetail(currentId, { noAuto: true });
}

// ------------------------------------------------------------------ background

/** Show the chosen background image behind the app (or none). `look` overrides dim/blur for previews. */
function applyBackground(bg, look) {
  const el = $('#appBg');
  const on = !!(bg && bg.url);
  document.body.classList.toggle('has-bg', on);
  el.classList.toggle('hidden', !on);
  if (!on) { el.style.backgroundImage = ''; return; }
  const dim = look && look.dim !== undefined ? look.dim : bg.dim;
  const blur = look && look.blur !== undefined ? look.blur : bg.blur;
  el.style.backgroundImage = `url("${bg.url}")`;
  el.style.filter = blur ? `blur(${blur}px)` : '';
  el.style.inset = blur ? `-${blur * 2}px` : '0';
  document.documentElement.style.setProperty('--bg-dim', String(dim));
}

function backgroundEditor() {
  const wrap = h('div', { class: 'bgedit' });
  const draw = () => {
    const bg = setup.settings.background;
    const dim = h('input', { type: 'range', min: '0', max: '0.95', step: '0.01', value: String(bg ? bg.dim : 0.72) });
    const blur = h('input', { type: 'range', min: '0', max: '30', step: '1', value: String(bg ? bg.blur : 0) });
    const preview = () => applyBackground(bg, { dim: Number(dim.value), blur: Number(blur.value) });
    const commit = async () => { setup = await call('setBackgroundLook', { dim: Number(dim.value), blur: Number(blur.value) }); };
    for (const r of [dim, blur]) { r.addEventListener('input', preview); r.addEventListener('change', commit); }
    replaceKids(wrap,
      h('div', { class: 'val wrap' },
        bg ? h('div', { class: 'bgthumb', style: `background-image:url("${bg.url}")` }) : h('div', { class: 'faint small' }, t('No background image.')),
        h('button', { type: 'button', class: 'small', onclick: async () => {
          let r;
          try { r = await call('chooseBackground'); } catch { return; }
          if (r) { setup = r; applyBackground(setup.settings.background); draw(); }
        } }, bg ? t('Change image…') : t('Choose image…')),
        bg ? h('button', { type: 'button', class: 'small ghost danger', onclick: async () => {
          setup = await call('clearBackground');
          applyBackground(null);
          draw();
        } }, t('Remove')) : null),
      bg ? h('div', { class: 'val wrap' },
        h('label', { class: 'check' }, t('Darken'), dim),
        h('label', { class: 'check' }, t('Blur'), blur)) : null);
  };
  draw();
  return wrap;
}

// ------------------------------------------------------------------ updates

let lastUpdate = null;

function showUpdatePill(u) {
  lastUpdate = u || null;
  const pill = $('#updatePill');
  if (!u) { pill.classList.add('hidden'); return; }
  pill.textContent = t('Update {version} available', { version: u.version });
  pill.classList.remove('hidden');
  pill.onclick = () => updateDialog(u);
}

/** A dismissable pop-up for a newly found update. Hiding it remembers that version on this PC. */
function showUpdatePopup(u) {
  showUpdatePill(u);
  let hiddenFor = null;
  try { hiddenFor = localStorage.getItem('vns-update-hidden'); } catch { /* storage unavailable */ }
  if (!u || hiddenFor === u.version) return;
  const firstLine = String(u.notes || '').split('\n').map((l) => l.replace(/^[#*\-\s]+/, '').trim()).find(Boolean) || '';
  const pop = h('div', { class: 'updatepop', role: 'status' },
    h('div', { class: 'grow' },
      h('div', { class: 't' }, t('VN Shelf {version} is available', { version: u.version })),
      h('div', { class: 'faint small' }, firstLine ? `${firstLine.slice(0, 140)}` : t('You have {current}.', { current: setup.version }))),
    h('button', { class: 'small primary', onclick: () => { pop.remove(); updateDialog(u); } }, t('View & update')),
    h('button', { class: 'small ghost', title: t('Hide until the next update'), onclick: () => {
      try { localStorage.setItem('vns-update-hidden', u.version); } catch { /* storage unavailable */ }
      pop.remove();
    } }, t('Hide')));
  const old = $('.updatepop');
  if (old) old.remove();
  document.body.append(pop);
}

async function checkUpdatesNow() {
  let u;
  try { u = await call('checkUpdate'); } catch { return; }
  showUpdatePill(u);
  if (!u) toast(t('VN Shelf is up to date ({version}).', { version: setup.version }), 'good');
  else updateDialog(u);
}

async function updateDialog(u) {
  const canInstall = setup.platform === 'win32' && setup.portable && u.asset;
  const notes = h('div', { class: 'notes-view' }, u.notes || t('No release notes.'));
  const v = await dialog({
    title: t('VN Shelf {version} is available', { version: u.version }),
    text: canInstall
      ? t('You have {current}. Updating downloads the new version, restarts VN Shelf and keeps all your settings.', { current: setup.version })
      : t('You have {current}. Download the new version from GitHub.', { current: setup.version }),
    body: notes,
    wide: true,
    buttons: [{ label: t('Later'), value: null, cls: 'ghost' }, { label: canInstall ? t('Update and restart') : t('Open download page'), value: 'go', cls: 'primary' }],
  });
  if (v !== 'go') return;
  const prog = h('div', { class: 'toast' }, t('Downloading update…'));
  if (canInstall) $('#toasts').append(prog);
  const off = vns.on('update-progress', (p) => {
    if (p.total) prog.textContent = t('Downloading update… {pct}%', { pct: Math.floor((p.received / p.total) * 100) });
  });
  try {
    const r = await call('installUpdate');
    if (r && r.restarting) prog.textContent = t('Restarting…');
    else prog.remove();
  } catch { prog.remove(); }
  off();
}

// ------------------------------------------------------------------ detail

async function openDetail(id, opts = {}) {
  currentId = id;
  setView('detail');
  pushNav();
  await renderDetail(id, opts);
}

function statusText(g) {
  const l = live[g.id];
  if (l && l.state === 'running') return { text: translateMessage(l.message) || t('Playing'), cls: '' };
  if (l && (l.state === 'syncing' || l.state === 'scanning')) return { text: translateMessage(l.message) || t('Syncing…'), cls: '' };
  if (l && l.state === 'error') return { text: translateMessage(l.message), cls: 'bad' };
  const b = badges[g.id];
  if (!g.installed) return { text: t('Not set up on this PC yet — press Play to find the game.'), cls: 'warn' };
  if (!b) return { text: t('Checking saves…'), cls: '' };
  const from = b.cloud ? ` ${t('Last upload: {name}, {when}.', { name: b.cloud.deviceName, when: ago(b.cloud.pushedAt) })}` : '';
  const lock = b.lock ? ` ${t('Open on {name} since {when}.', { name: b.lock.deviceName, when: when(b.lock.since) })}` : '';
  const map = {
    synced: { text: `${t('Saves are in sync.')}${from}${lock}`, cls: '' },
    upload: { text: `${t('This PC has newer saves; they\'ll upload next time you play or sync.')}${lock}`, cls: '' },
    download: { text: `${t('Newer saves are waiting from {name}; they\'ll download when you press Play.', { name: b.cloud ? b.cloud.deviceName : t('another PC') })}${lock}`, cls: '' },
    conflict: { text: t('Saves changed here and on another PC. Press Sync now to choose.'), cls: 'bad' },
    offline: { text: t('Shared folder not reachable right now.'), cls: 'warn' },
    'no-saves': { text: t('No save folder set yet — add one below so saves can sync.'), cls: 'warn' },
    error: { text: t('Couldn\'t check saves.'), cls: 'bad' },
    running: { text: t('Playing'), cls: '' },
  };
  return map[b.badge] || { text: '', cls: '' };
}

function updateStatusLine() {
  const g = games.find((x) => x.id === currentId);
  const el = $('#statusline');
  if (!g || !el) return;
  const s = statusText(g);
  el.textContent = s.text;
  el.className = `statusline ${s.cls}`;
  const isRunning = live[g.id] && live[g.id].state === 'running';
  const btn = $('#playBtn');
  if (btn) {
    const syncing = live[g.id] && live[g.id].state === 'syncing';
    btn.textContent = isRunning ? t('Stop tracking') : syncing ? t('Syncing saves…') : t('▶ Play');
    btn.classList.toggle('stop', !!isRunning);
    btn.classList.toggle('busy', !!syncing);
    btn.disabled = !!syncing;
    btn.title = isRunning ? t('Use this if the game is closed but VN Shelf still thinks it\'s running') : '';
  }
}

function descriptionEl(segments) {
  const box = h('div', { class: 'desc' });
  for (const seg of segments || []) {
    let el = seg.href ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); vns.call('openExternal', seg.href); } }, seg.text) : document.createTextNode(seg.text);
    if (seg.spoiler) el = h('span', { class: 'spoiler', title: t('Spoiler — click to show'), onclick: (e) => e.currentTarget.classList.add('shown') }, el);
    box.append(el);
  }
  return box;
}

function aboutBox(g) {
  const v = g.vndb;
  const box = h('div', { class: 'box' });
  if (!g.vndbId) {
    box.append(h('div', { class: 'note' }, t('Link this game to VNDB to see its description, length, rating and tags.')),
      h('div', { class: 'boxactions' }, h('button', { onclick: async () => { await vndbDialog(g, false); renderDetail(g.id, { noAuto: true }); } }, t('Find on VNDB…'))));
    return box;
  }
  if (!v) {
    box.append(h('div', { class: 'note' }, t('VNDB info hasn\'t been downloaded for this game yet.')),
      h('div', { class: 'boxactions' }, h('button', { onclick: () => refreshVndb(g.id) }, t('Get info from VNDB'))));
    return box;
  }
  const facts = [
    v.released ? [t('Released'), v.released] : null,
    v.length ? [t('Length'), `${LENGTH_TEXT()[v.length] || v.length}${v.lengthMinutes ? ` · ${t('about {h} h by votes', { h: Math.round(v.lengthMinutes / 60) })}` : ''}`] : null,
    v.rating ? [t('VNDB rating'), `${(v.rating / 10).toFixed(2)} (${plural(v.votes, '{n} vote', '{n} votes')})`] : null,
    v.languages && v.languages.length ? [t('Languages'), v.languages.join(', ')] : null,
    v.platforms && v.platforms.length ? [t('Platforms'), v.platforms.join(', ')] : null,
  ].filter(Boolean);
  const tags = (v.tags || []).filter((x) => showSpoilers || !x.spoiler);
  const hidden = (v.tags || []).length - tags.length;
  box.append(
    v.description ? descriptionEl(g.descSegments) : h('div', { class: 'note' }, t('VNDB has no description for this game.')),
    h('div', { class: 'facts' }, facts.map(([k, val]) => h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', {}, val)))),
    h('div', { class: 'tags' },
      tags.map((x) => h('button', { class: `tag tagbtn${x.spoiler ? ' spoil' : ''}`, title: t('Show games with this tag'), onclick: () => { $('#search').value = ''; showLibrary({ tag: { id: x.id, name: x.name }, category: null }); } }, x.name)),
      hidden ? h('button', { class: 'ghost tiny', onclick: () => { showSpoilers = true; renderDetail(g.id, { noAuto: true }); } }, t('Show {n} spoiler tags', { n: hidden })) : null,
      showSpoilers && (v.tags || []).some((x) => x.spoiler) ? h('button', { class: 'ghost tiny', onclick: () => { showSpoilers = false; renderDetail(g.id, { noAuto: true }); } }, t('Hide spoiler tags')) : null),
    h('div', { class: 'boxactions' },
      h('button', { class: 'small', onclick: () => vns.call('openExternal', `https://vndb.org/${g.vndbId}`) }, t('VNDB page')),
      h('button', { class: 'small ghost', onclick: () => refreshVndb(g.id) }, t('Refresh from VNDB')),
      h('span', { class: 'faint small' }, t('Updated {when}', { when: ago(v.fetchedAt) }))),
  );
  return box;
}

async function refreshVndb(id) {
  try { await call('refreshVndb', id); toast(t('VNDB info updated.'), 'good'); } catch { return; }
  await loadGamesKeepView();
}

function notesBox(g) {
  const area = h('textarea', { class: 'notes', placeholder: t('Your notes: routes done, where you are, things to remember…') }, g.notes || '');
  const state = h('span', { class: 'faint small' });
  let timer = null;
  const saveNow = async () => {
    clearTimeout(timer);
    if (area.value === (g.notes || '')) return;
    try {
      await call('updateGame', g.id, { notes: area.value });
      g.notes = area.value;
      state.textContent = t('Saved');
    } catch { state.textContent = t('Not saved'); }
  };
  area.addEventListener('input', () => { state.textContent = t('Editing…'); clearTimeout(timer); timer = setTimeout(saveNow, 800); });
  area.addEventListener('blur', saveNow);
  return h('div', { class: 'box' }, h('div', { class: 'field' }, area, h('div', { class: 'faint small' }, t('Notes sync to your other PCs with the game.'), ' ', state)));
}

function categoryBox(g) {
  const mine = new Set(g.categories || []);
  const all = categoriesAll();
  const box = h('div', { class: 'box' });
  const toggle = async (c) => {
    const next = mine.has(c) ? [...mine].filter((x) => x !== c) : [...mine, c];
    await call('updateGame', g.id, { categories: next });
    await loadGamesKeepView();
  };
  box.append(h('div', { class: 'field' },
    h('div', { class: 'tags' },
      all.map((c) => h('button', { class: `chip${mine.has(c) ? ' on' : ''}`, onclick: () => toggle(c) }, mine.has(c) ? `✓ ${c}` : c)),
      h('button', { class: 'chip add', onclick: async () => {
        const input = h('input', { type: 'text', placeholder: t('Category name') });
        const name = await dialog({ title: t('New category'), body: input,
          buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Add'), value: () => input.value.trim(), cls: 'primary', validate: () => !!input.value.trim() }] });
        if (name) { await call('updateGame', g.id, { categories: [...mine, name] }); await loadGamesKeepView(); }
      } }, t('+ New'))),
    all.length ? null : h('div', { class: 'faint small' }, t('Categories group games in the sidebar, like folders.'))));
  return box;
}

async function toolsBox(g) {
  const list = await vns.call('gameTools', g.id).catch(() => []);
  const box = h('div', { class: 'box' });
  if (!list.length) {
    box.append(h('div', { class: 'note' }, t('Start a text hooker, meikipop, Magpie or other programs with this game. Add them once in Settings, then tick them here.')),
      h('div', { class: 'boxactions' }, h('button', { class: 'small', onclick: () => settingsDialog(false) }, t('Open Settings'))));
    return box;
  }
  for (const tl of list) {
    const cb = h('input', { type: 'checkbox', checked: tl.enabled, disabled: tl.allGames });
    cb.addEventListener('change', async () => {
      const ids = list.filter((x) => !x.allGames && (x.id === tl.id ? cb.checked : x.enabled)).map((x) => x.id);
      tl.enabled = cb.checked;
      await call('setGameTools', g.id, ids);
    });
    box.append(h('div', { class: 'field' }, h('label', { class: 'check' }, cb, tl.name || baseName(tl.path)),
      h('div', { class: 'faint small' }, [tl.allGames ? t('Starts with every game') : null, tl.delaySec ? t('after {n} s', { n: tl.delaySec }) : null, tl.closeWithGame !== false ? t('closes with the game') : t('keeps running')].filter(Boolean).join(' · '))));
  }
  return box;
}

function backupBox(g) {
  return h('div', { class: 'box' },
    h('div', { class: 'note' }, t('Save the current saves on this PC as a .zip (for safekeeping or another computer), or put saves from such a zip back. Your current saves go to History first.')),
    h('div', { class: 'boxactions' },
      h('button', { class: 'small', disabled: !g.installed || !(g.saves || []).length, onclick: async () => {
        let r;
        try { r = await call('exportSaves', g.id); } catch { return; }
        if (r) toast(t('Exported {files} to {path}', { files: plural(r.files, '{n} file', '{n} files'), path: r.path }), 'good');
      } }, t('Export saves…')),
      h('button', { class: 'small', disabled: !g.installed || !(g.saves || []).length, onclick: async () => {
        let r;
        try { r = await call('importSaves', g.id); } catch { return; }
        if (!r) return;
        toast(t('Imported {files} from {game}.', { files: plural(r.files, '{n} file', '{n} files'), game: r.fromGame || t('the zip') }) + (r.uploaded ? ` ${t('Uploaded to your other PCs.')}` : ''), 'good');
        renderDetail(g.id, { noAuto: true });
        refreshStatus(g.id);
      } }, t('Import saves…'))));
}

async function renderDetail(id, opts = {}) {
  let g;
  try { g = await vns.call('getGame', id); } catch (e) { toast(cleanError(e), 'bad'); showHome(); return; }
  const idx = games.findIndex((x) => x.id === id);
  if (idx >= 0) games[idx] = g; else games.push(g);
  const saves = await vns.call('describeSaves', id).catch(() => []);
  const history = await vns.call('history', id).catch(() => []);

  const hero = h('div', { class: 'hero' },
    h('div', { class: 'bgimg', style: g.coverUrl ? `background-image:url("${g.coverUrl}")` : null }),
    h('div', { class: 'bgfade' }),
    h('div', { class: 'inner' },
      h('div', { class: 'cover' }, g.coverUrl ? h('img', { src: g.coverUrl, alt: '' }) : h('div', { class: 'placeholder' }, g.title)),
      h('div', { class: 'grow' },
        h('h1', {}, g.title),
        g.titleAlt ? h('div', { class: 'alt' }, g.titleAlt) : null,
        h('div', { class: 'meta' },
          g.developer ? h('span', {}, g.developer) : null,
          g.engine ? h('span', {}, g.engine) : null,
          g.playMinutes ? h('span', {}, t('{h} played here', { h: hours(g.playMinutes) })) : null,
          g.lastPlayed ? h('span', {}, t('Last played {when}', { when: ago(g.lastPlayed) })) : null,
          (g.categories || []).map((c) => h('span', { class: 'tag' }, c))),
        h('div', { class: 'actions' },
          h('button', { id: 'playBtn', class: 'play', onclick: () => {
            if (live[id] && live[id].state === 'running') vns.call('stopTracking', id);
            else play(id);
          } }, t('▶ Play')),
          h('button', { onclick: () => syncNow(id), disabled: !g.installed || !saves.length }, t('Sync now'))),
        h('div', { id: 'statusline', class: 'statusline' }))));

  // ---- save locations
  const saveBox = h('div', { class: 'box' });
  if (!saves.length) saveBox.append(h('div', { class: 'note' }, t('No save folder yet. Auto-detect usually finds it; if not, use Save once or pick the folder yourself.')));
  for (const s of saves) {
    const inc = s.include && s.include.length ? s.include.join(', ') : t('all files');
    saveBox.append(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'path' }, s.path, !s.portable ? h('span', { class: 'tag warn', style: 'margin-left:8px', title: t('This folder isn\'t under AppData, Documents or the game folder, so the other PC needs the exact same path.') }, t('this PC only')) : null),
        s.abs ? h('div', { class: 'abs', title: t('Open folder'), onclick: () => vns.call('openPath', s.abs) }, s.abs) : h('div', { class: 'abs' }, translateMessage(s.error) || ''),
        h('div', { class: 'faint', style: 'font-size:12px' }, t('Files: {which}', { which: inc }))),
      h('span', { class: `count${s.fileCount ? '' : ' zero'}`, title: s.skipped ? t('{n} file(s) skipped because they aren\'t saves (programs, video, archives, logs, huge files)', { n: s.skipped }) : null },
        s.exists ? `${s.size || plural(s.fileCount, '{n} file', '{n} files')}${s.skipped ? ` · ${t('{n} skipped', { n: s.skipped })}` : ''}` : t('folder not there yet')),
      h('button', { class: 'small ghost', onclick: () => editInclude(id, s) }, t('Files…')),
      h('button', { class: 'small ghost danger', onclick: async () => {
        const ok = await dialog({ title: t('Stop syncing this folder?'), text: t('{path} will no longer sync. Nothing is deleted.', { path: s.path }),
          buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Remove'), value: true, cls: 'primary' }] });
        if (ok) { await call('removeSaveRule', id, s.id); renderDetail(id); refreshStatus(id); }
      } }, t('Remove'))));
  }
  const suggestBox = h('div', { class: 'box suggest hidden', style: 'margin-top:12px' });
  saveBox.append(h('div', { class: 'boxactions' },
    h('button', { onclick: () => runSuggest(id, suggestBox), disabled: !g.installed }, t('Auto-detect')),
    h('button', { onclick: () => saveOnce(id), disabled: !g.installed }, t('Save once…')),
    h('button', { onclick: async () => {
      const dir = await call('pickFolder', t('Choose the folder this game saves into'), g.installDir || undefined);
      if (dir && (await addRule(id, { absPath: dir }))) { renderDetail(id, { noAuto: true }); refreshStatus(id); }
    }, disabled: !g.installed }, t('Choose folder…')),
    h('button', { class: 'ghost', onclick: () => typePath(id) }, t('Type a path…'))));

  // ---- launch
  const args = h('input', { type: 'text', value: (g.launch && g.launch.args) || '', placeholder: t('Extra launch options (optional)') });
  args.addEventListener('change', () => call('updateGame', id, { launch: { args: args.value } }));
  const le = h('input', { type: 'checkbox', checked: !!(g.launch && g.launch.useLocaleEmulator), disabled: !setup.settings.localeEmulatorPath });
  le.addEventListener('change', () => call('updateGame', id, { launch: { useLocaleEmulator: le.checked } }));
  const launchBox = h('div', { class: 'box' },
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Program on this PC')),
      h('div', { class: 'val' }, h('div', { class: 'grow mono' }, g.exePath || t('Not set up on this PC')),
        h('button', { class: 'small', onclick: async () => { if (await call('locateGame', id)) { renderDetail(id); refreshStatus(id); } } }, g.exePath ? t('Change…') : t('Find…')))),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Game folder (stands for <game> in save paths)')),
      h('div', { class: 'val' }, h('div', { class: 'grow mono' }, g.installDir || '—'),
        h('button', { class: 'small', disabled: !g.installDir, onclick: async () => { if (await call('setGameFolder', id)) { renderDetail(id); refreshStatus(id); } } }, t('Change…')))),
    h('div', { class: 'field' }, h('label', { class: 'check' }, le, t('Start through Locale Emulator (Japanese locale)')),
      !setup.settings.localeEmulatorPath ? h('div', { class: 'faint', style: 'font-size:12px' }, t('Set Locale Emulator\'s location in Settings to use this.')) : null),
    h('div', { class: 'field' }, args));

  // ---- history
  const histBox = h('div', { class: 'box' });
  if (!history.length) histBox.append(h('div', { class: 'note' }, t('Older versions appear here after saves sync. The newest {n} are kept.', { n: setup.settings.historyDepth })));
  const KIND = { pushed: t('Uploaded'), 'before-pull': t('Backup before download'), 'before-restore': t('Backup before restore'), 'before-import': t('Backup before import') };
  for (const v of history) {
    histBox.append(h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', {}, `${KIND[v.kind] || v.kind} · ${v.deviceName}`), h('div', { class: 'faint', style: 'font-size:12px' }, `${when(v.at)} · ${plural(v.files, '{n} file', '{n} files')}`)),
      h('button', { class: 'small', disabled: !g.installed, onclick: async () => {
        const ok = await dialog({ title: t('Restore this version?'), text: t('Your current saves on this PC are backed up first, then this version is put back and becomes the latest for every PC.'),
          buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Restore'), value: true, cls: 'primary' }] });
        if (ok) { await call('restore', id, v.name); toast(t('Restored.'), 'good'); renderDetail(id); refreshStatus(id); }
      } }, t('Restore'))));
  }

  // ---- details
  const title = h('input', { type: 'text', value: g.title });
  title.addEventListener('change', async () => { await call('updateGame', id, { title: title.value.trim() || g.title }); renderDetail(id); });
  const detailsBox = h('div', { class: 'box' },
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Title')), title),
    h('div', { class: 'boxactions' },
      h('button', { onclick: async () => { await vndbDialog(g, false); renderDetail(id); } }, t('Find on VNDB…')),
      h('button', { onclick: async () => { if (await call('setCustomCover', id)) renderDetail(id); } }, t('Use my own cover…')),
      h('div', { class: 'spacer' }),
      h('button', { class: 'ghost danger', onclick: async () => {
        const ok = await dialog({ title: t('Remove {title}?', { title: g.title }), text: t('It disappears from the library on every PC. The game itself and its save files on this PC aren\'t touched, and the shared copy is kept (moved aside in the shared folder, or to Drive\'s trash).'),
          buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Remove'), value: true, cls: 'primary' }] });
        if (ok) { await call('removeGame', id); await loadGames(); showHome(); }
      } }, t('Remove from library'))));

  const tools = await toolsBox(g);
  if (currentId !== id || view !== 'detail') return;
  $('#detailView').replaceChildren(hero, h('div', { class: 'panels' },
    h('div', { class: 'panel' },
      h('h2', {}, t('About')), aboutBox(g),
      h('h2', {}, t('Save locations')), saveBox, suggestBox,
      h('h2', {}, t('Notes')), notesBox(g)),
    h('div', { class: 'panel' },
      h('h2', {}, t('Launch')), launchBox,
      h('h2', {}, t('Start with this game')), tools,
      h('h2', {}, t('Categories')), categoryBox(g),
      h('h2', {}, t('Save backup')), backupBox(g),
      h('h2', {}, t('History')), histBox,
      h('h2', {}, t('Details')), detailsBox)));
  updateStatusLine();
  if (!badges[id]) refreshStatus(id);
  if (opts.suggest || (!saves.length && g.installed && !opts.noAuto)) runSuggest(id, suggestBox);
}

/** Add a save location, handling "that can't be a save folder" and "that's unusually big". */
async function addRule(id, args) {
  let res;
  try { res = await call('addSaveRule', id, args); } catch { return null; }
  if (res.needsConfirm) {
    const ok = await dialog({
      title: t('That folder is unusually big'),
      text: t('{path} holds {size}. Save folders are normally much smaller. Only continue if you\'re sure this folder holds just the game\'s saves; otherwise pick a smaller folder or limit it to the save files.', { path: res.path, size: res.size }),
      buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Sync it anyway'), value: true, cls: 'primary' }],
    });
    if (!ok) return null;
    try { res = await call('addSaveRule', id, { ...args, confirmLarge: true }); } catch { return null; }
  }
  if (res.refused) {
    await dialog({ title: t('Can\'t sync that folder'), text: translateMessage(res.refused) });
    return null;
  }
  afterAdd(res);
  return res;
}

function afterAdd(r) {
  if (r && r.portable === false) {
    toast(t('That folder is outside AppData, Documents and the game folder, so it only works if the other PC has the exact same path.'), 'bad');
  } else toast(t('Save location added.'), 'good');
}

async function runSuggest(id, box) {
  box.classList.remove('hidden');
  box.replaceChildren(h('div', { class: 'note' }, t('Looking for save folders…')));
  let r;
  try { r = await vns.call('suggestSaves', id); } catch (e) { box.replaceChildren(h('div', { class: 'note' }, cleanError(e))); return; }
  const g = games.find((x) => x.id === id) || {};
  const already = new Set((g.saves || []).map((s) => `${s.path}|${(s.include || []).join(',')}`));
  const list = r.candidates.filter((c) => !already.has(`${c.path}|${(c.include || []).join(',')}`));
  const head = h('div', { class: 'note' }, r.engine ? `${t('Looks like a {engine} game.', { engine: r.engine })} ` : '',
    list.length ? t('Suggestions (folders with files in them are most likely):') : t('No suggestions. Try Save once, or choose the folder yourself.'));
  box.replaceChildren(head, ...list.slice(0, 8).map((c) => h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'path' }, c.path, c.include && c.include.length ? `  (${c.include.join(', ')})` : ''),
      h('div', { class: 'faint', style: 'font-size:12px' }, translateMessage(c.reason))),
    h('span', { class: `count${c.fileCount ? '' : ' zero'}` }, c.exists ? plural(c.fileCount, '{n} file', '{n} files') : t('not there yet')),
    h('button', { class: 'small primary', onclick: async () => {
      if (!(await addRule(id, { path: c.path, include: c.include }))) return;
      await renderDetail(id, { noAuto: true });
      refreshStatus(id);
    } }, t('Use')))),
  h('div', { class: 'boxactions' }, h('button', { class: 'small ghost', onclick: () => box.classList.add('hidden') }, t('Hide'))));
}

async function editInclude(id, s) {
  const inc = h('input', { type: 'text', value: (s.include || []).join(', '), placeholder: t('All files') });
  const exc = h('input', { type: 'text', value: (s.exclude || []).join(', '), placeholder: t('Nothing') });
  const ok = await dialog({
    title: t('Which files to sync'),
    text: t('Comma-separated patterns. * matches anything in a name, ** matches folders too. Example: Save*.rvdata2, *.sav'),
    body: [h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Only these files')), inc),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Skip these files')), exc)],
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Save'), value: true, cls: 'primary' }],
  });
  if (!ok) return;
  await call('updateSaveRule', id, s.id, { include: inc.value.split(','), exclude: exc.value.split(',') });
  renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

async function typePath(id) {
  const p = h('input', { type: 'text', placeholder: 'C:\\Users\\you\\AppData\\Roaming\\Studio\\Game  or  <appdata>/Studio/Game' });
  const inc = h('input', { type: 'text', placeholder: t('All files') });
  const ok = await dialog({
    title: t('Add a save location by path'),
    text: t('Paste the full folder path, or use a placeholder: <game>, <appdata>, <localappdata>, <locallow>, <documents>, <savedgames>, <home>. %APPDATA% style also works.'),
    body: [h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Folder')), p),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Only these files (optional, comma-separated)')), inc)],
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Add'), value: true, cls: 'primary', validate: () => !!p.value.trim() }],
  });
  if (!ok) return;
  let v = p.value.trim().replace(/^"|"$/g, '');
  const envMap = { '%appdata%': '<appdata>', '%localappdata%': '<localappdata>', '%userprofile%': '<home>' };
  v = v.replace(/^%[a-z]+%/i, (m) => envMap[m.toLowerCase()] || m);
  const isToken = /^<[a-z]+>/.test(v);
  if (!(await addRule(id, isToken ? { path: v.replace(/\\/g, '/').replace(/\/+$/, ''), include: inc.value.split(',') } : { absPath: v, include: inc.value.split(',') }))) return;
  renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

async function saveOnce(id) {
  const ok = await dialog({
    title: t('Find saves by saving once'),
    text: t('VN Shelf starts the game and notes the time. Make one save (or start a new game and save), then close the game. VN Shelf then lists the files that changed: in the game folder, AppData, Documents and Saved Games.'),
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Start the game'), value: true, cls: 'primary' }],
  });
  if (!ok) return;
  const r = await call('startSaveOnce', id);
  if (r.needs === 'locate') toast(t('Set up the game on this PC first.'), 'bad');
}

async function showSaveOnceResult({ id, candidates }) {
  if (!candidates.length) {
    await dialog({ title: t('No new files found'), text: t('Nothing changed while the game was open. Did it save? Some games only save when you return to the title screen. You can try again or choose the folder yourself.') });
    return;
  }
  const picks = new Set([0]);
  const rows = candidates.map((c, i) => {
    const box = h('input', { type: 'checkbox', checked: i === 0 });
    box.addEventListener('change', () => (box.checked ? picks.add(i) : picks.delete(i)));
    return h('label', { class: `choice${i === 0 ? ' sel' : ''}`, onclick: (e) => { if (e.target !== box) return; e.currentTarget.classList.toggle('sel', box.checked); } },
      box,
      h('div', { class: 'grow' },
        h('div', { class: 'mono' }, c.path, c.include && c.include.length ? `  (${c.include.join(', ')})` : '', !c.portable ? `  — ${t('this PC only')}` : ''),
        h('div', { class: 'p' }, `${plural(c.fileCount, '{n} changed file', '{n} changed files')} · ${translateMessage(c.reason)}`),
        h('div', { class: 'files' }, c.files.slice(0, 8).join('\n'))));
  });
  const ok = await dialog({
    title: t('Files that changed while you played'),
    text: t('Tick the save folder. The most likely one is ticked already.'),
    body: rows, wide: true,
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Use selected'), value: true, cls: 'primary' }],
  });
  if (!ok) return;
  for (const i of picks) {
    const c = candidates[i];
    await addRule(id, { path: c.path, include: c.include });
  }
  if (view === 'detail' && currentId === id) renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

// ------------------------------------------------------------------ events & boot

vns.on('game-state', async (s) => {
  live[s.id] = s;
  const g = games.find((x) => x.id === s.id);
  if (s.state === 'idle' && s.message) toast(`${g ? g.title : ''}: ${translateMessage(s.message)}`, 'good');
  if (s.state === 'error') toast(translateMessage(s.message), 'bad');
  if (s.state === 'idle' || s.state === 'error') refreshStatus(s.id);
  updateCards(s.id);
  if (view === 'detail' && currentId === s.id) {
    // After a game closes, save folders and history have changed: redraw the page.
    if (s.state === 'idle' && !$('#dlg').open) renderDetail(s.id, { noAuto: true });
    else updateStatusLine();
  }
  if (s.state === 'conflict') {
    const v = await conflictDialog(s.info);
    if (v) syncNow(s.id, { resolution: v });
  }
});
vns.on('games-changed', async () => {
  if (view === 'detail') return;
  games = await call('listGames');
  if (view === 'library') renderGrid(); else renderHome();
  renderSidebar();
});
vns.on('saveonce-result', showSaveOnceResult);
vns.on('update-available', (u) => showUpdatePopup(u));

$('#search').addEventListener('input', () => {
  if (view !== 'library') setView('library');
  renderGrid();
});
$('#backBtn').addEventListener('click', () => navMove(-1));
// Mouse side buttons (back = 3, forward = 4) and Alt+Left / Alt+Right.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); navMove(-1); }
  if (e.button === 4) { e.preventDefault(); navMove(1); }
});
window.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
vns.on('nav', (dir) => navMove(dir === 'back' ? -1 : 1));
$('#addBtn').addEventListener('click', addGameFlow);
$('#importBtn').addEventListener('click', importFolderFlow);
$('#settingsBtn').addEventListener('click', () => settingsDialog(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view === 'detail' && !$('#dlg').open) navMove(-1);
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navMove(-1); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navMove(1); }
});

// Drag an .exe onto the window to add it, or a folder to import the games in it.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropHint').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropHint').classList.add('hidden');
  const f = e.dataTransfer.files[0];
  const p = f && vns.pathForFile(f);
  if (p) addGameFromExe(p);
});

(async function boot() {
  setup = await vns.call('getSetup');
  setLanguage(setup.settings.language);
  applyStaticText();
  applyBackground(setup.settings.background);
  if (!setup.configured) await settingsDialog(true);
  // Paint the library saved last time straight away, then swap in the fresh one (Drive can take seconds).
  const cached = await vns.call('listGames', { cached: true }).catch(() => null);
  if (cached && cached.length) { games = cached; showHome(); }
  if (setup.update) showUpdatePopup(setup.update);
  games = await call('listGames').catch(() => []);
  if (cached && cached.length) {
    if (view === 'home') renderHome();
    else if (view === 'library') renderGrid();
    else if (view === 'detail' && !games.some((g) => g.id === currentId)) showHome();
    renderSidebar();
  } else showHome();
  for (const g of games) refreshStatus(g.id);
})();
