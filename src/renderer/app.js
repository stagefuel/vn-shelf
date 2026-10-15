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
  for (const kid of kids.flat(Infinity)) {
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
function replaceKids(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); }

function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; }

function plural(n, one, many) { return t(n === 1 ? one : many, { n }); }

function sizeText(bytes) {
  if (bytes < 1024) return t('{n} B', { n: bytes });
  if (bytes < 1024 * 1024) return t('{n} KB', { n: Math.round(bytes / 1024) });
  if (bytes < 1024 ** 3) return t('{n} MB', { n: (bytes / 1048576).toFixed(1) });
  return t('{n} GB', { n: (bytes / 1024 ** 3).toFixed(1) });
}

function openLink(url) { return (e) => { e.preventDefault(); vns.call('openExternal', url); }; }

/** **bold**, `code` and links inside one line of Markdown, as DOM nodes (never HTML). */
function inlineMd(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:[^)\s]+)\)|<(https?:[^>\s]+)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('strong', {}, inlineMd(m[1])));
    else if (m[2]) out.push(h('code', {}, m[2]));
    else out.push(h('a', { href: '#', onclick: openLink(m[4] || m[5]) }, m[3] || m[5]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The small part of Markdown that patch notes use: headings, nested "-" lists, paragraphs, and
 * lines that continue a list item. Builds DOM nodes, so nothing in the notes can run as HTML.
 */
function markdownEl(md) {
  const root = h('div', { class: 'md' });
  let lists = []; // open lists, innermost last: { indent, list, li }
  let cont = null; // where a continuation line's text goes
  let blank = false;
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { blank = true; continue; }
    const indent = line.length - line.trimStart().length;
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^(\s*)(?:[-*]|\d+\.)\s+(.*)$/);
    if (head) {
      lists = [];
      cont = null;
      root.append(h(`h${Math.min(6, head[1].length + 2)}`, {}, inlineMd(head[2])));
    } else if (item) {
      while (lists.length && lists[lists.length - 1].indent > indent) lists.pop();
      let top = lists[lists.length - 1];
      if (!top || indent > top.indent) {
        const list = h('ul', {});
        (top && top.li ? top.li : root).append(list);
        top = { indent, list, li: null };
        lists.push(top);
      }
      top.li = h('li', {}, inlineMd(item[2]));
      top.list.append(top.li);
      cont = top.li;
    } else if (lists.length && indent > 0) {
      while (lists.length > 1 && lists[lists.length - 1].indent >= indent) lists.pop();
      const li = lists[lists.length - 1].li;
      if (!blank && cont && li.contains(cont)) cont.append(' ', ...inlineMd(line.trim()));
      else { cont = h('p', {}, inlineMd(line.trim())); li.append(cont); }
    } else {
      lists = [];
      if (!blank && cont && cont.parentNode === root && cont.tagName === 'P') cont.append(' ', ...inlineMd(line.trim()));
      else { cont = h('p', {}, inlineMd(line.trim())); root.append(cont); }
    }
    blank = false;
  }
  return root;
}

// ------------------------------------------------------------------ dialog

/**
 * Show the shared dialog. `buttons`: [{ label, value, cls, validate }]. Resolves with the clicked
 * value, or null on Escape.
 */
function dialog({ title, text, body, buttons = [{ label: t('OK'), value: true, cls: 'primary' }], wide, cls }) {
  const dlg = $('#dlg');
  dlg.className = cls || '';
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
const filter = { category: null, tag: null, status: null };
const live = {};      // id -> { state, message }
const badges = {};    // id -> gameStatus result
let showSpoilers = false;
const progress = {};  // id -> latest sync-progress event, plus when this sync started

const BADGE_TEXT = () => ({
  synced: t('Synced'), upload: t('To upload'), download: t('Newer saves'), conflict: t('Conflict'), offline: t('Offline'),
  'no-saves': t('No save folder'), 'not-installed': t('Not on this PC'), running: t('Playing'), syncing: t('Syncing'), error: t('Error'),
});

// Reading status, in the order shown. The values match VNDB's list labels (see STATUSES in main.js).
const STATUS_TEXT = () => ({
  playing: t('Reading'), wishlist: t('Plan to read'), stalled: t('On hold'), finished: t('Finished'), dropped: t('Dropped'),
});
const STATUS_ORDER = ['playing', 'finished', 'wishlist', 'stalled', 'dropped'];

const SORTS = () => [
  ['title', t('Title')], ['played', t('Last played')], ['added', t('Recently added')], ['released', t('Release date')],
  ['rating', t('VNDB rating')], ['length', t('Length')], ['playtime', t('Time played')], ['status', t('Reading status')],
  ['vote', t('Your rating')], ['started', t('Started')], ['finished', t('Finished')], ['custom', t('My order')],
];

// Each view (all games, a category, a reading status) keeps its own sort; All games uses `sort`.
function sortViewKey() {
  if (filter.category) return `cat:${filter.category}`;
  if (filter.status) return `status:${filter.status}`;
  if (filter.tag) return 'tag';
  return 'all';
}
function currentSort() {
  const k = sortViewKey();
  return (k !== 'all' && (setup.settings.sortBy || {})[k]) || setup.settings.sort || 'title';
}
async function setSort(sortKey) {
  const k = sortViewKey();
  setup = await call('saveSettings', k === 'all' ? { sort: sortKey } : { sortBy: { ...(setup.settings.sortBy || {}), [k]: sortKey } });
  renderGrid();
}

/** "My order": your own arrangement (drag covers or lines). Games not arranged yet go last, oldest first. */
function customIndex() {
  const order = setup.settings.customOrder || [];
  const at = new Map(order.map((id, i) => [id, i]));
  return (g) => (at.has(g.id) ? at.get(g.id) : order.length + 1);
}

/** Drag a game onto another to move it there (only in My order). Scrolls when held near the top or bottom. */
function arrangeDrag(el, g) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-vns-game', g.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-vns-game')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = el.classList.contains('lrow') ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    el.classList.toggle('dropbefore', !after);
    el.classList.toggle('dropafter', after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('dropbefore', 'dropafter'));
  el.addEventListener('drop', async (e) => {
    const from = e.dataTransfer.getData('text/x-vns-game');
    const after = el.classList.contains('dropafter');
    el.classList.remove('dropbefore', 'dropafter');
    if (!from || from === g.id) return;
    e.preventDefault();
    const idx = customIndex();
    const all = [...games].sort((a, b) => idx(a) - idx(b) || String(a.addedAt || '').localeCompare(String(b.addedAt || ''))).map((x) => x.id).filter((id) => id !== from);
    all.splice(all.indexOf(g.id) + (after ? 1 : 0), 0, from);
    setup = await call('saveSettings', { customOrder: all });
    renderGrid();
  });
  return el;
}
let dragScroll = 0;
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('text/x-vns-game')) return;
  const m = $('main').getBoundingClientRect();
  const speed = e.clientY < m.top + 60 ? -14 : e.clientY > m.bottom - 60 ? 14 : 0;
  if (speed && !dragScroll) {
    dragScroll = requestAnimationFrame(function step() { $('main').scrollTop += speed; dragScroll = 0; });
  }
});

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
  // Your own order (dragged in the sidebar) first; categories not in it yet go after, A–Z.
  const order = setup.settings.categoryOrder || [];
  const at = (c) => { const i = order.indexOf(c); return i < 0 ? Infinity : i; };
  return [...set].sort((a, b) => (at(a) - at(b)) || a.localeCompare(b, currentLanguage()));
}

/** Drag a category in the sidebar onto another to move it there. */
function categoryDrag(el, c, cats) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-vns-category', c); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-vns-category')) return;
    e.preventDefault();
    const below = e.offsetY > el.offsetHeight / 2;
    el.classList.toggle('dropabove', !below);
    el.classList.toggle('dropbelow', below);
  });
  el.addEventListener('dragleave', () => el.classList.remove('dropabove', 'dropbelow'));
  el.addEventListener('drop', async (e) => {
    const from = e.dataTransfer.getData('text/x-vns-category');
    const below = el.classList.contains('dropbelow');
    el.classList.remove('dropabove', 'dropbelow');
    if (!from || from === c) return;
    e.preventDefault();
    const next = cats.filter((x) => x !== from);
    next.splice(next.indexOf(c) + (below ? 1 : 0), 0, from);
    setup = await call('saveSettings', { categoryOrder: next });
    renderSidebar();
  });
  return el;
}

// ------------------------------------------------------------------ shell: sidebar, views

function applyStaticText() {
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of document.querySelectorAll('[data-t-title]')) el.title = t(el.dataset.tTitle);
}

let listOnlyAsked = false;
function renderSidebar() {
  // My List's count comes from the saved list: load it once, then keep it current.
  if (setup.vndb && setup.vndb.connected && !listOnlyView && !listOnlyAsked) {
    listOnlyAsked = true;
    loadListOnly().then((r) => { if (r) renderSidebar(); refreshListOnly(); });
  }
  const cats = categoriesAll();
  const count = (c) => games.filter((g) => (g.categories || []).includes(c)).length;
  const item = (label, active, onclick, extra) => h('div', { class: `navitem${active ? ' active' : ''}`, onclick }, label, extra || null);
  const nav = $('#sidebar');
  replaceKids(nav,
    item(t('Home'), view === 'home', () => showHome()),
    item(t('All games'), view === 'library' && !filter.category && !filter.tag && !filter.status, () => showLibrary({ category: null, tag: null }), h('span', { class: 'count' }, games.length)),
    setup.vndb && setup.vndb.connected ? item(t('My List'), view === 'vndb', () => showVndbList(),
      listOnlyView && !listOnlyView.loading ? h('span', { class: 'count' }, (listOnlyView.entries || []).length) : null) : null,
    setup.archive && setup.archive.connected ? item(t('Archive'), view === 'archive', () => showArchive(), archiveNavCount()) : null,
    ...(() => {
      const used = STATUS_ORDER.filter((st) => games.some((g) => statusesOf(g).includes(st)));
      if (!used.length) return [];
      return [h('div', { class: 'navhead' }, t('Reading status')),
        ...used.map((st) => item(h('span', { class: 'catname' }, h('span', { class: `sdot ${st}` }), STATUS_TEXT()[st]), view === 'library' && filter.status === st,
          () => showLibrary({ status: st, category: null, tag: null }), h('span', { class: 'count' }, games.filter((g) => statusesOf(g).includes(st)).length)))];
    })(),
    h('div', { class: 'navhead' }, t('Categories'),
      h('button', { class: 'ghost tiny', title: t('New category'), onclick: newCategory }, '+')),
    ...cats.map((c) => categoryDrag(item(h('span', { class: 'catname' }, c), view === 'library' && filter.category === c,
      () => showLibrary({ category: c, tag: null }),
      h('span', { class: 'count' }, count(c))), c, cats)),
  );
}

function setView(v) {
  if (v !== 'detail') prevView = v;
  view = v;
  $('#homeView').classList.toggle('hidden', v !== 'home');
  $('#libraryView').classList.toggle('hidden', v !== 'library');
  $('#detailView').classList.toggle('hidden', v !== 'detail');
  $('#vndbView').classList.toggle('hidden', v !== 'vndb');
  $('#worksView').classList.toggle('hidden', v !== 'works');
  $('#archiveView').classList.toggle('hidden', v !== 'archive');
  closeLightbox();
  $('main').scrollTop = 0;
  renderSidebar();
}

// ---- navigation history (Back/Forward buttons, mouse side buttons, Alt+←/→)

const nav = { stack: [], index: -1, lastMove: 0 };

function navState() {
  if (view === 'detail') return { view, id: currentId };
  if (view === 'library') return { view, filter: { ...filter } };
  if (view === 'vndb' || view === 'archive') return { view };
  if (view === 'works') return { view, who: $('#worksView').dataset.who };
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
  const offTab = view === 'detail' || view === 'works' || (view === 'library' && !!filter.tag);
  $('#backBtn').classList.toggle('hidden', nav.index <= 0 || !offTab);
}

async function restoreNav(st) {
  if (st.view === 'detail' && games.some((g) => g.id === st.id)) { currentId = st.id; setView('detail'); await renderDetail(st.id, { noAuto: true }); }
  else if (st.view === 'library') { Object.assign(filter, st.filter || {}); setView('library'); renderGrid(); }
  else if (st.view === 'vndb' && setup.vndb && setup.vndb.connected) { setView('vndb'); renderVndbList(); }
  else if (st.view === 'archive' && setup.archive && setup.archive.connected) { setView('archive'); renderArchive(); }
  else if (st.view === 'works') { setView('works'); $('#worksView').dataset.who = st.who; renderWorks(st.who); }
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

// With the Japanese interface, titles show in Japanese where one is known (VNDB's original title).
const hasJapanese = (x) => /[\u3040-\u30ff\u3400-\u9fff]/.test(x || '');
function shownTitle(x) { return currentLanguage() === 'ja' && hasJapanese(x.titleAlt) ? x.titleAlt : x.title; }
function otherTitle(x) { return shownTitle(x) === x.title ? x.titleAlt : x.title; }

function cardFor(g) {
  const art = h('div', { class: 'art' },
    g.coverUrl ? h('img', { src: g.coverUrl, alt: '', loading: 'lazy', draggable: 'false' }) : h('div', { class: 'placeholder' }, shownTitle(g)));
  const b = badgeFor(g);
  if (b) art.append(h('span', { class: `badge ${b}` }, BADGE_TEXT()[b] || b));
  const main = statusesOf(g).find((x) => STATUS_TEXT()[x]);
  if (main) art.append(h('span', { class: `ribbon ${main}`, title: statusesOf(g).map((x) => STATUS_TEXT()[x]).filter(Boolean).join(', ') }));
  const pr = progressShown(g.id);
  if (pr) art.append(h('div', { class: 'syncbar' }, h('div', { style: `width:${progressPct(pr)}%` })));
  if (g.installed && !(live[g.id] && ['running', 'syncing'].includes(live[g.id].state))) {
    art.append(h('button', { class: 'quickplay', onclick: (e) => { e.stopPropagation(); play(g.id); } }, t('▶ Play')));
  }
  // Reading status, then (if play statistics are shown) time played and when, else who made it.
  const showStats = setup.settings.showStats !== false;
  const parts = [];
  // Several statuses (like VNDB labels): the main one, then "+n" (all of them in the tooltip).
  const sts = statusesOf(g).filter((x) => STATUS_TEXT()[x]);
  if (sts.length) {
    parts.push(h('span', { class: `sdot ${sts[0]}` }), STATUS_TEXT()[sts[0]]);
    if (sts.length > 1) parts.push(h('span', { class: 'more', title: sts.map((x) => STATUS_TEXT()[x]).join(', ') }, ` +${sts.length - 1}`));
    if (showStats && g.lastPlayed) parts.push(' · ');
  }
  if (showStats && g.lastPlayed) parts.push(g.playMinutes ? `${hours(g.playMinutes)} · ${ago(g.lastPlayed)}` : t('Played {when}', { when: ago(g.lastPlayed) }));
  else if (!sts.length) parts.push(otherTitle(g) || g.developer || '');
  const sub = parts;
  return h('div', { class: `card${g.installed ? '' : ' uninstalled'}`, tabindex: '0', 'data-id': g.id,
    onclick: () => openDetail(g.id), onkeydown: (e) => { if (e.key === 'Enter') openDetail(g.id); } },
  art,
  h('div', { class: 'title' }, shownTitle(g)),
  h('div', { class: 'sub' }, sub));
}

function updateCards(id) {
  const g = games.find((x) => x.id === id);
  if (!g) return;
  const arranging = (el) => el.closest('#grid.arranging');
  for (const old of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`)) old.replaceWith(arranging(old) ? arrangeDrag(cardFor(g), g) : cardFor(g));
  for (const old of document.querySelectorAll(`.lrow[data-id="${CSS.escape(id)}"]`)) old.replaceWith(arranging(old) ? arrangeDrag(rowFor(g, old.dataset.mode), g) : rowFor(g, old.dataset.mode));
  updateLive(id);
}

// ------------------------------------------------------------------ home

function showHome() {
  setView(games.length ? 'home' : 'library');
  if (view === 'home') renderHome(); else renderGrid();
  pushNav();
}

/** The description as plain text, without spoilers, for short previews. */
function plainDescription(g) {
  return (g.descSegments || []).filter((seg) => !seg.spoiler).map((seg) => seg.text).join('').replace(/\s+/g, ' ').trim();
}

/** Home's top: the game played last, with its details and a big Play button. */
function homeHero(g) {
  const v = g.vndb || {};
  const year = (v.released || '').slice(0, 4);
  const about = plainDescription(g);
  const fact = (k, val) => (val ? h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', {}, val)) : null);
  return h('div', { class: 'homehero', 'data-id': g.id },
    h('div', { class: 'bgimg', style: g.coverUrl ? `background-image:url("${g.coverUrl}")` : null }),
    h('div', { class: 'bgfade' }),
    h('div', { class: 'inner' },
      h('div', { class: 'cover', onclick: () => openDetail(g.id), title: t('Open the game page') },
        g.coverUrl ? h('img', { src: g.coverUrl, alt: '', draggable: 'false' }) : h('div', { class: 'placeholder' }, shownTitle(g))),
      h('div', { class: 'grow' },
        h('div', { class: 'eyebrow' }, t('Last played')),
        h('h1', { onclick: () => openDetail(g.id) }, shownTitle(g)),
        otherTitle(g) ? h('div', { class: 'alt' }, otherTitle(g)) : null,
        h('div', { class: 'facts' },
          fact(t('Developer'), g.developer),
          fact(t('Released'), year),
          fact(t('Time played'), g.playMinutes ? hours(g.playMinutes) : t('Under a minute')),
          fact(t('Last played'), ago(g.lastPlayed))),
        about ? h('div', { class: 'about' }, about) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'play big playbtn', 'data-id': g.id, onclick: () => playOrStop(g.id) }, t('▶ Play')),
          h('button', { onclick: () => openDetail(g.id) }, t('Game page'))),
        h('div', { class: 'statusline', 'data-id': g.id }))));
}

/** Home: the game played last at the top, then a row of other recent games (or the newest, before anything is played). */
function renderHome() {
  const played = games.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed));
  const list = played.length ? played.slice(1) : [...games].sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  replaceKids($('#homeView'),
    played.length ? homeHero(played[0]) : null,
    list.length ? h('h2', { class: 'hometitle' }, played.length ? t('Recently played') : t('Recently added')) : null,
    list.length ? h('div', { class: 'recentrow' }, list.slice(0, 24).map(cardFor)) : null);
  if (played.length) updateLive(played[0].id);
}

// ------------------------------------------------------------------ library grid

function showLibrary(f) {
  if (f) {
    Object.assign(filter, f);
    if (!('status' in f) && ('category' in f || 'tag' in f)) filter.status = null;
  }
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
    title: (a, b) => shownTitle(a).localeCompare(shownTitle(b), 'ja'),
    played: (a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || '')),
    added: (a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')),
    released: (a, b) => String((b.vndb || {}).released || '').localeCompare(String((a.vndb || {}).released || '')),
    rating: (a, b) => ((b.vndb || {}).rating || 0) - ((a.vndb || {}).rating || 0),
    length: (a, b) => ((b.vndb || {}).lengthMinutes || 0) - ((a.vndb || {}).lengthMinutes || 0),
    playtime: (a, b) => (b.playMinutes || 0) - (a.playMinutes || 0),
    status: (a, b) => (STATUS_ORDER.indexOf(a.status) + 1 || 99) - (STATUS_ORDER.indexOf(b.status) + 1 || 99),
    vote: (a, b) => (b.vote || 0) - (a.vote || 0),
    started: (a, b) => String(b.started || '').localeCompare(String(a.started || '')),
    finished: (a, b) => String(b.finished || '').localeCompare(String(a.finished || '')),
    custom: ((idx) => (a, b) => idx(a) - idx(b) || String(a.addedAt || '').localeCompare(String(b.addedAt || '')))(customIndex()),
  }[key] || ((a, b) => a.title.localeCompare(b.title, 'ja'));
  return [...list].sort((a, b) => by(a, b) || shownTitle(a).localeCompare(shownTitle(b), 'ja'));
}

// ---- library views: covers (the grid), a compact list, and a list with small covers

const VIEW_ICONS = {
  covers: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>',
  rows: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="2" width="3.5" height="4.5" rx=".6"/><rect x="1.5" y="9.5" width="3.5" height="4.5" rx=".6"/><rect x="7" y="3.4" width="7.5" height="1.6" rx=".8"/><rect x="7" y="10.9" width="7.5" height="1.6" rx=".8"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="2.5" width="13" height="1.6" rx=".8"/><rect x="1.5" y="7.2" width="13" height="1.6" rx=".8"/><rect x="1.5" y="11.9" width="13" height="1.6" rx=".8"/></svg>',
};
const libraryView = () => (['covers', 'rows', 'list'].includes(setup.settings.libraryView) ? setup.settings.libraryView : 'covers');

function viewSwitch() {
  const names = { covers: t('Covers'), rows: t('List with covers'), list: t('Compact list') };
  return h('div', { class: 'viewsw', role: 'group', title: t('View') }, ['covers', 'rows', 'list'].map((v) => {
    const b = h('button', { type: 'button', class: `iconbtn${libraryView() === v ? ' on' : ''}`, title: names[v], 'aria-label': names[v], onclick: async () => {
      setup = await call('saveSettings', { libraryView: v });
      renderGrid();
    } });
    b.innerHTML = VIEW_ICONS[v]; // fixed icons from above, no outside text
    return b;
  }));
}

const LIST_COLUMNS = () => [
  ['title', t('Title')], ['status', t('Reading status')], ['vote', t('Your rating')],
  ['started', t('Started')], ['finished', t('Finished')], ['playtime', t('Time played')],
];

function listHeader(mode) {
  return h('div', { class: `lhead ${mode}` }, mode === 'rows' ? h('span') : null, LIST_COLUMNS().map(([k, label]) => {
    const on = currentSort() === k;
    return h('button', { type: 'button', class: `lcol c-${k}${on ? ' on' : ''}`, onclick: () => setSort(k) }, label, on ? ' ▾' : '');
  }));
}

/** One game as a line: title, statuses, your rating, dates, time played (with a small cover in "rows"). */
function rowFor(g, mode) {
  const sts = statusesOf(g).filter((x) => STATUS_TEXT()[x]);
  const b = badgeFor(g);
  return h('div', { class: `lrow ${mode}${g.installed ? '' : ' uninstalled'}`, tabindex: '0', 'data-id': g.id, 'data-mode': mode,
    onclick: () => openDetail(g.id), onkeydown: (e) => { if (e.key === 'Enter') openDetail(g.id); } },
  mode === 'rows' ? h('div', { class: 'lthumb' }, g.coverUrl ? h('img', { src: g.coverUrl, alt: '', loading: 'lazy', draggable: 'false' }) : null) : null,
  h('div', { class: 'c-title' },
    h('div', { class: 'lt' }, shownTitle(g), b && !['synced', 'not-installed'].includes(b) ? h('span', { class: `lbadge ${b}` }, BADGE_TEXT()[b] || b) : null),
    mode === 'rows' && (otherTitle(g) || g.developer) ? h('div', { class: 'ls' }, [otherTitle(g), g.developer].filter(Boolean).join(' · ')) : null),
  h('div', { class: 'c-status' }, sts.map((x, i) => [i ? ', ' : null, h('span', { class: `sdot ${x}` }), STATUS_TEXT()[x]])),
  h('div', { class: 'c-vote' }, g.vote ? `★ ${g.vote % 10 ? (g.vote / 10).toFixed(1) : g.vote / 10}` : ''),
  h('div', { class: 'c-started' }, g.started || ''),
  h('div', { class: 'c-finished' }, g.finished || ''),
  h('div', { class: 'c-playtime' }, g.playMinutes ? hours(g.playMinutes) : ''));
}

function renderGrid() {
  const q = $('#search').value.trim().toLowerCase();
  let list = games.filter((g) => matchesSearch(g, q));
  if (filter.category) list = list.filter((g) => (g.categories || []).includes(filter.category));
  if (filter.tag) list = list.filter((g) => g.vndb && (g.vndb.tags || []).some((x) => x.id === filter.tag.id));
  if (filter.status) list = list.filter((g) => statusesOf(g).includes(filter.status));
  const sortKey = currentSort();
  list = sortGames(list, sortKey);

  const sortSel = h('select', { class: 'sortsel', title: t('Sort by') },
    SORTS().map(([k, label]) => h('option', { value: k, selected: sortKey === k }, label)));
  sortSel.addEventListener('change', () => setSort(sortSel.value));
  const chips = [];
  if (filter.category) chips.push(h('span', { class: 'chip on' }, `${t('Category')}: ${filter.category}`, h('button', { class: 'x', title: t('Clear'), onclick: () => showLibrary({ category: null }) }, '×')));
  if (filter.tag) chips.push(h('span', { class: 'chip on' }, `${t('Tag')}: ${filter.tag.name}`, h('button', { class: 'x', title: t('Clear'), onclick: () => showLibrary({ tag: null }) }, '×')));
  if (filter.status) chips.push(h('span', { class: 'chip on' }, `${t('Reading status')}: ${STATUS_TEXT()[filter.status]}`, h('button', { class: 'x', title: t('Clear'), onclick: () => showLibrary({ status: null }) }, '×')));
  const heading = filter.category || (filter.tag ? filter.tag.name : filter.status ? STATUS_TEXT()[filter.status] : t('All games'));
  const extra = filter.category ? h('button', { class: 'ghost small iconbtn', title: t('Rename or delete…'), onclick: () => manageCategory(filter.category) }, '✎') : null;
  const listToggle = listOnlyApplies() ? h('label', { class: 'check small' },
    h('input', { type: 'checkbox', checked: setup.settings.showListOnly !== false, onchange: async (e) => {
      setup = await call('saveSettings', { showListOnly: e.target.checked });
      renderGrid();
    } }), t('Show Not in Library')) : null;
  replaceKids($('#libToolbar'),
    h('h1', {}, heading), h('span', { class: 'dim' }, String(list.length)), extra, ...chips,
    h('div', { class: 'spacer' }), listToggle, h('span', { class: 'dim small' }, t('Sort by')), sortSel, viewSwitch());
  const mode = libraryView();
  $('#grid').className = mode === 'covers' ? 'grid' : `gamelist ${mode}`;
  const arranging = sortKey === 'custom';
  const one = (g) => { const el = mode === 'covers' ? cardFor(g) : rowFor(g, mode); return arranging ? arrangeDrag(el, g) : el; };
  $('#grid').classList.toggle('arranging', arranging);
  if (mode === 'covers') $('#grid').replaceChildren(...list.map(one));
  else $('#grid').replaceChildren(...(list.length ? [listHeader(mode)] : []), ...list.map(one));
  const below = listOnlyBelow(q);
  if (!$('#listOnly')) $('#noMatch').after(h('div', { id: 'listOnly' }));
  replaceKids($('#listOnly'), below);
  $('#empty').classList.toggle('hidden', games.length > 0);
  $('#noMatch').classList.toggle('hidden', !(games.length > 0 && list.length === 0) || !!below);
}

// ------------------------------------------------------------------ VNDB extras on the game page
// Screenshots (Japanese release first, else English, else none), related VNs, characters, staff and
// brands. Loaded after the page shows; the main process keeps them on this PC for a week.

const RELATION_TEXT = () => ({
  preq: t('Prequel'), seq: t('Sequel'), fan: t('Fandisc'), side: t('Side story'), par: t('Parent story'),
  ser: t('Same series'), set: t('Same setting'), alt: t('Alternative version'), char: t('Shares characters'), orig: t('Original game'),
});
const STAFF_ROLE_TEXT = () => ({
  director: t('Director'), scenario: t('Scenario'), chardesign: t('Character design'), art: t('Artist'), music: t('Composer'),
  songs: t('Vocals'), translator: t('Translator'), editor: t('Editor'), qa: t('Quality assurance'), staff: t('Staff'),
});
const MAIN_ROLES = ['director', 'scenario', 'chardesign', 'art', 'music', 'songs'];
const CHAR_ROLE_TEXT = () => ({ main: t('Protagonist'), primary: t('Main character'), side: t('Side character'), appears: t('Makes an appearance') });

const extrasCache = new Map(); // vndbId -> { extras, chars } for this session (redraws without waiting)

/**
 * VNDB extras for a game page: screenshots and staff go in the About box, related VNs and
 * characters in two columns below the panels. Loaded once per game and kept in extrasCache.
 */
function extrasParts(g) {
  const parts = {
    shots: h('div', { class: 'xshots' }),
    staff: h('div', { class: 'xstaff' }),
    bottom: h('div', { class: 'vnextras', 'data-vid': g.vndbId }),
  };
  const draw = (extras, chars) => {
    if (!parts.bottom.isConnected && parts.bottom.dataset.drawn) return;
    parts.bottom.dataset.drawn = '1';
    fillVndbEngine(document.querySelector('.hero .vndbengine'), extras);
    replaceKids(parts.shots, extras && extras.screenshots.length ? galleryEl(extras.screenshots) : null);
    replaceKids(parts.staff, extras && (extras.staff.length || extras.developers.length) ? staffEl(extras) : null);
    const related = extras && extras.relations.length ? h('div', { class: 'xcol' }, h('h2', {}, t('Related')),
      limitRows(vnGrid(extras.relations, { sub: (r) => `${RELATION_TEXT()[r.relation] || r.relation}${r.official ? '' : ` (${t('unofficial')})`}`, onAdded: () => redraw() }))) : null;
    const characters = chars && chars.length ? h('div', { class: 'xcol' }, h('h2', {}, t('Characters')), charactersEl(chars, () => redraw())) : null;
    replaceKids(parts.bottom,
      related || characters ? h('div', { class: 'xcols' }, characters || h('div', { class: 'xcol' }), related || h('div', { class: 'xcol' })) : null,
      extras === null ? h('div', { class: 'faint small' }, t('Couldn\'t load screenshots, characters and staff from VNDB.')) : null);
  };
  const redraw = () => { const c = extrasCache.get(g.vndbId); if (c) draw(c.extras, c.chars); };
  const cached = extrasCache.get(g.vndbId);
  if (cached) { draw(cached.extras, cached.chars); return parts; }
  replaceKids(parts.bottom, h('div', { class: 'faint small' }, t('Loading screenshots, characters and staff from VNDB…')));
  (async () => {
    const [extras, chars] = await Promise.all([vns.call('vndbExtras', g.id).catch(() => null), vns.call('vndbCharacters', g.id).catch(() => [])]);
    extrasCache.set(g.vndbId, { extras, chars });
    if (parts.bottom.isConnected) draw(extras, chars);
  })();
  return parts;
}

/** Show only the first rows of a card grid, with a button for the rest. Recounted when the width changes. */
function limitRows(grid, rows = 2) {
  let open = false;
  let width = -1;
  const btn = h('button', { type: 'button', class: 'ghost tiny morebtn', hidden: true });
  const apply = () => {
    const items = [...grid.children];
    for (const x of items) x.hidden = false;
    if (!grid.isConnected) return;
    const tops = [...new Set(items.map((x) => x.offsetTop))].sort((a, b) => a - b);
    const extra = tops.length > rows ? items.filter((x) => x.offsetTop >= tops[rows]) : [];
    if (!open) for (const x of extra) x.hidden = true;
    btn.hidden = !extra.length;
    btn.textContent = open ? t('Show less') : t('Show {n} more', { n: extra.length });
  };
  btn.addEventListener('click', () => { open = !open; apply(); });
  new ResizeObserver(() => { if (grid.clientWidth !== width) { width = grid.clientWidth; apply(); } }).observe(grid);
  return h('div', { class: 'limited' }, grid, btn);
}

/** Cap a block's height, with a button to show all of it when it's taller. */
function clipHeight(el, max, moreText) {
  let open = false;
  const wrap = h('div', { class: 'clipped', style: `max-height:${max}px` }, el);
  const btn = h('button', { type: 'button', class: 'ghost tiny morebtn', hidden: true });
  const apply = () => {
    const tall = el.scrollHeight > max + 8;
    wrap.style.maxHeight = open || !tall ? 'none' : `${max}px`;
    wrap.classList.toggle('cut', tall && !open);
    btn.hidden = !tall;
    btn.textContent = open ? t('Show less') : moreText;
  };
  btn.addEventListener('click', () => { open = !open; apply(); });
  new ResizeObserver(apply).observe(el);
  return h('div', {}, wrap, btn);
}

/** VNDB's engine in the game page header, shown when VN Shelf couldn't tell it from the game's files. */
function fillVndbEngine(el, extras) {
  if (!el || !extras || !(extras.engines || []).length) return el;
  el.textContent = t('Engine (VNDB): {engine}', { engine: extras.engines[0] });
  if (extras.engines.length > 1) el.title = extras.engines.join('\n');
  el.hidden = false;
  return el;
}

function galleryEl(shots) {
  return h('div', { class: 'shots' }, shots.map((sh, i) => h('button', { type: 'button', class: 'shot', title: t('View screenshot'), onclick: () => openLightbox(shots, i) },
    h('img', { src: sh.thumb, alt: '', loading: 'lazy', draggable: 'false' }))));
}

let lightboxKeys = null;
function openLightbox(shots, index) {
  closeLightbox();
  let i = index;
  const img = h('img', { alt: '' });
  const count = h('div', { class: 'lbcount' });
  const show = () => { img.src = shots[i].url; count.textContent = `${i + 1} / ${shots.length}`; };
  const move = (d) => { i = (i + d + shots.length) % shots.length; show(); };
  const box = h('div', { class: 'lightbox', onclick: (e) => { if (e.target === box) closeLightbox(); } },
    img, count,
    shots.length > 1 ? h('button', { type: 'button', class: 'lbnav prev', title: t('Previous'), onclick: () => move(-1) }, '‹') : null,
    shots.length > 1 ? h('button', { type: 'button', class: 'lbnav next', title: t('Next'), onclick: () => move(1) }, '›') : null,
    h('button', { type: 'button', class: 'lbclose', title: t('Close'), onclick: closeLightbox }, '×'));
  show();
  document.body.append(box);
  lightboxKeys = (e) => {
    // Keys belong to the viewer while it's open (Escape isn't also "Back").
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft' && !e.altKey) move(-1);
    else if (e.key === 'ArrowRight' && !e.altKey) move(1);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener('keydown', lightboxKeys, true);
}

function closeLightbox() {
  const box = document.querySelector('.lightbox');
  if (box) box.remove();
  if (lightboxKeys) document.removeEventListener('keydown', lightboxKeys, true);
  lightboxKeys = null;
}

/** Small cover cards for VNs from VNDB (related VNs, works): open the game if it's in the library, else + Add. */
function vnGrid(list, { sub, onAdded }) {
  return h('div', { class: 'minigrid' }, list.map((v) => {
    const mark = v.gameId ? h('span', { class: 'vmark lib' }, t('In your library'))
      : (v.listStatuses || []).length ? h('span', { class: 'vmark' }, v.listStatuses.map((x) => STATUS_TEXT()[x]).join(', '))
        : v.onList ? h('span', { class: 'vmark' }, t('On your VNDB list')) : null;
    const add = v.gameId ? null : h('button', { type: 'button', class: 'small', onclick: async (e) => {
      e.stopPropagation();
      add.disabled = true;
      try {
        const ng = await call('vndbAddFromList', v.vndbId);
        if (!ng) { add.disabled = false; return; }
        v.gameId = ng.id;
        toast(t('Added {title}.', { title: v.title }), 'good');
        games = await call('listGames');
        renderSidebar();
        if (onAdded) onAdded();
      } catch { add.disabled = false; }
    } }, t('+ Add'));
    return h('div', { class: 'card mini', title: v.gameId ? null : t('Open on VNDB'),
      onclick: () => (v.gameId ? openDetail(v.gameId) : vns.call('openExternal', `https://vndb.org/${v.vndbId}`)) },
    h('div', { class: 'art' }, v.image ? h('img', { src: v.image, alt: '', loading: 'lazy', draggable: 'false' }) : h('div', { class: 'placeholder' }, shownTitle(v))),
    h('div', { class: 'title' }, shownTitle(v)),
    h('div', { class: 'sub' }, [sub(v), (v.released || '').slice(0, 4)].filter(Boolean).join(' · ')),
    mark, add);
  }));
}

function charactersEl(chars, redraw) {
  const shown = chars.filter((c) => showSpoilers || !c.spoiler);
  const hidden = chars.length - shown.length;
  return h('div', {},
    limitRows(h('div', { class: 'chargrid' }, shown.map((c) => h('button', { type: 'button', class: `charcard${c.spoiler ? ' spoil' : ''}`, onclick: () => characterDialog(c) },
      c.image ? h('img', { src: c.image, alt: '', loading: 'lazy', draggable: 'false' }) : h('div', { class: 'noimg' }),
      h('div', { class: 'cname' }, c.original || c.name),
      c.original ? h('div', { class: 'csub' }, c.name) : null,
      h('div', { class: 'csub' }, CHAR_ROLE_TEXT()[c.role] || c.role))))),
    hidden ? h('button', { type: 'button', class: 'ghost tiny', onclick: () => { showSpoilers = true; redraw(); } }, t('Show {n} spoiler characters', { n: hidden })) : null,
    showSpoilers && chars.some((c) => c.spoiler) ? h('button', { type: 'button', class: 'ghost tiny', onclick: () => { showSpoilers = false; redraw(); } }, t('Hide spoiler characters')) : null);
}

function characterDialog(c) {
  let spoil = showSpoilers;
  const body = h('div', { class: 'chardlg' });
  const draw = () => {
    const bday = Array.isArray(c.birthday) ? c.birthday.filter(Boolean).join('/') : '';
    const facts = [
      [t('Role'), CHAR_ROLE_TEXT()[c.role] || c.role],
      c.sex ? [t('Sex'), { m: t('Male'), f: t('Female'), b: t('Both'), n: t('Sexless') }[c.sex] || c.sex] : null,
      c.age ? [t('Age'), String(c.age)] : null,
      bday ? [t('Birthday'), bday] : null,
      c.height ? [t('Height'), `${c.height} cm`] : null,
      c.bloodType ? [t('Blood type'), c.bloodType.toUpperCase()] : null,
    ].filter(Boolean);
    const groups = new Map();
    let hiddenTraits = 0;
    for (const tr of c.traits || []) {
      if (tr.spoiler && !spoil) { hiddenTraits++; continue; }
      if (!groups.has(tr.group)) groups.set(tr.group, []);
      groups.get(tr.group).push(tr);
    }
    replaceKids(body,
      c.image ? h('img', { class: 'charimg', src: c.image, alt: '' }) : null,
      h('div', { class: 'grow' },
        c.original ? h('div', { class: 'alt' }, c.name) : null,
        h('div', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', {}, v)))),
        c.descSegments && c.descSegments.length ? descriptionEl(c.descSegments) : null,
        [...groups].map(([grp, list]) => h('div', { class: 'traitrow' }, h('span', { class: 'k' }, grp || t('Traits')),
          h('span', {}, list.map((x, i) => [i ? ', ' : null, h('span', { class: x.spoiler ? 'spoiltrait' : null }, x.name)])))),
        hiddenTraits ? h('button', { type: 'button', class: 'ghost tiny', onclick: () => { spoil = true; draw(); } }, t('Show {n} spoiler traits', { n: hiddenTraits })) : null,
        h('div', { class: 'boxactions' }, h('button', { type: 'button', class: 'small', onclick: () => vns.call('openExternal', `https://vndb.org/${c.id}`) }, t('VNDB page')))));
  };
  draw();
  dialog({ title: c.original || c.name, body, wide: true, buttons: [{ label: t('Close'), value: true, cls: 'primary' }] });
}

function staffEl(extras) {
  const person = (p, roleNote) => h('button', { type: 'button', class: 'person', title: [p.original ? p.name : null, ...(p.notes || [])].filter(Boolean).join('\n') || null,
    onclick: () => showWorks(p.id, p.original || p.name) }, p.original || p.name, roleNote ? h('span', { class: 'faint' }, ` ${roleNote}`) : null);
  const byRole = (role) => extras.staff.filter((p) => p.roles.includes(role));
  const others = extras.staff.filter((p) => !p.roles.some((r) => MAIN_ROLES.includes(r)));
  return clipHeight(h('div', { class: 'staffbox' },
    extras.developers.length ? h('div', { class: 'staffrow' }, h('span', { class: 'k' }, t('Brand')),
      h('span', { class: 'people' }, extras.developers.map((d) => person(d)))) : null,
    MAIN_ROLES.filter((r) => byRole(r).length).map((r) => h('div', { class: 'staffrow' }, h('span', { class: 'k' }, STAFF_ROLE_TEXT()[r]),
      h('span', { class: 'people' }, byRole(r).map((p) => person(p))))),
    others.length ? h('div', { class: 'staffrow' }, h('span', { class: 'k' }, t('Other staff')),
      h('span', { class: 'people' }, others.map((p) => person(p, `(${p.roles.map((r) => STAFF_ROLE_TEXT()[r] || r).join(', ')})`)))) : null),
  150, t('Show all staff'));
}

// ---- a person's or brand's works

let worksSeq = 0;
function showWorks(who, name) {
  setView('works');
  $('#worksView').dataset.who = who;
  renderWorks(who, name);
  pushNav();
}

async function renderWorks(who, name) {
  const seq = ++worksSeq;
  replaceKids($('#worksView'), h('div', { class: 'libtoolbar' }, h('h1', {}, name || who)), h('div', { class: 'empty' }, h('p', {}, t('Loading from VNDB…'))));
  let r;
  try { r = await vns.call('vndbWorks', who); } catch (e) {
    if (seq === worksSeq) replaceKids($('#worksView'), h('div', { class: 'libtoolbar' }, h('h1', {}, name || who)), h('div', { class: 'empty' }, h('p', {}, cleanError(e))));
    return;
  }
  if (seq !== worksSeq || view !== 'works') return;
  const inLib = r.works.filter((w) => w.gameId).length;
  replaceKids($('#worksView'),
    h('div', { class: 'libtoolbar' },
      h('h1', {}, r.original || r.name), r.original ? h('span', { class: 'dim' }, r.name) : null,
      h('span', { class: 'dim' }, `${plural(r.works.length, '{n} VN', '{n} VNs')} · ${t('{n} in your library', { n: inLib })}`),
      h('div', { class: 'spacer' }),
      h('button', { class: 'small', onclick: () => vns.call('openExternal', `https://vndb.org/${r.id}`) }, t('VNDB page'))),
    h('div', { class: 'worksgrid' }, vnGrid(r.works, { sub: (w) => (w.roles || []).map((x) => STAFF_ROLE_TEXT()[x] || x).join(', '), onAdded: () => renderWorks(who, name) })));
}

// ------------------------------------------------------------------ archive (a VN server with an index)

let archiveData = null; // { items, generated }
let archiveJobs = [];
let archiveFilter = { q: '', show: '' };
let archiveSeq = 0;

function archiveNavCount() {
  const active = archiveJobs.find((j) => j.state === 'downloading');
  if (active && active.total) return h('span', { class: 'count' }, `↓ ${Math.floor((active.received / active.total) * 100)}%`);
  const n = archiveData ? archiveData.items.length : setup.archive && setup.archive.count;
  return n ? h('span', { class: 'count' }, n) : null;
}

function showArchive() {
  setView('archive');
  renderArchive();
  pushNav();
}

async function loadArchive({ fresh = false } = {}) {
  const r = await call('archiveItems', { fresh }).catch(() => null);
  if (r) archiveData = r;
  return archiveData;
}

/** VNDB ids in the archive → item, for the ↓ buttons on My List. */
function archiveFor(vid) {
  return setup.archive && setup.archive.connected && archiveData && vid ? archiveData.items.find((i) => i.vids.includes(vid)) : null;
}

const JOB_TEXT = () => ({
  queued: t('Waiting'), downloading: t('Downloading'), paused: t('Paused'), error: t('Stopped'), done: t('Downloaded'),
  unpacking: t('Unpacking'), installed: t('In library'), 'needs-install': t('Install it, then add it'),
  'needs-7zip': t('Needs 7-Zip'), 'install-error': t('Couldn\'t unpack'),
});

function jobFor(key) { return archiveJobs.find((j) => j.key === key); }

async function startArchiveDownload(it) {
  try {
    archiveJobs = await call('archiveDownload', it.key);
    toast(t('Downloading {title}', { title: it.title }), 'good');
    drawArchive();
    renderSidebar();
  } catch { /* toast shown */ }
}

function downloadsPanel() {
  if (!archiveJobs.length) return null;
  const act = (name, key) => async () => { archiveJobs = await call(name, key).catch(() => archiveJobs); drawArchive(); };
  const finished = archiveJobs.some((j) => ['done', 'installed'].includes(j.state));
  return h('div', { class: 'downloads' },
    h('div', { class: 'dlhead' }, h('h2', {}, t('Downloads')), h('div', { class: 'spacer' }),
      finished ? h('button', { class: 'small ghost', onclick: act('archiveClearFinished') }, t('Clear finished')) : null),
    archiveJobs.map((j) => {
      const pct = j.state === 'unpacking' ? (j.unpacked || 0) : j.total ? Math.floor((j.received / j.total) * 100) : 0;
      const busy = ['queued', 'downloading'].includes(j.state);
      return h('div', { class: `dlrow ${j.state}` },
        h('div', { class: 'dltitle' }, j.title, j.part ? h('span', { class: 'dim' }, ` ${j.part}`) : null),
        h('div', { class: 'dlstate small' }, JOB_TEXT()[j.state] || j.state,
          ['downloading', 'paused', 'queued'].includes(j.state) && j.total ? ` · ${sizeText(j.received)} / ${sizeText(j.total)}` : '',
          j.error ? h('span', { class: 'warn' }, ` · ${translateMessage(j.error)}`) : null),
        ['downloading', 'paused', 'unpacking', 'error'].includes(j.state) ? h('div', { class: 'syncbar' }, h('div', { style: `width:${pct}%` })) : null,
        h('div', { class: 'dlbtns' },
          busy ? h('button', { class: 'small', title: t('Pause'), onclick: act('archivePause', j.key) }, '❚❚') : null,
          ['paused', 'error', 'needs-7zip', 'install-error'].includes(j.state) ? h('button', { class: 'small', title: t('Resume'), onclick: act('archiveResume', j.key) }, '▶') : null,
          j.state === 'installed' && j.gameId ? h('button', { class: 'small primary', onclick: () => openDetail(j.gameId) }, t('Open')) : null,
          ['needs-install', 'done', 'install-error', 'needs-7zip'].includes(j.state) ? h('button', { class: 'small', onclick: () => vns.call('openPath', j.dest) }, t('Show folder')) : null,
          !['installed', 'done', 'needs-install'].includes(j.state) ? h('button', { class: 'small ghost', title: t('Cancel'), onclick: act('archiveCancel', j.key) }, '✕') : null));
    }));
}

function archiveCard(it) {
  const shown = { title: it.titleEn || it.title, titleAlt: it.title };
  const art = h('div', { class: 'art' },
    it.image ? h('img', { src: it.image, alt: '', loading: 'lazy', draggable: 'false' }) : h('div', { class: 'placeholder' }, shownTitle(shown)));
  const job = jobFor(it.key);
  if (it.gameId) art.append(h('span', { class: 'badge synced' }, t('In library')));
  else if (job) art.append(h('span', { class: 'badge pending' }, JOB_TEXT()[job.state] || job.state));
  else if (it.onList) art.append(h('span', { class: 'badge' }, t('On My List')));
  const dl = !it.gameId && (!job || ['installed', 'error'].includes(job.state)) ? h('button', { class: 'small primary', title: t('Download'), onclick: (ev) => { ev.stopPropagation(); startArchiveDownload(it); } }, `↓ ${sizeText(it.size)}`) : null;
  return h('div', { class: 'card listcard', onclick: () => (it.gameId ? openDetail(it.gameId) : archiveItemDialog(it)) },
    art,
    h('div', { class: 'title' }, shownTitle(shown)),
    h('div', { class: 'sub' }, [it.group, it.part, it.edition].filter(Boolean).join(' · ')),
    h('div', { class: 'listbtns' }, dl));
}

async function archiveItemDialog(it) {
  const links = [
    ...it.vids.map((v) => h('a', { href: '#', onclick: openLink(`https://vndb.org/${v}`) }, v)),
    it.igdb ? h('a', { href: '#', onclick: openLink(`https://www.igdb.com/games/${it.igdb}`) }, `IGDB ${it.igdb}`) : null,
  ].filter(Boolean);
  const v = await dialog({
    title: shownTitle({ title: it.titleEn || it.title, titleAlt: it.title }),
    text: otherTitle({ title: it.titleEn || it.title, titleAlt: it.title }) || '',
    body: h('div', { class: 'archinfo' },
      it.image ? h('img', { src: it.image, alt: '', class: 'archcover' }) : null,
      h('dl', {},
        h('dt', {}, t('Size')), h('dd', {}, `${sizeText(it.size)} · ${plural(it.fileCount, '{n} file', '{n} files')}`),
        it.edition ? [h('dt', {}, t('Edition')), h('dd', {}, it.edition)] : null,
        it.part ? [h('dt', {}, t('Part')), h('dd', {}, it.part)] : null,
        h('dt', {}, t('Folder')), h('dd', { class: 'wrap' }, it.key),
        links.length ? [h('dt', {}, t('Links')), h('dd', {}, links.flatMap((a, i) => (i ? [' · ', a] : [a])))] : null)),
    buttons: [{ label: t('Close'), value: null, cls: 'ghost' }, { label: `↓ ${t('Download')}`, value: 'go', cls: 'primary' }],
  });
  if (v === 'go') startArchiveDownload(it);
}

async function renderArchive({ fresh = false } = {}) {
  const seq = ++archiveSeq;
  archiveJobs = await call('archiveDownloads').catch(() => archiveJobs);
  if (!archiveData || fresh) {
    if (!archiveData) replaceKids($('#archiveView'), h('div', { class: 'empty' }, h('p', {}, t('Loading the archive…'))));
    await loadArchive({ fresh });
  }
  if (seq !== archiveSeq || view !== 'archive') return;
  drawArchive();
  renderSidebar();
}

function drawArchive() {
  if (view !== 'archive') return;
  const all = archiveData ? archiveData.items : [];
  const q = archiveFilter.q.trim().toLowerCase();
  const list = all.filter((it) => (!archiveFilter.show || (archiveFilter.show === 'list' ? it.onList : !it.gameId))
    && (!q || q.split(/\s+/).every((w) => [it.title, it.titleEn, it.group, it.developer, it.edition, ...it.vids].join(' ').toLowerCase().includes(w))));
  const search = h('input', { type: 'search', id: 'archiveSearch', placeholder: t('Search the archive'), value: archiveFilter.q });
  search.addEventListener('input', () => { archiveFilter.q = search.value; drawArchiveGrid(); });
  const show = h('select', { class: 'sortsel', id: 'archiveShow' },
    h('option', { value: '', selected: !archiveFilter.show }, t('All')),
    h('option', { value: 'missing', selected: archiveFilter.show === 'missing' }, t('Not in library')),
    setup.vndb && setup.vndb.connected ? h('option', { value: 'list', selected: archiveFilter.show === 'list' }, t('On My List')) : null);
  show.addEventListener('change', () => { archiveFilter.show = show.value; drawArchive(); });
  const had = document.activeElement && document.activeElement.id === 'archiveSearch';
  replaceKids($('#archiveView'),
    h('div', { class: 'libtoolbar' },
      h('h1', {}, t('Archive')), h('span', { class: 'dim', id: 'archiveCount' }, String(list.length)),
      h('div', { class: 'spacer' }), search, show,
      h('button', { class: 'small ghost', title: t('Refresh'), onclick: () => renderArchive({ fresh: true }) }, '⟳')),
    downloadsPanel(),
    h('div', { id: 'archiveGrid' }));
  if (had) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  drawArchiveGrid(list);
}

function drawArchiveGrid(pre) {
  const all = archiveData ? archiveData.items : [];
  const q = archiveFilter.q.trim().toLowerCase();
  const list = pre || all.filter((it) => (!archiveFilter.show || (archiveFilter.show === 'list' ? it.onList : !it.gameId))
    && (!q || q.split(/\s+/).every((w) => [it.title, it.titleEn, it.group, it.developer, it.edition, ...it.vids].join(' ').toLowerCase().includes(w))));
  if ($('#archiveCount')) $('#archiveCount').textContent = String(list.length);
  replaceKids($('#archiveGrid'), !archiveData ? h('div', { class: 'empty' }, h('p', {}, t('Couldn\'t load the archive.')))
    : list.length ? h('div', { class: 'grid' }, list.map(archiveCard)) : h('div', { class: 'empty' }, h('p', {}, t('Nothing matches.'))));
}

vns.on('archive-downloads', (list) => {
  const was = archiveJobs;
  archiveJobs = list;
  for (const j of list) {
    const before = was.find((x) => x.key === j.key);
    if (before && before.state !== j.state && j.state === 'installed') { toast(t('{title} is ready to play.', { title: j.title }), 'good'); loadGames().then(() => { if (view === 'archive') loadArchive().then(drawArchive); }); }
  }
  if (view === 'archive') {
    const panel = downloadsPanel();
    const old = $('#archiveView .downloads');
    if (old && panel) old.replaceWith(panel); else drawArchive();
  }
  renderSidebar();
});

// Signed out by the server (token revoked or refused): hide everything about the archive.
vns.on('archive-state', (st) => {
  setup.archive = st;
  if (st.connected) return;
  archiveData = null;
  archiveJobs = [];
  replaceKids($('#archiveView'));
  if (view === 'archive') showHome();
  else if (view === 'vndb') renderVndbList({ fresh: false });
  else if (view === 'library') renderGrid();
  renderSidebar();
});

/** Settings → Archive: connect with your login (only a token is kept), where downloads go, 7-Zip. */
function archivePane() {
  const el = h('div', {});
  const field = (label, ...kids) => h('div', { class: 'field' }, label ? h('div', { class: 'lbl' }, label) : null, ...kids);
  const draw = async () => {
    const st = await vns.call('archiveState').catch(() => ({ connected: false }));
    if (!st.connected) {
      const server = h('input', { type: 'text', id: 'archServer', placeholder: 'https://', value: st.server || '', spellcheck: 'false' });
      const user = h('input', { type: 'text', id: 'archUser', value: st.username || '', autocomplete: 'off', spellcheck: 'false' });
      const pass = h('input', { type: 'password', id: 'archPass', autocomplete: 'off' });
      const go = h('button', { type: 'button', class: 'small primary', onclick: async () => {
        go.disabled = true;
        try {
          await call('archiveConnect', { server: server.value, username: user.value, password: pass.value });
          setup.archive = { connected: true };
          archiveData = null;
          await loadArchive();
          renderSidebar();
          draw();
        } catch { go.disabled = false; }
      } }, t('Connect'));
      pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
      replaceKids(el,
        field(t('Server'), server),
        field(t('Username'), user),
        field(t('Password'), h('div', { class: 'val' }, pass, go)),
        h('div', { class: 'faint small' }, t('Only a token is kept, on this PC.')));
      return;
    }
    const dir = h('div', { class: 'grow wrap' }, st.downloadDir);
    replaceKids(el,
      field(t('Account'), h('div', { class: 'val wrap' }, h('div', { class: 'grow' }, h('strong', {}, st.username), h('span', { class: 'dim' }, ` · ${st.server}`)),
        h('button', { type: 'button', class: 'small ghost', onclick: async () => {
          await call('archiveDisconnect');
          setup.archive = { connected: false };
          archiveData = null;
          archiveJobs = [];
          replaceKids($('#archiveView'));
          if (view === 'archive') showHome();
          renderSidebar();
          draw();
        } }, t('Disconnect')))),
      field(t('Download to'), h('div', { class: 'val wrap' }, dir,
        h('button', { type: 'button', class: 'small', onclick: async () => {
          const d = await vns.call('pickFolder');
          if (d) { await call('archiveSettings', { downloadDir: d }); draw(); }
        } }, t('Change…')))),
      field('7-Zip', h('div', { class: 'val wrap' },
        h('div', { class: `grow${st.sevenZip ? '' : ' warn'}` }, st.sevenZip || t('Not found')),
        h('button', { type: 'button', class: 'small', onclick: async () => {
          const f = await vns.call('pickFile', t('Find 7z.exe'), [{ name: '7-Zip', extensions: ['exe', '*'] }]);
          if (f) { await call('archiveSettings', { sevenZip: f }); draw(); }
        } }, t('Choose…')),
        st.sevenZip ? null : h('button', { type: 'button', class: 'small ghost', onclick: () => vns.call('openExternal', 'https://www.7-zip.org/') }, '7-zip.org'))),
      field(null, h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: 'archKeep', checked: st.keepArchives, onchange: async (e) => { await call('archiveSettings', { keepArchives: e.target.checked }); } }),
        t('Keep archives after unpacking'))));
  };
  draw();
  return el;
}

// ------------------------------------------------------------------ your VNDB list

let vndbListFilter = '';
let vndbListSeq = 0;

function showVndbList() {
  setView('vndb');
  renderVndbList();
  pushNav();
}

/** VNs on the owner's VNDB list that aren't in the library, each with Add (and Link, for a game of the same name). */
// "Your VNDB list" as last worked out: shown at once (from memory, else the copy saved on this PC),
// then replaced by the current one.
let listOnlyView = null;
async function loadListOnly() {
  if (!listOnlyView) listOnlyView = await vns.call('vndbListOnly', { cached: true }).catch(() => null);
  return listOnlyView;
}
async function refreshListOnly() {
  const r = await vns.call('vndbListOnly').catch(() => null);
  if (!r) return false;
  const changed = JSON.stringify(r) !== JSON.stringify(listOnlyView && { ...listOnlyView, cached: undefined });
  listOnlyView = r;
  if (changed) renderSidebar(); // My List's count
  return changed;
}
/** Sync with VNDB in the background when it's been a while, so the list is current. */
function vndbSyncIfStale() {
  const v = setup.vndb;
  if (!v || !v.connected || v.syncing) return;
  if (v.lastSyncAt && Date.now() - Date.parse(v.lastSyncAt) < 2 * 60 * 1000) return;
  vns.call('vndbSyncNow').catch(() => {});
}

/** A card for a VN on the VNDB list that isn't in the library: + Add, or Link to a game with the same name. */
function listCard(e, after) {
  const art = h('div', { class: 'art' },
    e.image ? h('img', { src: e.image, alt: '', loading: 'lazy', draggable: 'false', class: e.imageSexual >= 1.5 ? 'nsfw' : null }) : h('div', { class: 'placeholder' }, shownTitle(e)));
  const add = h('button', { class: 'small primary', onclick: async (ev) => {
    ev.stopPropagation();
    add.disabled = true;
    try {
      if (!(await call('vndbAddFromList', e.vndbId))) { add.disabled = false; return; }
      toast(t('Added {title}.', { title: e.title }), 'good');
      games = await call('listGames');
      renderSidebar();
      after();
    } catch { add.disabled = false; }
  } }, t('+ Add'));
  const link = e.linkTo ? h('button', { class: 'small linkbtn', title: t('Link {game} in your library to this VNDB entry', { game: e.linkTo.title }), onclick: async (ev) => {
    ev.stopPropagation();
    try {
      await call('vndbLink', e.linkTo.id, e.vndbId);
      toast(t('Linked {game} to VNDB.', { game: e.linkTo.title }), 'good');
      games = await call('listGames');
      after();
    } catch { /* toast shown */ }
  } }, t('Link to “{game}”', { game: e.linkTo.title })) : null;
  const inArchive = archiveFor(e.vndbId);
  const fetchBtn = inArchive && !jobFor(inArchive.key) ? h('button', { class: 'small', title: t('Download from the archive'), onclick: (ev) => { ev.stopPropagation(); startArchiveDownload(inArchive); } }, `↓ ${sizeText(inArchive.size)}`) : null;
  return h('div', { class: 'card listcard', title: t('Open on VNDB'), onclick: () => vns.call('openExternal', `https://vndb.org/${e.vndbId}`) },
    art,
    h('div', { class: 'title' }, shownTitle(e)),
    h('div', { class: 'sub' }, (e.statuses || []).map((x, i) => [i ? ', ' : null, h('span', { class: `sdot ${x}` }), STATUS_TEXT()[x]]),
      e.vote ? `${(e.statuses || []).length ? ' · ' : ''}★ ${e.vote / 10}` : null),
    h('div', { class: 'listbtns' }, link, fetchBtn, add));
}

async function renderVndbList({ fresh = true } = {}) {
  const seq = ++vndbListSeq;
  const r = await loadListOnly();
  if (seq !== vndbListSeq || view !== 'vndb') return;
  drawVndbList(r || { entries: [], loading: true });
  if (!fresh) return;
  vndbSyncIfStale();
  if (await refreshListOnly() && seq === vndbListSeq && view === 'vndb') drawVndbList(listOnlyView);
}

function drawVndbList(r) {
  const all = r.entries || [];
  const list = vndbListFilter ? all.filter((e) => (e.statuses || []).includes(vndbListFilter)) : all;
  const statusSel = h('select', { class: 'sortsel', title: t('Reading status') },
    h('option', { value: '', selected: !vndbListFilter }, t('Every status')),
    STATUS_ORDER.filter((st) => all.some((e) => (e.statuses || []).includes(st))).map((st) => h('option', { value: st, selected: vndbListFilter === st }, STATUS_TEXT()[st])));
  statusSel.addEventListener('change', () => { vndbListFilter = statusSel.value; drawVndbList(r); });
  const syncing = setup.vndb && setup.vndb.syncing;
  replaceKids($('#vndbView'),
    h('div', { class: 'libtoolbar' },
      h('h1', {}, t('My List')),
      h('span', { class: 'dim' }, t('{n} not in library', { n: list.length })),
      h('div', { class: 'spacer' }),
      statusSel,
      h('button', { class: 'small', disabled: !!syncing, onclick: () => vndbSyncNow() }, syncing ? t('Syncing…') : t('Sync with VNDB now'))),
    list.length ? h('div', { class: 'grid' }, list.map((e) => listCard(e, () => renderVndbList())))
      : h('div', { class: 'empty' }, h('p', {}, r.loading || syncing ? t('Reading your VNDB list…') : t('Everything on your VNDB list is in your library.'))));
}

/**
 * Below a reading status or a category that's also a VNDB label: the VNs with that status or label
 * on the VNDB list that aren't in the library, on their own row. Can be turned off in Settings → VNDB.
 */
function listOnlyApplies() {
  const v = setup.vndb;
  return !!(v && v.connected && !filter.tag && (filter.status || (filter.category && vndbLabelled(filter.category))));
}

function listOnlyBelow(q) {
  if (!listOnlyApplies() || setup.settings.showListOnly === false) return null;
  if (!listOnlyView) {
    loadListOnly().then(async (r) => { if (!r) await refreshListOnly(); else refreshListOnly().then((c) => { if (c && view === 'library') renderGrid(); }); if (listOnlyView && view === 'library') renderGrid(); });
    return null;
  }
  const cat = filter.category && filter.category.toLowerCase();
  const list = (listOnlyView.entries || []).filter((e) => (!filter.status || (e.statuses || []).includes(filter.status))
    && (!cat || (e.categories || []).some((c) => c.toLowerCase() === cat))
    && (!q || q.split(/\s+/).every((w) => [e.title, e.titleAlt, e.developer].join(' ').toLowerCase().includes(w))));
  if (!list.length) return null;
  return h('div', { class: 'listonly' },
    h('div', { class: 'listonlyhead' },
      h('h2', {}, t('Not in Library')),
      h('span', { class: 'dim' }, String(list.length))),
    h('div', { class: 'grid' }, list.map((e) => listCard(e, async () => { await refreshListOnly(); renderGrid(); }))));
}

async function vndbSyncNow() {
  try {
    const r = await call('vndbSyncNow');
    if (!r) return;
    const bits = [];
    if (r.pulled) bits.push(plural(r.pulled, '{n} game updated from VNDB', '{n} games updated from VNDB'));
    if (r.pushed) bits.push(plural(r.pushed, '{n} change sent to VNDB', '{n} changes sent to VNDB'));
    toast(bits.length ? bits.join(' · ') : t('Your library and VNDB list already match.'), r.errors && r.errors.length ? 'bad' : 'good');
  } catch { /* toast shown */ }
}

/** Your rating and the started/finished dates on a game's page. They sync with VNDB when it's connected. */
function listBox(g) {
  const vote = h('select', { title: t('Your rating') }, h('option', { value: '', selected: !g.vote }, t('Not rated')));
  for (let n = 10; n >= 1; n--) vote.append(h('option', { value: String(n * 10), selected: g.vote === n * 10 }, String(n)));
  if (g.vote && g.vote % 10) vote.append(h('option', { value: String(g.vote), selected: true }, (g.vote / 10).toFixed(1)));
  const started = h('input', { type: 'date', value: g.started || '' });
  const finished = h('input', { type: 'date', value: g.finished || '' });
  const save = (patch) => call('updateGame', g.id, patch).then((ng) => { Object.assign(g, { vote: ng.vote, started: ng.started, finished: ng.finished }); }).catch(() => {});
  vote.addEventListener('change', () => save({ vote: vote.value ? Number(vote.value) : null }));
  started.addEventListener('change', () => save({ started: started.value }));
  finished.addEventListener('change', () => save({ finished: finished.value }));
  return h('div', { class: 'box' },
    h('div', { class: 'listfields' },
      h('label', { class: 'field' }, h('div', { class: 'lbl' }, t('Your rating')), vote),
      h('label', { class: 'field' }, h('div', { class: 'lbl' }, t('Started')), started),
      h('label', { class: 'field' }, h('div', { class: 'lbl' }, t('Finished')), finished)));
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
  const order = (setup.settings.categoryOrder || []).flatMap((c) => (c !== cat ? [c] : v === 'rename' ? [to] : []));
  const sortBy = { ...(setup.settings.sortBy || {}) };
  if (sortBy[`cat:${cat}`]) { if (v === 'rename') sortBy[`cat:${to}`] = sortBy[`cat:${cat}`]; delete sortBy[`cat:${cat}`]; }
  setup = await call('saveSettings', { categories: list, categoryOrder: order, sortBy });
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

async function playOrStop(id) {
  if (!(live[id] && live[id].state === 'running')) return play(id);
  const r = await vns.call('closeGame', id).catch(() => null);
  if (!r || !r.stillOpen) return;
  const g = games.find((x) => x.id === id) || {};
  const force = await dialog({ title: t('{title} is still open', { title: g.title || '' }),
    buttons: [{ label: t('Keep open'), value: false, cls: 'ghost' }, { label: t('Force close'), value: true, cls: 'primary danger' }] });
  if (force) vns.call('forceCloseGame', id);
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
    case 'game-running': {
      if ((await gameOpenDialog(id, opts)) === 'retry') return play(id, opts);
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

/**
 * The game is open (started some other way), so saves can't come down yet. Offer to wait for it to
 * close (then VN Shelf syncs by itself), or to try again. Returns 'retry', 'wait' or null.
 */
async function gameOpenDialog(id, opts = {}) {
  const g = games.find((x) => x.id === id) || {};
  const v = await dialog({
    title: t('The game is open'),
    text: t('{title} is running right now, so newer saves can\'t come down yet: the open game could write its older saves back over them. Close the game, then try again, or let VN Shelf wait and sync as soon as it closes.', { title: g.title || '' }),
    buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Try again'), value: 'retry' }, { label: t('Wait for it to close'), value: 'wait', cls: 'primary' }],
  });
  if (v === 'wait') await call('waitAndSync', id, { resolution: opts.resolution }).catch(() => {});
  return v;
}

async function syncNow(id, opts = {}) {
  let r;
  try { r = await call('syncNow', id, opts); } catch { return; }
  if (r.needs === 'conflict') {
    const v = await conflictDialog(r.info);
    if (v) return syncNow(id, { resolution: v });
  } else if (r.needs === 'game-running') {
    return gameOpenDialog(id, opts);
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

// ------------------------------------------------------------------ cover picker

/** Choose a cover: one of VNDB's (the VN's and every release's), or your own image cropped to fit. */
async function coverDialog(g) {
  const grid = h('div', { class: 'coverpick' }, g.vndbId ? h('div', { class: 'faint small' }, t('Loading from VNDB…')) : null);
  const body = h('div', {},
    grid,
    h('div', { class: 'boxactions' }, h('button', { type: 'button', class: 'primary', onclick: () => closeDialog('upload') }, t('Upload image…'))));
  if (g.vndbId) {
    vns.call('vndbCovers', g.id).then((list) => {
      replaceKids(grid, (list || []).map((c) => h('button', { type: 'button', class: 'coveropt', title: c.lang ? c.lang.toUpperCase() : null, onclick: () => closeDialog({ url: c.url }) },
        h('img', { src: c.thumb, alt: '', loading: 'lazy', draggable: 'false' }))));
      if (!(list || []).length) replaceKids(grid, h('div', { class: 'faint small' }, t('No covers on VNDB.')));
    }).catch(() => replaceKids(grid, h('div', { class: 'faint small' }, t('Couldn\'t load covers from VNDB.'))));
  }
  const pick = await dialog({ title: t('Cover'), body, wide: true, buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }] });
  if (!pick) return false;
  try {
    if (pick.url) { await call('setCoverFromUrl', g.id, pick.url); return true; }
    const src = await call('pickCoverImage');
    if (!src) return false;
    const cropped = await cropDialog(src);
    if (!cropped) return false;
    await call('setCoverData', g.id, cropped);
    return true;
  } catch { return false; }
}

/** Crop an image to the cover shape (5:7): drag to move, scroll or the slider to zoom. A JPEG data: URL or null. */
async function cropDialog(src) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; }).catch(() => null);
  if (!img) { toast(t('That image couldn\'t be opened.'), 'bad'); return null; }
  const W = 300, H = 420;
  const min = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  let scale = min, x = (W - img.naturalWidth * min) / 2, y = (H - img.naturalHeight * min) / 2;
  const pic = h('img', { src, alt: '', draggable: 'false' });
  const frame = h('div', { class: 'cropframe', style: `width:${W}px;height:${H}px` }, pic);
  const zoom = h('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1' });
  const clamp = () => {
    x = Math.min(0, Math.max(W - img.naturalWidth * scale, x));
    y = Math.min(0, Math.max(H - img.naturalHeight * scale, y));
    pic.style.width = `${img.naturalWidth * scale}px`;
    pic.style.transform = `translate(${x}px, ${y}px)`;
  };
  const zoomTo = (z, cx = W / 2, cy = H / 2) => {
    const next = min * Math.min(4, Math.max(1, z));
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    zoom.value = String(scale / min);
    clamp();
  };
  zoom.addEventListener('input', () => zoomTo(Number(zoom.value)));
  frame.addEventListener('wheel', (e) => { e.preventDefault(); const r = frame.getBoundingClientRect(); zoomTo(scale / min * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  frame.addEventListener('pointerdown', (e) => {
    frame.setPointerCapture(e.pointerId);
    const sx = e.clientX - x, sy = e.clientY - y;
    const move = (ev) => { x = ev.clientX - sx; y = ev.clientY - sy; clamp(); };
    const up = () => { frame.removeEventListener('pointermove', move); frame.removeEventListener('pointerup', up); };
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', up);
  });
  clamp();
  const render = () => {
    const out = document.createElement('canvas');
    out.width = 750; out.height = 1050;
    out.getContext('2d').drawImage(img, -x / scale, -y / scale, W / scale, H / scale, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.9);
  };
  return dialog({ title: t('Crop cover'), body: h('div', { class: 'cropwrap' }, frame, h('label', { class: 'cropzoom' }, t('Zoom'), zoom)),
    buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Use this'), value: render, cls: 'primary' }] });
}

// ------------------------------------------------------------------ add game

async function addGameFromExe(exe) {
  if (!setup.configured) { await settingsDialog(true); if (!setup.configured) return; }
  let g;
  try { g = await call('addGame', exe); } catch { return; }
  if (g && g.existing) {
    const choice = await dialog({ title: t('{title} is already in your library', { title: g.existing.title }),
      text: t('Added on your other PC.'),
      buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Add as a new game'), value: 'new', cls: 'ghost' }, { label: t('Set up on this PC'), value: 'here', cls: 'primary' }] });
    if (!choice) return;
    if (choice === 'here') {
      try { await call('setUpHere', g.existing.id, exe); } catch { return; }
      await loadGames();
      return openDetail(g.existing.id);
    }
    try { g = await call('addGame', exe, { asNew: true }); } catch { return; }
  }
  if ((await vndbDialog(g, true)) === 'blocked') {
    await vns.call('removeGame', g.id).catch(() => {});
    await loadGames();
    return;
  }
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
    if (!list.length) { results.replaceChildren(h('div', { class: 'faint' }, t('No matches. Try the Japanese title or a shorter name.')), igdbBtn()); return; }
    results.replaceChildren(...list.map((v) => vndbResult(v, () => { chosen = v; closeDialog('pick'); })), igdbBtn());
  };
  // Not on VNDB: IGDB, only on request.
  const igdbBtn = () => h('div', { class: 'boxactions' }, h('button', { type: 'button', class: 'small ghost', onclick: runIgdb }, t('Search IGDB instead')));
  const runIgdb = async () => {
    results.replaceChildren(h('div', { class: 'faint' }, t('Searching…')));
    let list = [];
    try { list = await vns.call('searchIgdb', input.value); } catch (e) {
      results.replaceChildren(h('div', { class: 'faint' }, t('IGDB search failed: {error}', { error: cleanError(e) })));
      return;
    }
    if (!list.length) { results.replaceChildren(h('div', { class: 'faint' }, t('No matches on IGDB either.'))); return; }
    results.replaceChildren(h('div', { class: 'faint small' }, 'IGDB'),
      ...list.map((v) => vndbResult(v, () => { chosen = { ...v, source: 'igdb' }; closeDialog('pick'); })));
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
    try { await call(chosen.source === 'igdb' ? 'applyIgdb' : 'applyVndb', g.id, chosen); } catch (e) {
      if (/Umineko/.test(String(e && e.message))) return 'blocked';
    }
  }
  return v;
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
    text: t('{saves} already have their save folder set. For the rest, just press Play: VN Shelf finds the save folder while you play.', { saves: withSaves }),
    body: failed.length ? h('div', { class: 'files' }, failed.map((f) => `${f.title}: ${translateMessage(f.error)}`).join('\n')) : null,
  });
  showLibrary({ category: null, tag: null });
}

// ------------------------------------------------------------------ settings / first run

async function storageChooser(current) {
  const wrap = h('div', { style: 'display:grid;gap:8px' }, h('div', { class: 'faint' }, t('Looking for cloud storage apps…')));
  let selected = current.backend === 'gdrive' ? { backend: 'gdrive' } : (current.cloudDir ? { cloudDir: current.cloudDir } : null);
  // Where saves will go, shown under the option it belongs to.
  const drivePreview = h('div', { class: 'faint small' });
  const preview = h('div', { class: 'faint mono' });
  const setPreview = () => {
    const drive = !!(selected && selected.backend === 'gdrive');
    drivePreview.textContent = drive ? t('Saves will be kept in a "VN Shelf" folder in your Google Drive{email}.', { email: setup.googleEmail ? ` (${setup.googleEmail})` : '' }) : '';
    drivePreview.classList.toggle('hidden', !drive);
    preview.textContent = selected && selected.cloudDir ? t('Saves will be kept in: {dir}', { dir: selected.cloudDir }) : '';
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
        ? t('Signed in as {email}.', { email: setup.googleEmail || t('your Google account') })
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
    parts.push(h('div', { class: 'faint' }, t('Sync directly with Google Drive:')), driveEl, drivePreview,
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
  if (!list.length) parts.splice(setup.driveAvailable ? 4 : 0, 0, h('div', { class: 'faint' }, t('No cloud storage apps found on this PC.')));
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

let settingsTab = 'general';
let vndbPaneDraw = null; // redraws the VNDB tab while Settings is open

/** Settings → VNDB: connect with a token, see when it last synced, sync now, disconnect. */
function vndbPane() {
  const el = h('div', {});
  const field = (label, ...kids) => h('div', { class: 'field' }, label ? h('div', { class: 'lbl' }, label) : null, ...kids);
  const draw = () => {
    const v = setup.vndb || { connected: false };
    if (!v.connected) {
      const token = h('input', { type: 'password', placeholder: t('Paste your VNDB token'), autocomplete: 'off', spellcheck: 'false' });
      const go = h('button', { type: 'button', class: 'small primary', onclick: async () => {
        go.disabled = true;
        try {
          setup = await call('vndbConnect', token.value);
          toast(t('Connected to VNDB as {name}.', { name: setup.vndb.username }), 'good');
          renderSidebar();
          draw();
        } catch { go.disabled = false; }
      } }, t('Connect'));
      token.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
      replaceKids(el,
        h('p', { class: 'dim' }, t('Keep your reading status, categories, rating and dates the same here and on your VNDB list. Changes on either side show up on the other.')),
        field(t('1. Make a token'), h('div', { class: 'faint small' }, t('On vndb.org, log in and open My Profile → Applications. Create a token with "Access to my list" and "Edit my list" ticked, and copy it.')),
          h('div', { class: 'val' }, h('button', { type: 'button', class: 'small', onclick: () => vns.call('openExternal', 'https://vndb.org/') }, t('Open vndb.org')))),
        field(t('2. Paste it here'), h('div', { class: 'val' }, token, go)),
        h('div', { class: 'faint small' }, t('The token is kept on this PC only, encrypted, and is never copied to your other PCs. Notes never sync.')));
      return;
    }
    const labels = v.labels || [];
    replaceKids(el,
      field(t('Account'), h('div', { class: 'val wrap' }, h('div', { class: 'grow' }, h('strong', {}, v.username), ` (${v.userId})`),
        h('button', { type: 'button', class: 'small', disabled: !!v.syncing, onclick: () => vndbSyncNow() }, v.syncing ? t('Syncing…') : t('Sync with VNDB now')),
        h('button', { type: 'button', class: 'small ghost', onclick: async () => {
          setup = await call('vndbDisconnect');
          listOnlyView = null;
          listOnlyAsked = false;
          if (view === 'vndb') showHome();
          renderSidebar();
          draw();
        } }, t('Disconnect'))),
      !v.canWrite ? h('div', { class: 'faint small warn' }, t('This token can only read your list, so changes made here aren\'t sent to VNDB. Make one with "Edit my list" ticked to sync both ways.')) : null),
      field(t('Last synced'), h('div', {}, v.syncing ? t('Syncing…') : v.lastSyncAt ? ago(v.lastSyncAt) : t('Not yet')),
        v.lastError ? h('div', { class: 'small warn' }, translateMessage(v.lastError)) : null,
        h('div', { class: 'faint small' }, t('VN Shelf syncs when it starts, every 15 minutes, and a few seconds after you change something.'))),
      field(t('What syncs'), h('ul', { class: 'small plainlist' },
        h('li', {}, t('Reading status ↔ Playing, Finished, Stalled, Dropped and Wishlist')),
        h('li', {}, t('Your rating and the started / finished dates')),
        h('li', {}, labels.length ? t('Categories named like one of your labels: {labels}', { labels: labels.join(', ') })
          : t('Categories named like one of your own VNDB labels (you have none yet; make them on vndb.org)')),
        h('li', {}, t('VNs on your list that aren\'t in your library are under "My List" in the sidebar.')))),
      field(null, h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: setup.settings.showListOnly !== false, onchange: async (e) => {
          setup = await call('saveSettings', { showListOnly: e.target.checked });
          if (view === 'library') renderGrid();
        } }),
        t('Show Not in Library'))),
      h('div', { class: 'faint small' }, t('When both sides changed the same thing, the newer change wins. Notes never sync.')));
  };
  draw();
  vndbPaneDraw = draw;
  return el;
}

/** Patch notes in Settings → About: this version's, with a link to show every version. */
function patchNotesBox() {
  const box = h('div', { class: 'notes-view hidden' });
  const show = async (all) => {
    const text = await vns.call('changelog', all ? { all: true } : {}).catch(() => null);
    replaceKids(box,
      text ? markdownEl(text) : h('div', { class: 'faint' }, t('No release notes.')),
      all ? null : h('button', { type: 'button', class: 'small ghost', onclick: () => show(true) }, t('Show every version')));
    box.classList.remove('hidden');
  };
  const btn = h('button', { type: 'button', class: 'small', onclick: () => {
    if (box.classList.contains('hidden')) show(false); else box.classList.add('hidden');
  } }, t('View patch notes'));
  return { btn, box };
}

async function settingsDialog(first = false) {
  const s = setup.settings;
  const name = h('input', { type: 'text', value: s.deviceName, placeholder: t('e.g. Desktop, Laptop') });
  const chooser = await storageChooser({ backend: setup.backend, cloudDir: s.cloudDir });
  const langSel = h('select', {},
    [['auto', t('Automatic (follow Windows)')], ['en', 'English'], ['ja', '日本語']].map(([v, l]) => h('option', { value: v, selected: s.language === v }, l)));
  const field = (label, ...kids) => h('div', { class: 'field' }, label ? h('div', { class: 'lbl' }, label) : null, ...kids);
  if (first) {
    const ok = await dialog({
      title: t('Welcome to VN Shelf'),
      text: t('Pick where your saves are kept. Use the same cloud service on each PC and they\'ll share saves automatically.'),
      body: [
        field(t('Language'), langSel),
        field(t('Name of this PC (shown on the other PC)'), name),
        field(t('Where to keep saves — choose the same cloud service on every PC'), chooser.el),
      ],
      buttons: [{ label: t('Start'), value: true, cls: 'primary', validate: () => {
        if (!chooser.get()) { toast(t('Choose where to keep saves.'), 'bad'); return false; }
        return true;
      } }],
    });
    if (!ok) return;
    setup = await call('saveSettings', { deviceName: name.value, ...chooser.get(), language: langSel.value });
    setLanguage(setup.settings.language);
    applyStaticText();
    await loadGames();
    return;
  }

  const depth = h('input', { type: 'number', min: '1', max: '100', value: String(s.historyDepth) });
  const liveBox = h('input', { type: 'checkbox', checked: s.liveMode });
  const upd = h('input', { type: 'checkbox', checked: s.autoUpdate !== false });
  const updInstall = h('select', { id: 'updInstall', title: t('Install updates') },
    h('option', { value: 'ask', selected: s.updateInstall !== 'auto' }, t('Ask first')),
    h('option', { value: 'auto', selected: s.updateInstall === 'auto' }, t('Install automatically')));
  const startBox = h('input', { type: 'checkbox', checked: !!s.startWithSystem });
  const closeSel = h('select', {},
    [['tray', t('Keep running in the tray')], ['quit', t('Quit VN Shelf')]].map(([v, l]) => h('option', { value: v, selected: (s.closeToTray !== false) === (v === 'tray') }, l)));
  const allowU = h('input', { type: 'checkbox', checked: !!s.allowUmineko });
  const statsBox = h('input', { type: 'checkbox', checked: s.showStats !== false });
  const look = { theme: s.theme, fonts: { ...(s.fonts || {}) } };
  const lePath = h('input', { type: 'text', value: s.localeEmulatorPath || '', placeholder: t('Path to LEProc.exe (optional)') });
  const lunaPath = h('input', { type: 'text', value: s.lunaPath || '', placeholder: t('Path to LunaTranslator.exe (optional)') });
  const tools = toolsEditor();
  const notes = patchNotesBox();

  const tabs = [
    ['general', t('General'), [
      field(t('Language'), langSel),
      field(t('Name of this PC (shown on the other PC)'), name),
      field(null, h('label', { class: 'check' }, startBox,
        setup.platform === 'win32' ? t('Start VN Shelf when Windows starts') : t('Start VN Shelf when you log in')),
      h('div', { class: 'faint small' }, t('It starts in the tray and keeps your saves in sync.'))),
      field(t('When you close the window'), closeSel),
      field(t('Your other PC'), h('div', { class: 'val wrap' },
        h('button', { type: 'button', class: 'small', onclick: () => { closeDialog(false); copySettingsDialog(); } }, t('Copy settings from another PC…'))),
      h('div', { class: 'faint small' }, t('Copies the theme, fonts, background and other preferences.'))),
    ]],
    ['saves', t('Saves & sync'), [
      field(t('Where to keep saves — choose the same cloud service on every PC'), chooser.el),
      setup.googleSignedIn ? field(t('Google account'),
        h('div', { class: 'val' }, h('div', { class: 'grow' }, setup.googleEmail || t('Signed in')),
          h('button', { type: 'button', class: 'small', onclick: async () => {
            setup = await call('googleSignOut');
            closeDialog(false);
            toast(t('Signed out of Google. VN Shelf no longer has access to your Drive.'), 'good');
            if (!setup.configured) await settingsDialog(true);
            await loadGames();
          } }, t('Sign out')))) : null,
      field(t('Older versions to keep per game'), depth),
      field(null, h('label', { class: 'check' }, liveBox, t('Upload saves while playing (about 10 seconds after each save)'))),
      h('div', { class: 'faint small' }, t('Switching where saves are kept doesn\'t move games already added; add them again on the new storage.')),
    ]],
    ['games', t('Games & tools'), [
      h('label', { class: 'check tinyopt' }, allowU, t('Allow adding Umineko no Naku Koro ni')),
      field(t('Locale Emulator (for games that need Japanese locale)'),
        h('div', { class: 'val' }, lePath, h('button', { type: 'button', onclick: async () => {
          const f = await vns.call('pickFile', t('Find LEProc.exe'), [{ name: 'LEProc', extensions: ['exe'] }]);
          if (f) lePath.value = f;
        } }, t('Browse…')))),
      field(t('LunaTranslator'),
        h('div', { class: 'val' }, lunaPath, h('button', { type: 'button', onclick: async () => {
          const f = await vns.call('pickFile', t('Find LunaTranslator.exe'), [{ name: 'LunaTranslator', extensions: ['exe'] }]);
          if (f) lunaPath.value = f;
        } }, t('Browse…')))),
      field(t('Companion tools on this PC (text hooker, meikipop, Magpie…). Pick which start with each game on its page.'), tools.el),
    ]],
    ['look', t('Look'), [
      field(t('Colours'), themeEditor(look)),
      field(t('Fonts'), fontsEditor(look)),
      field(t('Background (this PC)'), backgroundEditor()),
      field(null, h('label', { class: 'check' }, statsBox, t('Show play time and when you last played on covers'))),
    ]],
    ['vndb', 'VNDB', [vndbPane()]],
    ['archive', t('Archive'), [archivePane()]],
    ['about', t('Updates & about'), [
      field(null, h('div', { class: 'aboutline' }, h('strong', {}, 'VN Shelf'), ` ${t('Version {version}', { version: setup.version })}`)),
      field(null, h('div', { class: 'val wrap' }, notes.btn,
        h('button', { type: 'button', class: 'small', onclick: () => vns.call('openExternal', setup.repoUrl) }, t('GitHub page'))), notes.box),
      field(t('Updates'),
        h('div', { class: 'val wrap' }, h('label', { class: 'check' }, upd, t('Check for updates when VN Shelf starts')),
          h('button', { type: 'button', class: 'small', onclick: () => checkUpdatesNow() }, t('Check now')))),
      field(t('Install updates'), updInstall),
    ]],
  ];
  if (!tabs.some(([k]) => k === settingsTab)) settingsTab = 'general';
  const panes = {};
  const tabBtns = {};
  const select = (k) => {
    settingsTab = k;
    for (const [key] of tabs) {
      panes[key].classList.toggle('hidden', key !== k);
      tabBtns[key].classList.toggle('on', key === k);
    }
  };
  for (const [k, label, kids] of tabs) {
    panes[k] = h('div', { class: 'tabpane', 'data-tab': k }, kids);
    tabBtns[k] = h('button', { type: 'button', class: 'tab', 'data-tab': k, onclick: () => select(k) }, label);
  }
  select(settingsTab);

  const ok = await dialog({
    title: t('Settings'),
    body: [h('div', { class: 'tabs' }, tabs.map(([k]) => tabBtns[k])), ...tabs.map(([k]) => panes[k])],
    wide: true,
    cls: 'settingsdlg',
    buttons: [
      { label: t('Cancel'), value: false, cls: 'ghost' },
      { label: t('Save'), value: true, cls: 'primary', validate: () => {
        if (!chooser.get()) { select('saves'); toast(t('Choose where to keep saves.'), 'bad'); return false; }
        return true;
      } },
    ],
  });
  vndbPaneDraw = null;
  applyBackground(setup.settings.background);
  if (!ok) { applyLook(); return; } // undo previews
  setup = await call('saveSettings', {
    showStats: statsBox.checked, theme: look.theme || null, fonts: look.fonts,
    deviceName: name.value, ...chooser.get(), language: langSel.value,
    historyDepth: depth.value, liveMode: liveBox.checked, localeEmulatorPath: lePath.value.trim(), lunaPath: lunaPath.value.trim(), autoUpdate: upd.checked, updateInstall: updInstall.value, tools: tools.get(),
    startWithSystem: startBox.checked, closeToTray: closeSel.value === 'tray', allowUmineko: allowU.checked,
  });
  setLanguage(setup.settings.language);
  applyStaticText();
  applyLook();
  showUpdatePill(lastUpdate);
  await loadGames();
  if (view === 'detail' && currentId) renderDetail(currentId, { noAuto: true });
}

// ------------------------------------------------------------------ look: theme colours and fonts

// Each theme sets the main colours; the in-between shades are worked out from them.
const THEMES = {
  night: { bg: '#0f1115', raised: '#171a21', line: '#262b36', text: '#e6e8ee', dim: '#9aa1b2', accent: '#5b9cff', play: '#4cc38a', warn: '#f2b35b', danger: '#ef6b6b' },
  midnight: { bg: '#0b1020', raised: '#121a2e', line: '#24304d', text: '#e8ecf7', dim: '#9fabc7', accent: '#7aa2ff', play: '#5cd1a0', warn: '#f2c06b', danger: '#ff7a85' },
  sakura: { bg: '#161015', raised: '#211821', line: '#3a2a38', text: '#f3e8ee', dim: '#c3a9b8', accent: '#f28cb1', play: '#7fd6a4', warn: '#f5c26b', danger: '#ff7b7b' },
  matcha: { bg: '#0f1410', raised: '#161d17', line: '#2a362b', text: '#e7efe6', dim: '#a2b3a0', accent: '#8fcf7a', play: '#c8e06b', warn: '#f0c060', danger: '#f07a6a' },
  ink: { bg: '#121212', raised: '#1b1b1b', line: '#303030', text: '#ededed', dim: '#a8a8a8', accent: '#d8d8d8', play: '#4cc38a', warn: '#e9b45a', danger: '#ef6b6b' },
  paper: { bg: '#f4f1ea', raised: '#fffdf8', line: '#d9d2c3', text: '#1f1d1a', dim: '#5b564d', accent: '#2f6fd6', play: '#2e9d6a', warn: '#b7791f', danger: '#c53b3b' },
};
const THEME_NAMES = () => ({ night: t('Night'), midnight: t('Midnight'), sakura: t('Sakura'), matcha: t('Matcha'), ink: t('Ink'), paper: t('Paper (light)') });
const SWATCHES = () => [
  ['bg', t('Main area')], ['raised', t('Panels & boxes')], ['line', t('Borders')], ['text', t('Text')], ['dim', t('Secondary text')],
  ['accent', t('Accent')], ['play', t('Play button')], ['warn', t('Warnings')], ['danger', t('Errors & remove')],
];

const hexRgb = (hx) => [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16));
const rgbHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mixHex = (a, b, w) => { const x = hexRgb(a); const y = hexRgb(b); return rgbHex(x.map((v, i) => v * (1 - w) + y[i] * w)); };
function luminance(hx) {
  return hexRgb(hx).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
/** Black or white, whichever reads better on this colour. */
const onColor = (hx) => (contrast(hx, '#0b1220') >= contrast(hx, '#ffffff') ? '#0b1220' : '#ffffff');

function themeColors(theme) {
  const base = THEMES[(theme && theme.preset) || 'night'] || THEMES.night;
  return { ...base, ...((theme && theme.colors) || {}) };
}

function applyTheme(theme) {
  const c = themeColors(theme);
  const root = document.documentElement.style;
  const set = (k, v) => root.setProperty(k, v);
  set('--bg', c.bg); set('--bg-raised', c.raised); set('--line', c.line); set('--text', c.text); set('--text-dim', c.dim);
  set('--bg-hover', mixHex(c.raised, c.text, 0.06));
  set('--text-faint', mixHex(c.dim, c.bg, 0.35));
  set('--accent', c.accent); set('--accent-text', onColor(c.accent));
  set('--play', c.play); set('--play-text', onColor(c.play));
  set('--warn', c.warn); set('--danger', c.danger);
  root.colorScheme = luminance(c.bg) > 0.4 ? 'light' : 'dark';
}

/** Places where text may be hard to read with these colours (WCAG contrast below 4.5:1). */
function readabilityProblems(c) {
  const out = [];
  if (contrast(c.text, c.bg) < 4.5) out.push(t('text on the main area'));
  if (contrast(c.text, c.raised) < 4.5) out.push(t('text in panels'));
  if (contrast(c.dim, c.bg) < 3) out.push(t('secondary text'));
  if (contrast(onColor(c.accent), c.accent) < 4.5) out.push(t('accent buttons'));
  if (contrast(onColor(c.play), c.play) < 4.5) out.push(t('the Play button'));
  return out;
}

const BUILTIN_FONTS = ['Segoe UI', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'Meiryo UI', 'BIZ UDPGothic', 'BIZ UDGothic', 'MS PGothic',
  'Yu Mincho', 'BIZ UDPMincho', 'MS PMincho', 'Noto Sans JP', 'Noto Serif JP', 'M PLUS 1p', 'M PLUS Rounded 1c', 'Kosugi Maru',
  'Zen Maru Gothic', 'Hiragino Sans', 'Arial', 'Calibri', 'Verdana', 'Tahoma', 'Georgia', 'Noto Sans', 'Ubuntu', 'Cantarell', 'DejaVu Sans'];

/** Fonts from the list that are really installed (measured: a missing font falls back to the default). */
function installedFonts() {
  if (installedFonts.cache) return installedFonts.cache;
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli 漢字かなカナ';
  const width = (f) => { ctx.font = `20px ${f}`; return ctx.measureText(sample).width; };
  const bases = ['monospace', 'serif', 'sans-serif'].map((b) => [b, width(b)]);
  installedFonts.cache = BUILTIN_FONTS.filter((f) => bases.some(([b, w]) => width(`"${f}", ${b}`) !== w));
  return installedFonts.cache;
}

const loadedFonts = new Set();
/** Register added font files, then use the chosen fonts (the interface language's first). */
function applyFonts(fonts) {
  const f = fonts || {};
  for (const c of f.custom || []) {
    if (loadedFonts.has(c.url)) continue;
    loadedFonts.add(c.url);
    new FontFace(c.family, `url("${c.url}")`).load().then((face) => document.fonts.add(face)).catch(() => {});
  }
  const first = currentLanguage() === 'ja' ? [f.ja, f.en] : [f.en, f.ja];
  const chosen = first.filter(Boolean).map((n) => `"${n.replace(/"/g, '')}"`);
  const base = '"Segoe UI", system-ui, "Yu Gothic UI", "Meiryo", "Hiragino Sans", "Noto Sans CJK JP", sans-serif';
  document.documentElement.style.setProperty('--font', chosen.length ? `${chosen.join(', ')}, ${base}` : base);
}

/** Settings → Look: theme presets and colours, with a live preview and a readability check. */
function themeEditor(state) {
  const wrap = h('div', { class: 'bgedit' });
  const draw = () => {
    const colors = themeColors(state.theme);
    const preset = h('select', {}, Object.entries(THEME_NAMES()).map(([k, label]) => h('option', { value: k, selected: (state.theme ? state.theme.preset : 'night') === k }, label)));
    preset.addEventListener('change', () => { state.theme = { preset: preset.value, colors: {} }; applyTheme(state.theme); draw(); });
    const warn = h('div', { class: 'contrastwarn' });
    const check = () => {
      const bad = readabilityProblems(themeColors(state.theme));
      warn.textContent = bad.length ? t('Some text may be hard to read with these colours: {where}.', { where: bad.join(', ') }) : '';
    };
    const swatch = ([k, label]) => {
      const pick = h('input', { type: 'color', value: colors[k] });
      const code = h('input', { type: 'text', value: colors[k], maxlength: '7', title: t('Colour code, e.g. #3B3B3B') });
      const setColor = (v) => {
        if (!/^#[0-9a-f]{6}$/i.test(v)) return;
        state.theme = { preset: state.theme ? state.theme.preset : 'night', colors: { ...((state.theme && state.theme.colors) || {}), [k]: v.toLowerCase() } };
        pick.value = v; code.value = v;
        applyTheme(state.theme);
        check();
      };
      pick.addEventListener('input', () => setColor(pick.value));
      code.addEventListener('change', () => setColor(code.value.trim().startsWith('#') ? code.value.trim() : `#${code.value.trim()}`));
      return h('label', { class: 'swatch' }, pick, h('span', { class: 'grow' }, label), code);
    };
    replaceKids(wrap,
      h('div', { class: 'val wrap' }, h('span', { class: 'faint small' }, t('Theme')), preset,
        h('button', { type: 'button', class: 'small ghost', onclick: () => { state.theme = { preset: preset.value, colors: {} }; applyTheme(state.theme); draw(); } }, t('Reset colours'))),
      h('div', { class: 'swatches' }, SWATCHES().map(swatch)),
      warn);
    check();
  };
  draw();
  return wrap;
}

/** Settings → Look: interface fonts for English and Japanese, added font files, and a preview. */
function fontsEditor(state) {
  const wrap = h('div', { class: 'bgedit' });
  const draw = () => {
    const f = state.fonts;
    const options = (selected) => [
      h('option', { value: '', selected: !selected }, t('Default')),
      ...(f.custom || []).map((c) => h('option', { value: c.family, selected: selected === c.family }, `${c.family.replace(/^VNS /, '')} (${t('added')})`)),
      ...installedFonts().map((n) => h('option', { value: n, selected: selected === n }, n)),
    ];
    const en = h('select', {}, options(f.en));
    const ja = h('select', {}, options(f.ja));
    const preview = h('div', { class: 'fontpreview' }, 'The quick brown fox jumps over the lazy dog. 0123456789', h('br'), '吾輩は猫である。名前はまだ無い。 かなカナ');
    const update = () => {
      state.fonts = { ...state.fonts, en: en.value, ja: ja.value };
      applyFonts(state.fonts);
      const names = [en.value, ja.value].filter(Boolean).map((n) => `"${n}"`);
      preview.style.fontFamily = names.length ? `${names.join(', ')}, sans-serif` : '';
    };
    en.addEventListener('change', update);
    ja.addEventListener('change', update);
    replaceKids(wrap,
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('English font')), h('div', { class: 'fontrow' }, en),
        h('div', { class: 'faint small' }, t('Used when the interface is in English. Characters it doesn\'t have come from the Japanese font.'))),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Japanese font')), h('div', { class: 'fontrow' }, ja),
        h('div', { class: 'faint small' }, t('Used when the interface is in Japanese. Characters it doesn\'t have come from the English font.'))),
      preview,
      h('div', { class: 'val wrap' },
        h('button', { type: 'button', class: 'small', onclick: async () => {
          let r;
          try { r = await call('addFont'); } catch { return; }
          if (!r) return;
          setup = r.setup;
          state.fonts = { ...setup.settings.fonts, en: state.fonts.en, ja: state.fonts.ja };
          applyFonts(state.fonts);
          draw();
        } }, t('Add font file…')),
        ...(f.custom || []).map((c) => h('button', { type: 'button', class: 'small ghost danger', title: t('Remove'), onclick: async () => {
          setup = await call('removeFont', c.file);
          state.fonts = { ...setup.settings.fonts, en: state.fonts.en === c.family ? '' : state.fonts.en, ja: state.fonts.ja === c.family ? '' : state.fonts.ja };
          applyFonts(state.fonts);
          draw();
        } }, `× ${c.family.replace(/^VNS /, '')}`))));
    update();
  };
  draw();
  return wrap;
}

/** Copy another PC's look and preferences (theme, fonts, background, language…). */
async function copySettingsDialog() {
  let list;
  try { list = await call('otherDevices'); } catch { return; }
  if (!list.length) {
    await dialog({ title: t('Copy settings from another PC'), text: t('No other PC has shared its settings yet. Open VN Shelf on the other PC once (version 0.7 or newer) and let the shared storage finish syncing, then try again.') });
    return;
  }
  let chosen = list[0].deviceId;
  const rows = list.map((d, i) => {
    const el = h('div', { class: `choice${i === 0 ? ' sel' : ''}`, onclick: () => { for (const r of rows) r.classList.remove('sel'); el.classList.add('sel'); chosen = d.deviceId; } },
      h('div', { class: 'grow' }, h('div', {}, d.deviceName || t('Other PC')), h('div', { class: 'p' }, t('Last shared {when}', { when: when(d.sharedAt) }))));
    return el;
  });
  const ok = await dialog({
    title: t('Copy settings from another PC'),
    text: t('This replaces this PC\'s look and preferences (theme, fonts, background, language, sorting and similar) with the other PC\'s. Where saves are kept, this PC\'s name, its programs and tools stay as they are.'),
    body: rows,
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Copy settings'), value: true, cls: 'primary' }],
  });
  if (!ok) return;
  let r;
  try { r = await call('copySettingsFrom', chosen); } catch { return; }
  setup = r.setup;
  setLanguage(setup.settings.language);
  applyStaticText();
  applyLook();
  await loadGames();
  toast(t('Done: this PC now uses the settings from {name}.', { name: r.from || t('the other PC') }), 'good');
  if (r.missingFonts && r.missingFonts.length) toast(t('These fonts couldn\'t be copied, so this PC keeps its own: {fonts}', { fonts: r.missingFonts.join(', ') }), 'bad');
}

/** Theme, fonts and background from the current settings. */
function applyLook() {
  applyTheme(setup.settings.theme);
  applyFonts(setup.settings.fonts);
  applyBackground(setup.settings.background);
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
      h('div', { class: 'faint small' }, firstLine ? `${firstLine.replace(/\*\*/g, '').slice(0, 140)}` : t('Current version {current}', { current: setup.version }))),
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
  const notes = h('div', { class: 'notes-view' }, u.notes ? markdownEl(u.notes) : t('No release notes.'));
  const v = await dialog({
    title: t('VN Shelf {version} is available', { version: u.version }),
    text: t('Current version {current}', { current: setup.version }),
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
  detailNotes = null;
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
    'no-saves': { text: t('No save folder yet. Press Play: VN Shelf works out where it saves while you play (or set it below).'), cls: 'warn' },
    error: { text: t('Couldn\'t check saves.'), cls: 'bad' },
    running: { text: t('Playing'), cls: '' },
  };
  return map[b.badge] || { text: '', cls: '' };
}

function updateStatusLine() {
  if (currentId) updateLive(currentId);
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

function aboutBox(g, parts) {
  const v = g.vndb;
  const box = h('div', { class: 'box' });
  if (!g.vndbId && g.igdb) {
    box.append(
      g.igdb.summary ? h('div', { class: 'desc' }, g.igdb.summary) : null,
      h('div', { class: 'facts' }, [
        g.igdb.released ? [t('Released'), g.igdb.released] : null,
        (g.igdb.platforms || []).length ? [t('Platforms'), g.igdb.platforms.join(', ')] : null,
      ].filter(Boolean).map(([k, val]) => h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', {}, val)))),
      h('div', { class: 'boxactions' },
        g.igdb.url ? h('button', { class: 'small', onclick: () => vns.call('openExternal', g.igdb.url) }, t('IGDB page')) : null,
        h('button', { class: 'small ghost', onclick: async () => { await vndbDialog(g, false); renderDetail(g.id, { noAuto: true }); } }, t('Find on VNDB…'))));
    return box;
  }
  if (!g.vndbId) {
    box.append(h('div', { class: 'note' }, t('Link this game to VNDB to see its description, length, rating and tags.')),
      h('div', { class: 'boxactions' }, h('button', { onclick: async () => { await vndbDialog(g, false); renderDetail(g.id, { noAuto: true }); } }, t('Find on VNDB…'))));
    return box;
  }
  if (!v) {
    box.append(h('div', { class: 'note' }, t('VNDB info hasn\'t been downloaded for this game yet.')),
      h('div', { class: 'boxactions' }, h('button', { onclick: () => refreshVndb(g.id) }, t('Get info from VNDB'))),
      parts ? parts.shots : null, parts ? parts.staff : null);
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
    parts ? parts.shots : null,
    h('div', { class: 'facts' }, facts.map(([k, val]) => h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', {}, val)))),
    h('div', { class: 'tags' },
      tags.map((x) => h('button', { class: `tag tagbtn${x.spoiler ? ' spoil' : ''}`, title: t('Show games with this tag'), onclick: () => { $('#search').value = ''; showLibrary({ tag: { id: x.id, name: x.name }, category: null }); } }, x.name)),
      hidden ? h('button', { class: 'ghost tiny', onclick: () => { showSpoilers = true; renderDetail(g.id, { noAuto: true }); } }, t('Show {n} spoiler tags', { n: hidden })) : null,
      showSpoilers && (v.tags || []).some((x) => x.spoiler) ? h('button', { class: 'ghost tiny', onclick: () => { showSpoilers = false; renderDetail(g.id, { noAuto: true }); } }, t('Hide spoiler tags')) : null),
    parts ? parts.staff : null,
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
  return h('div', { class: 'box notesbox' }, h('div', { class: 'field' }, area, h('div', { class: 'faint small' }, t('Notes sync to your other PCs with the game.'), ' ', state)));
}

function vndbLabelled(c) {
  return !!(setup.vndb && setup.vndb.connected && (setup.vndb.labels || []).some((l) => l.toLowerCase() === String(c).toLowerCase()));
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
      all.map((c) => h('button', { class: `chip${mine.has(c) ? ' on' : ''}`, onclick: () => toggle(c), title: vndbLabelled(c) && g.vndbId ? t('Syncs with your VNDB label of the same name') : null },
        mine.has(c) ? `✓ ${c}` : c, vndbLabelled(c) && g.vndbId ? h('span', { class: 'vlabel' }, 'VNDB') : null)),
      h('button', { class: 'chip add', onclick: async () => {
        const input = h('input', { type: 'text', placeholder: t('Category name') });
        const name = await dialog({ title: t('New category'), body: input,
          buttons: [{ label: t('Cancel'), value: null, cls: 'ghost' }, { label: t('Add'), value: () => input.value.trim(), cls: 'primary', validate: () => !!input.value.trim() }] });
        if (name) { await call('updateGame', g.id, { categories: [...mine, name] }); await loadGamesKeepView(); }
      } }, t('+ New'))),
    all.length ? null : h('div', { class: 'faint small' }, t('Categories group games in the sidebar, like folders.'))));
  return box;
}

function toolsBox(g, list) {
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

let detailSeq = 0;
let detailNotes = null; // { id, el }: kept across repaints so typing in it isn't interrupted

/**
 * Show a game's page. It appears at once from what's already loaded (the library list), with save
 * folders, history and tools filled in as soon as they've been read; nothing from the previous game
 * is ever left on screen.
 */
async function renderDetail(id, opts = {}) {
  // Only the game you're looking at: a late redraw for a game you've left (after a VNDB/IGDB
  // match or a sync finishes) must not pull you back to it.
  if (currentId !== id || view !== 'detail') return;
  const seq = ++detailSeq;
  const view$ = $('#detailView');
  if (view$.dataset.id !== id) {
    const cached = games.find((x) => x.id === id);
    if (cached) paintDetail(cached, null, opts);
    else { view$.replaceChildren(); view$.dataset.id = id; }
  }
  let g;
  let saves;
  let history;
  let tools;
  try {
    [g, saves, history, tools] = await Promise.all([
      vns.call('getGame', id),
      vns.call('describeSaves', id).catch(() => []),
      vns.call('history', id).catch(() => []),
      vns.call('gameTools', id).catch(() => []),
    ]);
  } catch (e) { if (seq === detailSeq) { toast(cleanError(e), 'bad'); showHome(); } return; }
  if (seq !== detailSeq || currentId !== id || view !== 'detail') return;
  const idx = games.findIndex((x) => x.id === id);
  if (idx >= 0) games[idx] = g; else games.push(g);
  paintDetail(g, { saves, history, tools }, opts);
}

/** Build the game page. `data` is null while save folders, history and tools are still loading. */
function paintDetail(g, data, opts = {}) {
  const id = g.id;
  const loading = !data;
  const saves = data ? data.saves : [];
  const history = data ? data.history : [];

  const hero = h('div', { class: 'hero' },
    h('div', { class: 'bgimg', style: g.coverUrl ? `background-image:url("${g.coverUrl}")` : null }),
    h('div', { class: 'bgfade' }),
    h('div', { class: 'inner' },
      h('div', { class: 'cover' }, g.coverUrl ? h('img', { src: g.coverUrl, alt: '' }) : h('div', { class: 'placeholder' }, g.title)),
      h('div', { class: 'grow' },
        h('h1', {}, shownTitle(g)),
        otherTitle(g) ? h('div', { class: 'alt' }, otherTitle(g)) : null,
        h('div', { class: 'meta' },
          g.developer ? h('span', {}, g.developer) : null,
          g.engine ? h('span', {}, g.engine) : g.vndbId ? fillVndbEngine(h('span', { class: 'vndbengine', hidden: true }), (extrasCache.get(g.vndbId) || {}).extras) : null,
          g.playMinutes ? h('span', { title: (g.playByDevice || []).map((d) => `${d.name}: ${hours(d.seconds / 60)}`).join('\n') },
            (g.playByDevice || []).length > 1
              ? t('{h} played ({parts})', { h: hours(g.playMinutes), parts: g.playByDevice.map((d) => `${d.name} ${hours(d.seconds / 60)}`).join(' · ') })
              : t('{h} played', { h: hours(g.playMinutes) })) : null,
          g.lastPlayed ? h('span', {}, t('Last played {when}', { when: ago(g.lastPlayed) })) : null,
          (g.categories || []).map((c) => h('span', { class: 'tag' }, c))),
        h('div', { class: 'actions' },
          h('button', { id: 'playBtn', class: 'play playbtn', 'data-id': id, onclick: () => playOrStop(id) }, t('▶ Play')),
          h('button', { onclick: () => syncNow(id), disabled: loading || !g.installed || !saves.length }, t('Sync now')),
          statusSelect(g)),
        h('div', { id: 'statusline', class: 'statusline', 'data-id': id })),
      h('div', { class: 'herolist' }, listBox(g))));
  const loadingNote = () => h('div', { class: 'note' }, t('Loading…'));

  // ---- save locations
  const saveBox = h('div', { class: 'box' });
  if (loading) saveBox.append(loadingNote());
  else if (!saves.length) saveBox.append(h('div', { class: 'note' }, t('No save folder yet. Just press Play: when you close the game, VN Shelf shows where it saved and asks you to confirm. Auto-detect may also find it now.')));
  for (const s of saves) {
    const inc = s.include && s.include.length ? s.include.join(', ') : t('all files');
    saveBox.append(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'path' }, s.path, !s.portable ? h('span', { class: 'tag warn', style: 'margin-left:8px', title: t('This folder isn\'t under AppData, Documents or the game folder, so the other PC needs the exact same path.') }, t('this PC only')) : null),
        s.abs ? h('div', { class: 'abs', title: t('Open folder'), onclick: () => vns.call('openPath', s.abs) }, s.abs) : h('div', { class: 'abs' }, translateMessage(s.error) || ''),
        h('div', { class: 'faint', style: 'font-size:12px' }, t('Files: {which}', { which: inc }))),
      h('span', { class: `count${s.fileCount ? '' : ' zero'}`, title: s.skipped ? t('{n} file(s) skipped because they aren\'t saves (programs, video, archives, logs, huge files)', { n: s.skipped }) : null },
        s.registry ? (s.exists ? plural(s.fileCount, '{n} value', '{n} values') : t('not in the registry yet'))
          : s.exists ? `${s.size || plural(s.fileCount, '{n} file', '{n} files')}${s.skipped ? ` · ${t('{n} skipped', { n: s.skipped })}` : ''}` : t('folder not there yet')),
      s.registry ? null : h('button', { class: 'small ghost', onclick: () => editInclude(id, s) }, t('Files…')),
      h('button', { class: 'small ghost danger', onclick: async () => {
        const ok = await dialog({ title: t('Stop syncing this folder?'), text: t('{path} will no longer sync. Nothing is deleted.', { path: s.path }),
          buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Remove'), value: true, cls: 'primary' }] });
        if (ok) { await call('removeSaveRule', id, s.id); renderDetail(id); refreshStatus(id); }
      } }, t('Remove'))));
  }
  const suggestBox = h('div', { class: 'box suggest hidden', style: 'margin-top:12px' });
  saveBox.append(h('div', { class: 'boxactions' },
    h('button', { onclick: () => runSuggest(id, suggestBox), disabled: !g.installed }, t('Auto-detect')),
    h('button', { onclick: async () => { if (await chooseSaveFolder(id)) { renderDetail(id, { noAuto: true }); refreshStatus(id); } }, disabled: !g.installed }, t('Choose folder…')),
    h('button', { class: 'ghost', onclick: () => typePath(id) }, t('Type a path…'))));

  // ---- launch
  const args = h('input', { type: 'text', value: (g.launch && g.launch.args) || '', placeholder: t('Extra launch options (optional)') });
  args.addEventListener('change', () => call('updateGame', id, { launch: { args: args.value } }));
  const le = h('input', { type: 'checkbox', checked: !!(g.launch && g.launch.useLocaleEmulator), disabled: !setup.settings.localeEmulatorPath });
  const lunaBox = h('input', { type: 'checkbox', checked: !!(g.launch && g.launch.useLuna), disabled: !setup.settings.lunaPath });
  lunaBox.addEventListener('change', () => call('updateGame', id, { launch: { useLuna: lunaBox.checked } }));
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
    h('div', { class: 'field' }, h('label', { class: 'check' }, lunaBox, t('Start through LunaTranslator')),
      !setup.settings.lunaPath ? h('div', { class: 'faint', style: 'font-size:12px' }, t('Set LunaTranslator\'s location in Settings to use this.')) : null),
    h('div', { class: 'field' }, args));

  // ---- history
  const histBox = h('div', { class: 'box' });
  if (loading) histBox.append(loadingNote());
  else if (!history.length) histBox.append(h('div', { class: 'note' }, t('Older versions appear here after saves sync. The newest {n} are kept.', { n: setup.settings.historyDepth })));
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
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Title')), title,
      g.titleSource === 'window' ? h('div', { class: 'faint small' }, t('Taken from the game\'s window. Type your own to replace it.')) : null),
    h('div', { class: 'boxactions' },
      h('button', { onclick: async () => { await vndbDialog(g, false); renderDetail(id); } }, t('Find on VNDB…')),
      h('button', { onclick: async () => { if (await coverDialog(g)) renderDetail(id); } }, t('Change cover…')),
      h('div', { class: 'spacer' }),
      h('button', { class: 'ghost danger', onclick: async () => {
        const ok = await dialog({ title: t('Remove {title}?', { title: g.title }), text: t('It disappears from the library on every PC. The game itself and its save files on this PC aren\'t touched, and the shared copy is kept (moved aside in the shared folder, or to Drive\'s trash).'),
          buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Remove'), value: true, cls: 'primary' }] });
        if (ok) { await call('removeGame', id); await loadGames(); showHome(); }
      } }, t('Remove from library'))));

  const tools = loading ? h('div', { class: 'box' }, loadingNote()) : toolsBox(g, data.tools);
  if (!detailNotes || detailNotes.id !== id) detailNotes = { id, el: notesBox(g) };
  const main$ = $('main');
  const scroll = $('#detailView').dataset.id === id ? main$.scrollTop : 0;
  $('#detailView').dataset.id = id;
  const parts = g.vndbId ? extrasParts(g) : null;
  $('#detailView').replaceChildren(hero, h('div', { class: 'panels' },
    h('div', { class: 'panel' },
      h('h2', {}, t('About')), aboutBox(g, parts),
      h('h2', {}, t('Save locations')), h('div', { class: 'fill' }, saveBox, suggestBox)),
    h('div', { class: 'panel' },
      h('h2', {}, t('Categories')), categoryBox(g),
      h('h2', {}, t('Notes')), detailNotes.el,
      h('h2', {}, t('Launch')), launchBox,
      h('h2', {}, t('Start with this game')), tools,
      h('h2', {}, t('Save backup')), backupBox(g),
      h('h2', {}, t('History')), histBox,
      h('h2', {}, t('Details')), detailsBox)),
    parts ? parts.bottom : null);
  main$.scrollTop = scroll;
  updateLive(id);
  if (loading) return;
  if (!badges[id]) refreshStatus(id);
  if (opts.suggest || (!saves.length && g.installed && !opts.noAuto)) runSuggest(id, suggestBox);
}

/** Add a save location, handling "that can't be a save folder" and "that's unusually big". */
async function addRule(id, args) {
  let res;
  try { res = await call('addSaveRule', id, args); } catch { return null; }
  if (res.needsConfirm && res.shared) {
    const ok = await dialog({
      title: t('Another game already uses this'),
      text: t('"{title}" already syncs {path} on this PC. If two games sync the same saves, they can overwrite each other\'s. Use it anyway?', { title: res.shared, path: res.path }),
      buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Use it anyway'), value: true, cls: 'primary' }],
    });
    if (!ok) return null;
    return addRule(id, { ...args, confirmShared: true });
  }
  if (res.needsConfirm) {
    const ok = await dialog({
      title: t('That folder is unusually big'),
      text: t('{path} holds {size}. Save folders are normally much smaller. Only continue if you\'re sure this folder holds just the game\'s saves; otherwise pick a smaller folder or limit it to the save files.', { path: res.path, size: res.size }),
      buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Sync it anyway'), value: true, cls: 'primary' }],
    });
    if (!ok) return null;
    return addRule(id, { ...args, confirmLarge: true });
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
  const head = h('div', { class: 'note' }, r.engine ? `${r.engineFromVndb ? t('VNDB says this is a {engine} game.', { engine: r.engine }) : t('Looks like a {engine} game.', { engine: r.engine })} ` : '',
    list.length ? t('Suggestions (folders with files in them are most likely):') : t('No suggestions yet. Press Play and VN Shelf will find it while you play, or choose the folder yourself.'));
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
    text: t('Paste the full folder path, or use a placeholder: <game>, <appdata>, <localappdata>, <locallow>, <documents>, <savedgames>, <home>. %APPDATA% style also works. For a game that saves in the registry, paste its key: HKEY_CURRENT_USER\\Software\\<maker>\\<game>.'),
    body: [h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Folder')), p),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, t('Only these files (optional, comma-separated)')), inc)],
    buttons: [{ label: t('Cancel'), value: false, cls: 'ghost' }, { label: t('Add'), value: true, cls: 'primary', validate: () => !!p.value.trim() }],
  });
  if (!ok) return;
  let v = p.value.trim().replace(/^"|"$/g, '');
  if (/^(HKCU|HKEY_)/i.test(v)) {
    if (await addRule(id, { registryKey: v })) { renderDetail(id, { noAuto: true }); refreshStatus(id); }
    return;
  }
  const envMap = { '%appdata%': '<appdata>', '%localappdata%': '<localappdata>', '%userprofile%': '<home>' };
  v = v.replace(/^%[a-z]+%/i, (m) => envMap[m.toLowerCase()] || m);
  const isToken = /^<[a-z]+>/.test(v);
  if (!(await addRule(id, isToken ? { path: v.replace(/\\/g, '/').replace(/\/+$/, ''), include: inc.value.split(',') } : { absPath: v, include: inc.value.split(',') }))) return;
  renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

/**
 * The reading-status picker on a game's page. Like VNDB's labels, a game can have several: each one
 * is ticked or unticked on its own, and the others stay. Changes sync to every PC with the game.
 */
function statusSelect(g) {
  const btn = h('button', { type: 'button', class: 'statussel', title: t('Reading status'), 'aria-haspopup': 'true' });
  const paint = () => {
    const st = statusesOf(g);
    replaceKids(btn, st.length ? st.map((x, i) => [i ? ', ' : null, h('span', { class: `sdot ${x}` }), STATUS_TEXT()[x]]) : t('No status'), h('span', { class: 'caret' }, '▾'));
  };
  paint();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.querySelector('.statusmenu')) { closeStatusMenu(); return; }
    let changed = false;
    const menu = h('div', { class: 'statusmenu', role: 'menu' },
      STATUS_ORDER.map((x) => {
        const box = h('input', { type: 'checkbox', checked: statusesOf(g).includes(x) });
        box.addEventListener('change', async () => {
          const next = box.checked ? [...statusesOf(g), x] : statusesOf(g).filter((y) => y !== x);
          let ng;
          try { ng = await call('updateGame', g.id, { statuses: next }); } catch { box.checked = !box.checked; return; }
          changed = true;
          Object.assign(g, { statuses: ng.statuses, status: ng.status, started: ng.started, finished: ng.finished });
          const i = games.findIndex((y) => y.id === g.id);
          if (i >= 0) games[i] = { ...games[i], statuses: ng.statuses, status: ng.status };
          paint();
          renderSidebar();
        });
        return h('label', { class: 'check' }, box, h('span', { class: `sdot ${x}` }), STATUS_TEXT()[x]);
      }));
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    document.body.append(menu);
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    statusMenuClose = () => {
      menu.remove();
      statusMenuClose = null;
      // Ticking Reading or Finished can fill in a date: show it.
      if (changed && view === 'detail' && currentId === g.id) renderDetail(g.id, { noAuto: true });
    };
  });
  return btn;
}

let statusMenuClose = null;
function closeStatusMenu() { if (statusMenuClose) statusMenuClose(); }
document.addEventListener('click', closeStatusMenu);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !statusMenuClose) return;
  e.stopImmediatePropagation(); // Escape closes the menu only (it isn't also "Back")
  closeStatusMenu();
}, true);
window.addEventListener('blur', closeStatusMenu);

/** A game's statuses (several, like VNDB's labels), main one first. */
function statusesOf(g) {
  if (Array.isArray(g.statuses)) return g.statuses;
  return g.status ? [g.status] : [];
}

/** Pick a save folder by hand and add it. Returns true if one was added. */
async function chooseSaveFolder(id) {
  const g = games.find((x) => x.id === id) || {};
  const dir = await call('pickFolder', t('Choose the folder this game saves into'), g.installDir || undefined).catch(() => null);
  return !!(dir && (await addRule(id, { absPath: dir })));
}

/**
 * After a game closed (its first play without a save folder): what changed, and which
 * of it is where the game saves. After a first play, the first sync follows straight away.
 */
async function showSaveOnceResult({ id, candidates = [], registry = [], afterPlay = false }) {
  const g = games.find((x) => x.id === id) || {};
  const done = async (added) => {
    if (!added) return;
    if (afterPlay) await syncNow(id); // uploads, or asks which to keep if the other PC already has saves
    if (view === 'detail' && currentId === id) renderDetail(id, { noAuto: true });
    refreshStatus(id);
  };
  if (!candidates.length && !registry.length) {
    if (afterPlay) {
      const v = await dialog({
        title: t('Where does this game save?'),
        text: t('VN Shelf couldn\'t tell where {title} saves. If you didn\'t save while playing, it will look again next time you play. You can also choose the folder yourself.', { title: g.title || '' }),
        buttons: [{ label: t('Ask me next time'), value: null, cls: 'ghost' }, { label: t('Choose folder…'), value: 'pick', cls: 'primary' }],
      });
      if (v === 'pick') await done(await chooseSaveFolder(id));
    } else {
      await dialog({ title: t('No new files found'), text: t('Nothing changed while the game was open. Did it save? Some games only save when you return to the title screen. You can try again or choose the folder yourself.') });
    }
    return;
  }
  const picks = new Set(candidates.length ? [0] : []);
  const regPicks = new Set(candidates.length ? [] : [0]); // the registry is ticked only when no folder was found
  const choice = (checked, onChange, ...kids) => {
    const box = h('input', { type: 'checkbox', checked });
    box.addEventListener('change', () => onChange(box.checked));
    return h('label', { class: `choice${checked ? ' sel' : ''}`, onclick: (e) => { if (e.target === box) e.currentTarget.classList.toggle('sel', box.checked); } }, box, h('div', { class: 'grow' }, ...kids));
  };
  const rows = [
    ...candidates.map((c, i) => choice(picks.has(i), (on) => (on ? picks.add(i) : picks.delete(i)),
      h('div', { class: 'mono' }, c.path, c.include && c.include.length ? `  (${c.include.join(', ')})` : '', !c.portable ? `  — ${t('this PC only')}` : ''),
      h('div', { class: 'p' }, `${plural(c.fileCount, '{n} changed file', '{n} changed files')} · ${translateMessage(c.reason)}`),
      h('div', { class: 'files' }, c.files.slice(0, 8).join('\n')))),
    registry.length && candidates.length ? h('div', { class: 'faint small' }, t('This game also wrote to the registry. Tick it to sync that too.')) : null,
    ...registry.map((r, i) => choice(regPicks.has(i), (on) => (on ? regPicks.add(i) : regPicks.delete(i)),
      h('div', { class: 'mono' }, r.display),
      h('div', { class: 'p' }, `${t('Registry')} · ${plural(r.values, '{n} value', '{n} values')}`))),
  ];
  const v = await dialog({
    title: afterPlay ? t('Where does this game save?') : t('Files that changed while you played'),
    text: afterPlay
      ? t('While you played {title}, these places changed. Tick where it saves; the most likely one is ticked already.', { title: g.title || '' })
      : t('Tick the save folder. The most likely one is ticked already.'),
    body: rows, wide: true,
    buttons: [
      { label: afterPlay ? t('Ask me next time') : t('Cancel'), value: null, cls: 'ghost' },
      { label: t('Somewhere else…'), value: 'other', cls: 'ghost' },
      { label: t('Use selected'), value: 'use', cls: 'primary' },
    ],
  });
  if (v === 'other') { await done(await chooseSaveFolder(id)); return; }
  if (v !== 'use') return;
  let added = false;
  for (const i of picks) {
    const c = candidates[i];
    if (await addRule(id, { path: c.path, include: c.include })) added = true;
  }
  for (const i of regPicks) if (await addRule(id, { registryKey: registry[i].key })) added = true;
  await done(added);
}

// ------------------------------------------------------------------ search suggestions

/** What the search box could mean: games, tags, developers and categories that match the text. */
function suggestionsFor(q) {
  const has = (x) => String(x || '').toLowerCase().includes(q);
  const out = [];
  const titles = games.filter((g) => has(g.title) || has(g.titleAlt) || (g.vndb && (g.vndb.aliases || []).some(has)));
  for (const g of sortGames(titles, 'title').slice(0, 5)) {
    out.push({ kind: t('Game'), label: g.title, sub: g.titleAlt || g.developer || '', go: () => { $('#search').value = ''; openDetail(g.id); } });
  }
  const tags = new Map(); // id -> { name, n }
  for (const g of games) {
    for (const x of (g.vndb && g.vndb.tags) || []) {
      if ((x.spoiler && !showSpoilers) || !has(x.name)) continue;
      const e = tags.get(x.id) || { name: x.name, n: 0 };
      e.n++;
      tags.set(x.id, e);
    }
  }
  for (const [id, e] of [...tags].sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name)).slice(0, 5)) {
    out.push({ kind: t('Tag'), label: e.name, sub: plural(e.n, '{n} game', '{n} games'), go: () => { $('#search').value = ''; showLibrary({ tag: { id, name: e.name }, category: null }); } });
  }
  const devs = new Map();
  for (const g of games) if (g.developer && has(g.developer)) devs.set(g.developer, (devs.get(g.developer) || 0) + 1);
  for (const [name, n] of [...devs].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    out.push({ kind: t('Developer'), label: name, sub: plural(n, '{n} game', '{n} games'), go: () => { $('#search').value = name; showLibrary({ tag: null, category: null }); } });
  }
  for (const c of categoriesAll().filter(has).slice(0, 3)) {
    out.push({ kind: t('Category'), label: c, sub: '', go: () => { $('#search').value = ''; showLibrary({ category: c, tag: null }); } });
  }
  return out;
}

function showSuggestions() {
  const box = $('#suggest');
  const q = $('#search').value.trim().toLowerCase();
  const list = q ? suggestionsFor(q) : [];
  if (!list.length) { hideSuggestions(); return; }
  const pick = (it) => (e) => { e.preventDefault(); hideSuggestions(); it.go(); };
  replaceKids(box, list.map((it) => h('div', { class: 'sugitem', onmousedown: pick(it) },
    h('span', { class: 'kind' }, it.kind), h('span', { class: 'label' }, it.label), it.sub ? h('span', { class: 'sub' }, it.sub) : null)));
  box.classList.remove('hidden');
}

function hideSuggestions() { $('#suggest').classList.add('hidden'); }

// ------------------------------------------------------------------ sync progress

/** The progress to show for a game: only once a sync has run for a moment, so quick ones don't flicker. */
function progressShown(id) {
  const p = progress[id];
  if (!p || !p.total) return null;
  return Date.now() - p.startedAt >= 600 ? p : null;
}

function progressPct(p) {
  if (p.totalBytes) return Math.min(100, Math.round((p.bytes / p.totalBytes) * 100));
  return Math.min(100, Math.round((p.done / p.total) * 100));
}

function progressText(p) {
  const what = { upload: t('Uploading saves…'), backup: t('Backing up saves…'), download: t('Downloading saves…') }[p.phase] || t('Syncing…');
  const size = p.totalBytes ? t('{done} of {total}', { done: sizeText(p.bytes), total: sizeText(p.totalBytes) }) : (p.bytes ? sizeText(p.bytes) : '');
  return `${what} ${t('{done} / {total} files', { done: p.done, total: p.total })}${size ? ` · ${size}` : ''}`;
}

vns.on('sync-progress', (p) => {
  const prev = progress[p.id];
  if (prev) clearTimeout(prev.endTimer);
  const entry = { ...p, startedAt: prev ? prev.startedAt : Date.now() };
  progress[p.id] = entry;
  // Show the bar once the sync has taken long enough to be worth showing.
  if (!prev) setTimeout(() => { if (progress[p.id]) updateProgressUi(p.id); }, 650);
  // A finished step clears itself, unless another step (download after backup) follows at once.
  if (p.done >= p.total) {
    entry.endTimer = setTimeout(() => {
      if (progress[p.id] === entry) { delete progress[p.id]; updateProgressUi(p.id); }
    }, 500);
  }
  updateProgressUi(p.id);
});

function updateProgressUi(id) {
  const pr = progressShown(id);
  for (const card of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"] .art`)) {
    let bar = card.querySelector('.syncbar');
    if (pr && !bar) { bar = h('div', { class: 'syncbar' }, h('div', {})); card.append(bar); }
    if (bar && !pr) bar.remove();
    if (bar && pr) bar.firstChild.style.width = `${progressPct(pr)}%`;
  }
  updateLive(id);
}

/** Refresh every status line and Play button for a game (game page and Home). */
function updateLive(id) {
  const g = games.find((x) => x.id === id);
  if (!g) return;
  const isRunning = live[id] && live[id].state === 'running';
  const syncing = live[id] && live[id].state === 'syncing';
  const pr = progressShown(id);
  for (const el of document.querySelectorAll(`.statusline[data-id="${CSS.escape(id)}"]`)) {
    const st = statusText(g);
    el.className = `statusline ${pr ? '' : st.cls}`;
    replaceKids(el, pr ? progressText(pr) : st.text,
      pr ? h('div', { class: 'syncbar inline' }, h('div', { style: `width:${progressPct(pr)}%` })) : null);
  }
  for (const btn of document.querySelectorAll(`.playbtn[data-id="${CSS.escape(id)}"]`)) {
    btn.textContent = isRunning ? t('■ Stop') : syncing ? t('Syncing saves…') : t('▶ Play');
    btn.classList.toggle('stop', !!isRunning);
    btn.classList.toggle('busy', !!syncing);
    btn.disabled = !!syncing;
    btn.title = isRunning ? t('Use this if the game is closed but VN Shelf still thinks it\'s running') : '';
  }
}

// ------------------------------------------------------------------ events & boot

vns.on('game-state', async (s) => {
  live[s.id] = s;
  if (s.state !== 'syncing') delete progress[s.id];
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
vns.on('vndb-state', (st) => {
  const wasSyncing = setup.vndb && setup.vndb.syncing;
  setup.vndb = st;
  if (vndbPaneDraw && $('#dlg').open) vndbPaneDraw();
  if (view === 'vndb' && (!st.syncing || !wasSyncing)) renderVndbList({ fresh: !st.syncing });
  if (wasSyncing && !st.syncing && st.connected) refreshListOnly().then((changed) => { if (changed && view === 'library') renderGrid(); });
  renderSidebar();
});
// The other PC changed something (added a game, uploaded saves, edited a game): show it.
vns.on('library-changed', async ({ ids, added }) => {
  games = await vns.call('listGames').catch(() => games);
  if (view === 'library') renderGrid();
  else if (view === 'home') renderHome();
  else if (view === 'detail' && currentId && ids.includes(currentId) && !$('#dlg').open && !(document.activeElement && document.activeElement.closest('#detailView'))) {
    renderDetail(currentId, { noAuto: true });
  }
  renderSidebar();
  for (const id of added ? games.map((g) => g.id) : ids) refreshStatus(id);
});
vns.on('title-taken', ({ title }) => toast(t('Title updated to "{title}" from the game\'s window.', { title }), 'good'));
vns.on('auto-uploaded', (titles) => {
  toast(t('Uploaded newer saves for: {games}', { games: titles.join(', ') }), 'good');
  for (const g of games.filter((x) => titles.includes(x.title))) refreshStatus(g.id);
});
vns.on('update-available', (u) => showUpdatePopup(u));

// Typing redraws at most once per frame, however fast the keys come.
let searchFrame = 0;
$('#search').addEventListener('input', () => {
  if (searchFrame) return;
  searchFrame = requestAnimationFrame(() => {
    searchFrame = 0;
    if (view !== 'library') setView('library');
    renderGrid();
    showSuggestions();
  });
});
$('#search').addEventListener('focus', () => showSuggestions());
$('#search').addEventListener('blur', () => setTimeout(hideSuggestions, 120));
$('#search').addEventListener('keydown', (e) => {
  const box = $('#suggest');
  const items = [...box.querySelectorAll('.sugitem')];
  if (box.classList.contains('hidden') || !items.length) return;
  let i = items.findIndex((x) => x.classList.contains('on'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (i >= 0) items[i].classList.remove('on');
    i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[i].classList.add('on');
    items[i].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && i >= 0) {
    e.preventDefault();
    items[i].dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});
$('#brand').addEventListener('click', () => { hideSuggestions(); showHome(); });
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
const draggingFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (!draggingFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropHint').classList.remove('hidden'); });
window.addEventListener('dragleave', (e) => { if (!draggingFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
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
  applyLook();
  if (!setup.configured) await settingsDialog(true);
  // Paint the library saved last time straight away, then swap in the fresh one (Drive can take seconds).
  const cached = await vns.call('listGames', { cached: true }).catch(() => null);
  if (cached && cached.length) { games = cached; showHome(); }
  if (setup.update) showUpdatePopup(setup.update);
  if (setup.settings.justUpdated) toast(t('Updated to {version}', { version: setup.settings.justUpdated }), 'good');
  games = await call('listGames').catch(() => []);
  if (cached && cached.length) {
    if (view === 'home') renderHome();
    else if (view === 'library') renderGrid();
    else if (view === 'detail' && !games.some((g) => g.id === currentId)) showHome();
    renderSidebar();
  } else showHome();
  for (const g of games) refreshStatus(g.id);
  if (setup.archive && setup.archive.connected) {
    archiveJobs = await vns.call('archiveDownloads').catch(() => []);
    loadArchive().then(() => { renderSidebar(); if (view === 'vndb') renderVndbList({ fresh: false }); else if (view === 'library') renderGrid(); });
  }
})();
