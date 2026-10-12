'use strict';
/* global vns */

// ------------------------------------------------------------------ helpers

const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
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
  return String((e && e.message) || e).replace(/^Error invoking remote method 'api': (Error: )?/, '');
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
  const t = h('div', { class: `toast ${kind}` }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 4000);
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function joinPath(a, b) {
  const sep = setup && setup.platform === 'win32' ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b;
}

function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; }

// ------------------------------------------------------------------ dialog

/**
 * Show the shared dialog. `buttons`: [{ label, value, cls }]. Resolves with the clicked
 * value, or null on Escape. `onOpen(body)` can wire up the body.
 */
function dialog({ title, text, body, buttons = [{ label: 'OK', value: true, cls: 'primary' }], wide }) {
  const dlg = $('#dlg');
  const form = $('#dlgBody');
  form.replaceChildren();
  dlg.style.width = wide ? 'min(760px, calc(100vw - 32px))' : '';
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
let view = 'library';
let currentId = null;
const live = {};      // id -> { state, message }
const badges = {};    // id -> gameStatus result
let statusQueue = Promise.resolve();

const BADGE_TEXT = {
  synced: 'Synced', upload: 'To upload', download: 'Newer saves', conflict: 'Conflict', offline: 'Offline',
  'no-saves': 'No save folder', 'not-installed': 'Not on this PC', running: 'Playing', syncing: 'Syncing', error: 'Error',
};

function badgeFor(g) {
  const l = live[g.id];
  if (l && ['running', 'syncing', 'scanning'].includes(l.state)) return l.state === 'running' ? 'running' : 'syncing';
  if (!g.installed) return 'not-installed';
  const b = badges[g.id];
  return b ? b.badge : null;
}

function refreshStatus(id) {
  statusQueue = statusQueue.then(async () => {
    try {
      badges[id] = await vns.call('gameStatus', id);
    } catch { badges[id] = { badge: 'error' }; }
    updateCard(id);
    if (view === 'detail' && currentId === id) updateStatusLine();
  });
  return statusQueue;
}

// ------------------------------------------------------------------ library

async function loadGames() {
  games = await call('listGames');
  renderGrid();
  for (const g of games) refreshStatus(g.id);
}

function cardFor(g) {
  const art = h('div', { class: 'art' },
    g.coverUrl ? h('img', { src: g.coverUrl, alt: '', loading: 'lazy', draggable: 'false' }) : h('div', { class: 'placeholder' }, g.title));
  const b = badgeFor(g);
  if (b) art.append(h('span', { class: `badge ${b}` }, BADGE_TEXT[b] || b));
  if (g.installed && !(live[g.id] && live[g.id].state === 'running')) {
    art.append(h('button', { class: 'quickplay', onclick: (e) => { e.stopPropagation(); play(g.id); } }, '▶ Play'));
  }
  return h('div', { class: `card${g.installed ? '' : ' uninstalled'}`, tabindex: '0', 'data-id': g.id,
    onclick: () => openDetail(g.id), onkeydown: (e) => { if (e.key === 'Enter') openDetail(g.id); } },
  art,
  h('div', { class: 'title' }, g.title),
  h('div', { class: 'sub' }, g.lastPlayed ? `Played ${ago(g.lastPlayed)}` : (g.titleAlt || g.developer || '')));
}

function renderGrid() {
  const q = $('#search').value.trim().toLowerCase();
  const list = games.filter((g) => !q || [g.title, g.titleAlt, g.developer].join(' ').toLowerCase().includes(q));
  $('#grid').replaceChildren(...list.map(cardFor));
  $('#empty').classList.toggle('hidden', games.length > 0);
}

function updateCard(id) {
  const old = $(`.card[data-id="${CSS.escape(id)}"]`);
  const g = games.find((x) => x.id === id);
  if (old && g) old.replaceWith(cardFor(g));
}

function showLibrary() {
  view = 'library';
  currentId = null;
  $('#detailView').classList.add('hidden');
  $('#libraryView').classList.remove('hidden');
  $('#backBtn').classList.add('hidden');
  $('#search').classList.remove('hidden');
  loadGames();
}

// ------------------------------------------------------------------ play & sync flows

async function conflictDialog(info) {
  const c = info.cloud || {};
  const l = info.local || {};
  return dialog({
    title: 'Saves changed on both PCs',
    text: 'This PC and another PC both have new saves since they last synced. Pick which to keep. The other copy is kept in History, so nothing is lost.',
    body: h('div', { class: 'sides' },
      h('div', { class: 'side' }, h('h4', {}, `This PC (${l.deviceName || ''})`), h('div', { class: 's' }, `${l.files} file(s)`)),
      h('div', { class: 'side' }, h('h4', {}, `${c.deviceName || 'Other PC'}`),
        h('div', { class: 's' }, `${c.files} file(s), uploaded ${when(c.pushedAt)}`))),
    buttons: [
      { label: 'Cancel', value: null, cls: 'ghost' },
      { label: `Use ${c.deviceName || 'other PC'}'s`, value: 'cloud' },
      { label: 'Keep this PC\'s', value: 'local', cls: 'primary' },
    ],
  });
}

async function play(id, opts = {}) {
  let r;
  try { r = await call('play', id, opts); } catch { return; }
  if (r.started) return;
  const g = games.find((x) => x.id === id) || {};
  switch (r.needs) {
    case 'locate': {
      const ok = await dialog({
        title: 'Not set up on this PC yet',
        text: `Show VN Shelf where ${g.exe || 'the game\'s .exe'} is on this PC. Saves will come down from the shared folder before it starts.`,
        buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Find the .exe…', value: true, cls: 'primary' }],
      });
      if (ok && (await call('locateGame', id))) { await loadGamesKeepView(); return play(id, opts); }
      return;
    }
    case 'no-saves': {
      const v = await dialog({
        title: 'No save folder set',
        text: 'VN Shelf doesn\'t know where this game saves yet, so nothing will sync. Set it up on the game page (Auto-detect, Save once, or pick the folder).',
        buttons: [{ label: 'Play without syncing', value: 'play', cls: 'ghost' }, { label: 'Set up saves', value: 'setup', cls: 'primary' }],
      });
      if (v === 'play') return play(id, { ...opts, noSaves: true });
      if (v === 'setup') return openDetail(id);
      return;
    }
    case 'offline': {
      const v = await dialog({
        title: 'Shared folder not reachable',
        text: `${r.message || ''} Is your cloud app (Google Drive, OneDrive…) running? You can play anyway; saves upload once the folder is back.`,
        buttons: [{ label: 'Cancel', value: null, cls: 'ghost' }, { label: 'Retry', value: 'retry' }, { label: 'Play anyway', value: 'go', cls: 'primary' }],
      });
      if (v === 'retry') return play(id, opts);
      if (v === 'go') return play(id, { ...opts, offline: true });
      return;
    }
    case 'locked': {
      const v = await dialog({
        title: `Open on ${r.lock.deviceName}?`,
        text: `This game was started on ${r.lock.deviceName} at ${when(r.lock.since)} and hasn't finished syncing from there. If you've closed it there, give the cloud app a moment, then retry.`,
        buttons: [{ label: 'Cancel', value: null, cls: 'ghost' }, { label: 'Retry', value: 'retry' }, { label: 'Play anyway', value: 'go', cls: 'primary' }],
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
    case 'incomplete': {
      const v = await dialog({
        title: 'Still downloading',
        text: r.message,
        buttons: [{ label: 'Cancel', value: null, cls: 'ghost' }, { label: 'Retry', value: 'retry', cls: 'primary' }],
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
    toast(r.message || 'Couldn\'t sync right now.', 'bad');
  }
  refreshStatus(id);
  if (view === 'detail' && currentId === id) renderDetail(id);
}

async function loadGamesKeepView() {
  games = await call('listGames');
  if (view === 'library') renderGrid();
  else if (currentId) renderDetail(currentId);
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
  const exe = await call('pickFile', 'Choose the game\'s .exe', [{ name: 'Programs', extensions: ['exe', 'bat', 'lnk', 'sh', 'AppImage'] }, { name: 'All files', extensions: ['*'] }]);
  if (exe) await addGameFromExe(exe);
}

async function vndbDialog(g, isNew) {
  const input = h('input', { type: 'text', value: g.titleAlt || g.title, placeholder: 'Title, or a VNDB id like v1234' });
  const results = h('div', {}, h('div', { class: 'faint' }, 'Searching…'));
  let chosen = null;
  const run = async () => {
    results.replaceChildren(h('div', { class: 'faint' }, 'Searching…'));
    let list = [];
    try { list = await vns.call('searchVndb', input.value); } catch (e) {
      results.replaceChildren(h('div', { class: 'faint' }, `VNDB search failed: ${cleanError(e)}. You can skip this and add a cover yourself.`));
      return;
    }
    if (!list.length) { results.replaceChildren(h('div', { class: 'faint' }, 'No matches. Try the Japanese title or a shorter name.')); return; }
    results.replaceChildren(...list.map((v) => h('div', { class: 'vnres', onclick: () => { chosen = v; closeDialog('pick'); } },
      v.image ? h('img', { src: v.image, alt: '', style: v.imageSexual >= 1.5 ? 'filter: blur(6px)' : null }) : h('div', { class: 'noimg' }),
      h('div', {}, h('div', { class: 't' }, v.title), h('div', { class: 's' }, [v.titleAlt, v.developer, (v.released || '').slice(0, 4)].filter(Boolean).join(' · '))))));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  const p = dialog({
    title: isNew ? 'Which game is this?' : 'Find on VNDB',
    text: 'Pick the match to get its cover and title. Nothing else is sent anywhere.',
    body: [h('div', { class: 'val', style: 'display:flex;gap:8px' }, input, h('button', { type: 'button', onclick: run }, 'Search')), results],
    buttons: [{ label: isNew ? 'Skip' : 'Cancel', value: null, cls: 'ghost' }],
    wide: true,
  });
  run();
  const v = await p;
  if (v === 'pick' && chosen) {
    try { await call('applyVndb', g.id, chosen); } catch { /* toasted */ }
  }
}

// ------------------------------------------------------------------ settings / first run

async function storageChooser(current) {
  const wrap = h('div', { style: 'display:grid;gap:8px' }, h('div', { class: 'faint' }, 'Looking for cloud storage apps…'));
  let selected = current || null;
  const preview = h('div', { class: 'faint mono' });
  const setPreview = () => { preview.textContent = selected ? `Saves will be kept in: ${selected}` : ''; };
  const list = await vns.call('detectProviders').catch(() => []);
  const choices = [];
  const pick = (el, value) => {
    for (const c of choices) c.classList.remove('sel');
    if (el) el.classList.add('sel');
    selected = value;
    setPreview();
  };
  for (const p of list) {
    const target = joinPath(p.path, 'VNShelf');
    const el = h('div', { class: `choice${selected === target ? ' sel' : ''}`, onclick: () => pick(el, target) },
      h('div', { class: 'grow' }, h('div', {}, p.label), h('div', { class: 'p' }, p.path)));
    choices.push(el);
  }
  const other = h('div', { class: 'choice', onclick: async () => {
    const dir = await vns.call('pickFolder', 'Choose a synced folder (Google Drive, OneDrive, Dropbox, Syncthing, NAS…)');
    if (!dir) return;
    pick(other, baseName(dir).toLowerCase() === 'vnshelf' ? dir : joinPath(dir, 'VNShelf'));
  } }, h('div', { class: 'grow' }, h('div', {}, 'Another folder…'), h('div', { class: 'p' }, 'Any folder a cloud app or Syncthing keeps in sync, a NAS share, or a USB drive')));
  choices.push(other);
  if (current && !list.some((p) => joinPath(p.path, 'VNShelf') === current)) other.classList.add('sel');
  wrap.replaceChildren(
    list.length ? h('div', { class: 'faint' }, 'Found on this PC:') : h('div', { class: 'faint' }, 'No cloud storage apps found. Install Google Drive for desktop, OneDrive, Dropbox or similar, or choose any synced folder.'),
    ...choices, preview);
  setPreview();
  return { el: wrap, get: () => selected };
}

async function settingsDialog(first = false) {
  const s = setup.settings;
  const name = h('input', { type: 'text', value: s.deviceName, placeholder: 'e.g. Desktop, Laptop' });
  const chooser = await storageChooser(s.cloudDir);
  const depth = h('input', { type: 'number', min: '1', max: '100', value: String(s.historyDepth) });
  const liveBox = h('input', { type: 'checkbox', checked: s.liveMode });
  const lePath = h('input', { type: 'text', value: s.localeEmulatorPath || '', placeholder: 'Path to LEProc.exe (optional)' });
  const body = [
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Name of this PC (shown on the other PC)'), name),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Where to keep saves — choose the same cloud service on every PC'), chooser.el),
  ];
  if (!first) {
    body.push(
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Older versions to keep per game'), depth),
      h('div', { class: 'field' }, h('label', { class: 'check' }, liveBox, 'Upload saves while playing (about 10 seconds after each save)')),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Locale Emulator (for games that need Japanese locale)'),
        h('div', { class: 'val' }, lePath, h('button', { type: 'button', onclick: async () => {
          const f = await vns.call('pickFile', 'Find LEProc.exe', [{ name: 'LEProc', extensions: ['exe'] }]);
          if (f) lePath.value = f;
        } }, 'Browse…'))),
      h('div', { class: 'faint' }, `VN Shelf ${setup.version}`),
    );
  }
  const ok = await dialog({
    title: first ? 'Welcome to VN Shelf' : 'Settings',
    text: first ? 'Pick where your saves are kept. Use the same cloud service on each PC and they\'ll share saves automatically.' : null,
    body,
    buttons: [
      ...(first ? [] : [{ label: 'Cancel', value: false, cls: 'ghost' }]),
      { label: first ? 'Start' : 'Save', value: true, cls: 'primary', validate: () => {
        if (!chooser.get()) { toast('Choose where to keep saves.', 'bad'); return false; }
        return true;
      } },
    ],
  });
  if (!ok) return;
  const patch = { deviceName: name.value, cloudDir: chooser.get() };
  if (!first) Object.assign(patch, { historyDepth: depth.value, liveMode: liveBox.checked, localeEmulatorPath: lePath.value.trim() });
  setup = await call('saveSettings', patch);
  await loadGames();
}

// ------------------------------------------------------------------ detail

async function openDetail(id, opts = {}) {
  view = 'detail';
  currentId = id;
  $('#libraryView').classList.add('hidden');
  $('#detailView').classList.remove('hidden');
  $('#backBtn').classList.remove('hidden');
  $('#search').classList.add('hidden');
  $('main').scrollTop = 0;
  await renderDetail(id, opts);
}

function statusText(g) {
  const l = live[g.id];
  if (l && l.state === 'running') return { text: l.message || 'Playing', cls: '' };
  if (l && (l.state === 'syncing' || l.state === 'scanning')) return { text: l.message || 'Syncing…', cls: '' };
  if (l && l.state === 'error') return { text: l.message, cls: 'bad' };
  const b = badges[g.id];
  if (!g.installed) return { text: 'Not set up on this PC yet — press Play to find the game.', cls: 'warn' };
  if (!b) return { text: 'Checking saves…', cls: '' };
  const from = b.cloud ? ` Last upload: ${b.cloud.deviceName}, ${ago(b.cloud.pushedAt)}.` : '';
  const lock = b.lock ? ` Open on ${b.lock.deviceName} since ${when(b.lock.since)}.` : '';
  const map = {
    synced: { text: `Saves are in sync.${from}${lock}`, cls: '' },
    upload: { text: `This PC has newer saves; they'll upload next time you play or sync.${lock}`, cls: '' },
    download: { text: `Newer saves are waiting from ${b.cloud ? b.cloud.deviceName : 'another PC'}; they'll download when you press Play.${lock}`, cls: '' },
    conflict: { text: 'Saves changed here and on another PC. Press Sync now to choose.', cls: 'bad' },
    offline: { text: 'Shared folder not reachable right now.', cls: 'warn' },
    'no-saves': { text: 'No save folder set yet — add one below so saves can sync.', cls: 'warn' },
    error: { text: 'Couldn\'t check saves.', cls: 'bad' },
    running: { text: 'Playing', cls: '' },
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
    btn.textContent = isRunning ? 'Stop tracking' : '▶ Play';
    btn.classList.toggle('stop', !!isRunning);
    btn.title = isRunning ? 'Use this if the game is closed but VN Shelf still thinks it\'s running' : '';
  }
}

async function renderDetail(id, opts = {}) {
  let g;
  try { g = await vns.call('getGame', id); } catch (e) { toast(cleanError(e), 'bad'); showLibrary(); return; }
  const idx = games.findIndex((x) => x.id === id);
  if (idx >= 0) games[idx] = g; else games.push(g);
  const saves = await vns.call('describeSaves', id).catch(() => []);
  const history = await vns.call('history', id).catch(() => []);

  const hero = h('div', { class: 'hero' },
    h('div', { class: 'bgimg', style: g.coverUrl ? `background-image:url("${g.coverUrl}")` : null }),
    h('div', { class: 'bgfade' }),
    h('div', { class: 'inner' },
      h('div', { class: 'cover' }, g.coverUrl ? h('img', { src: g.coverUrl, alt: '' }) : h('div', { class: 'placeholder', style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:14px;text-align:center;color:var(--text-dim);font-weight:600' }, g.title)),
      h('div', { class: 'grow' },
        h('h1', {}, g.title),
        g.titleAlt ? h('div', { class: 'alt' }, g.titleAlt) : null,
        h('div', { class: 'meta' },
          g.developer ? h('span', {}, g.developer) : null,
          g.engine ? h('span', {}, g.engine) : null,
          g.playMinutes ? h('span', {}, `${Math.round(g.playMinutes / 6) / 10} h played here`) : null,
          g.lastPlayed ? h('span', {}, `Last played ${ago(g.lastPlayed)}`) : null),
        h('div', { class: 'actions' },
          h('button', { id: 'playBtn', class: 'play', onclick: () => {
            if (live[id] && live[id].state === 'running') vns.call('stopTracking', id);
            else play(id);
          } }, '▶ Play'),
          h('button', { onclick: () => syncNow(id), disabled: !g.installed || !saves.length }, 'Sync now')),
        h('div', { id: 'statusline', class: 'statusline' }))));

  // ---- save locations
  const saveBox = h('div', { class: 'box' });
  if (!saves.length) saveBox.append(h('div', { class: 'note' }, 'No save folder yet. Auto-detect usually finds it; if not, use Save once or pick the folder yourself.'));
  for (const s of saves) {
    const inc = s.include && s.include.length ? s.include.join(', ') : 'all files';
    saveBox.append(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'path' }, s.path, !s.portable ? h('span', { class: 'tag warn', style: 'margin-left:8px', title: 'This folder isn\'t under AppData, Documents or the game folder, so the other PC needs the exact same path.' }, 'this PC only') : null),
        s.abs ? h('div', { class: 'abs', title: 'Open folder', onclick: () => vns.call('openPath', s.abs) }, s.abs) : h('div', { class: 'abs' }, s.error || ''),
        h('div', { class: 'faint', style: 'font-size:12px' }, `Files: ${inc}`)),
      h('span', { class: `count${s.fileCount ? '' : ' zero'}` }, s.exists ? `${s.fileCount} file${s.fileCount === 1 ? '' : 's'}` : 'folder not there yet'),
      h('button', { class: 'small ghost', onclick: () => editInclude(id, s) }, 'Files…'),
      h('button', { class: 'small ghost danger', onclick: async () => {
        const ok = await dialog({ title: 'Stop syncing this folder?', text: `${s.path} will no longer sync. Nothing is deleted.`,
          buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Remove', value: true, cls: 'primary' }] });
        if (ok) { await call('removeSaveRule', id, s.id); renderDetail(id); refreshStatus(id); }
      } }, 'Remove')));
  }
  const suggestBox = h('div', { class: 'box suggest hidden', style: 'margin-top:12px' });
  saveBox.append(h('div', { class: 'boxactions' },
    h('button', { onclick: () => runSuggest(id, suggestBox), disabled: !g.installed }, 'Auto-detect'),
    h('button', { onclick: () => saveOnce(id), disabled: !g.installed }, 'Save once…'),
    h('button', { onclick: async () => { const r = await call('addSaveFolder', id); if (r) { afterAdd(r); renderDetail(id); refreshStatus(id); } }, disabled: !g.installed }, 'Choose folder…'),
    h('button', { class: 'ghost', onclick: () => typePath(id) }, 'Type a path…')));

  // ---- launch
  const args = h('input', { type: 'text', value: (g.launch && g.launch.args) || '', placeholder: 'Extra launch options (optional)' });
  args.addEventListener('change', () => call('updateGame', id, { launch: { args: args.value } }));
  const le = h('input', { type: 'checkbox', checked: !!(g.launch && g.launch.useLocaleEmulator), disabled: !setup.settings.localeEmulatorPath });
  le.addEventListener('change', () => call('updateGame', id, { launch: { useLocaleEmulator: le.checked } }));
  const launchBox = h('div', { class: 'box' },
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Program on this PC'),
      h('div', { class: 'val' }, h('div', { class: 'grow mono' }, g.exePath || 'Not set up on this PC'),
        h('button', { class: 'small', onclick: async () => { if (await call('locateGame', id)) { renderDetail(id); refreshStatus(id); } } }, g.exePath ? 'Change…' : 'Find…'))),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Game folder (stands for <game> in save paths)'),
      h('div', { class: 'val' }, h('div', { class: 'grow mono' }, g.installDir || '—'),
        h('button', { class: 'small', disabled: !g.installDir, onclick: async () => { if (await call('setGameFolder', id)) { renderDetail(id); refreshStatus(id); } } }, 'Change…'))),
    h('div', { class: 'field' }, h('label', { class: 'check' }, le, 'Start through Locale Emulator (Japanese locale)'),
      !setup.settings.localeEmulatorPath ? h('div', { class: 'faint', style: 'font-size:12px' }, 'Set Locale Emulator\'s location in Settings to use this.') : null),
    h('div', { class: 'field' }, args));

  // ---- history
  const histBox = h('div', { class: 'box' });
  if (!history.length) histBox.append(h('div', { class: 'note' }, 'Older versions appear here after saves sync. The newest ' + setup.settings.historyDepth + ' are kept.'));
  const KIND = { pushed: 'Uploaded', 'before-pull': 'Backup before download', 'before-restore': 'Backup before restore' };
  for (const v of history) {
    histBox.append(h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', {}, `${KIND[v.kind] || v.kind} · ${v.deviceName}`), h('div', { class: 'faint', style: 'font-size:12px' }, `${when(v.at)} · ${v.files} file${v.files === 1 ? '' : 's'}`)),
      h('button', { class: 'small', disabled: !g.installed, onclick: async () => {
        const ok = await dialog({ title: 'Restore this version?', text: `Your current saves on this PC are backed up first, then this version is put back and becomes the latest for every PC.`,
          buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Restore', value: true, cls: 'primary' }] });
        if (ok) { await call('restore', id, v.name); toast('Restored.', 'good'); renderDetail(id); refreshStatus(id); }
      } }, 'Restore')));
  }

  // ---- details
  const title = h('input', { type: 'text', value: g.title });
  title.addEventListener('change', async () => { await call('updateGame', id, { title: title.value.trim() || g.title }); renderDetail(id); });
  const detailsBox = h('div', { class: 'box' },
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Title'), title),
    h('div', { class: 'boxactions' },
      h('button', { onclick: async () => { await vndbDialog(g, false); renderDetail(id); } }, 'Find on VNDB…'),
      h('button', { onclick: async () => { if (await call('setCustomCover', id)) renderDetail(id); } }, 'Use my own cover…'),
      g.vndbId ? h('button', { class: 'ghost', onclick: () => vns.call('openExternal', `https://vndb.org/${g.vndbId}`) }, 'VNDB page') : null,
      h('div', { class: 'spacer' }),
      h('button', { class: 'ghost danger', onclick: async () => {
        const ok = await dialog({ title: `Remove ${g.title}?`, text: 'It disappears from the library on every PC. The game itself and its save files on this PC aren\'t touched, and the shared copy is moved to games/.removed in the shared folder.',
          buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Remove', value: true, cls: 'primary' }] });
        if (ok) { await call('removeGame', id); showLibrary(); }
      } }, 'Remove from library')));

  $('#detailView').replaceChildren(hero, h('div', { class: 'panels' },
    h('div', { class: 'panel' }, h('h2', {}, 'Save locations'), saveBox, suggestBox),
    h('div', { class: 'panel' }, h('h2', {}, 'Launch'), launchBox, h('h2', {}, 'History'), histBox, h('h2', {}, 'Details'), detailsBox)));
  updateStatusLine();
  if (!badges[id]) refreshStatus(id);
  if (opts.suggest || (!saves.length && g.installed && !opts.noAuto)) runSuggest(id, suggestBox);
}

function afterAdd(r) {
  if (r && r.portable === false) {
    toast('That folder is outside AppData, Documents and the game folder, so it only works if the other PC has the exact same path.', 'bad');
  } else toast('Save location added.', 'good');
}

async function runSuggest(id, box) {
  box.classList.remove('hidden');
  box.replaceChildren(h('div', { class: 'note' }, 'Looking for save folders…'));
  let r;
  try { r = await vns.call('suggestSaves', id); } catch (e) { box.replaceChildren(h('div', { class: 'note' }, cleanError(e))); return; }
  const g = games.find((x) => x.id === id) || {};
  const already = new Set((g.saves || []).map((s) => `${s.path}|${(s.include || []).join(',')}`));
  const list = r.candidates.filter((c) => !already.has(`${c.path}|${(c.include || []).join(',')}`));
  const head = h('div', { class: 'note' }, r.engine ? `Looks like a ${r.engine} game. ` : '',
    list.length ? 'Suggestions (folders with files in them are most likely):' : 'No suggestions. Try Save once, or choose the folder yourself.');
  box.replaceChildren(head, ...list.slice(0, 8).map((c) => h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'path' }, c.path, c.include && c.include.length ? `  (${c.include.join(', ')})` : ''),
      h('div', { class: 'faint', style: 'font-size:12px' }, c.reason)),
    h('span', { class: `count${c.fileCount ? '' : ' zero'}` }, c.exists ? `${c.fileCount} file${c.fileCount === 1 ? '' : 's'}` : 'not there yet'),
    h('button', { class: 'small primary', onclick: async () => {
      const res = await call('addSaveRule', id, { path: c.path, include: c.include });
      afterAdd(res);
      await renderDetail(id, { noAuto: true });
      refreshStatus(id);
    } }, 'Use'))),
  h('div', { class: 'boxactions' }, h('button', { class: 'small ghost', onclick: () => box.classList.add('hidden') }, 'Hide')));
}

async function editInclude(id, s) {
  const inc = h('input', { type: 'text', value: (s.include || []).join(', '), placeholder: 'All files' });
  const exc = h('input', { type: 'text', value: (s.exclude || []).join(', '), placeholder: 'Nothing' });
  const ok = await dialog({
    title: 'Which files to sync',
    text: 'Comma-separated patterns. * matches anything in a name, ** matches folders too. Example: Save*.rvdata2, *.sav',
    body: [h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Only these files'), inc),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Skip these files'), exc)],
    buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Save', value: true, cls: 'primary' }],
  });
  if (!ok) return;
  await call('updateSaveRule', id, s.id, { include: inc.value.split(','), exclude: exc.value.split(',') });
  renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

async function typePath(id) {
  const p = h('input', { type: 'text', placeholder: 'C:\\Users\\you\\AppData\\Roaming\\Studio\\Game  or  <appdata>/Studio/Game' });
  const inc = h('input', { type: 'text', placeholder: 'All files' });
  const ok = await dialog({
    title: 'Add a save location by path',
    text: 'Paste the full folder path, or use a placeholder: <game>, <appdata>, <localappdata>, <locallow>, <documents>, <savedgames>, <home>. %APPDATA% style also works.',
    body: [h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Folder'), p),
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Only these files (optional, comma-separated)'), inc)],
    buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Add', value: true, cls: 'primary', validate: () => !!p.value.trim() }],
  });
  if (!ok) return;
  let v = p.value.trim().replace(/^"|"$/g, '');
  const envMap = { '%appdata%': '<appdata>', '%localappdata%': '<localappdata>', '%userprofile%': '<home>' };
  v = v.replace(/^%[a-z]+%/i, (m) => envMap[m.toLowerCase()] || m);
  const isToken = /^<[a-z]+>/.test(v);
  const res = await call('addSaveRule', id, isToken ? { path: v.replace(/\\/g, '/').replace(/\/+$/, ''), include: inc.value.split(',') } : { absPath: v, include: inc.value.split(',') });
  afterAdd(res);
  renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

async function saveOnce(id) {
  const ok = await dialog({
    title: 'Find saves by saving once',
    text: 'VN Shelf starts the game and notes the time. Make one save (or start a new game and save), then close the game. VN Shelf then lists the files that changed: in the game folder, AppData, Documents and Saved Games.',
    buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Start the game', value: true, cls: 'primary' }],
  });
  if (!ok) return;
  const r = await call('startSaveOnce', id);
  if (r.needs === 'locate') toast('Set up the game on this PC first.', 'bad');
}

async function showSaveOnceResult({ id, candidates }) {
  if (!candidates.length) {
    await dialog({ title: 'No new files found', text: 'Nothing changed while the game was open. Did it save? Some games only save when you return to the title screen. You can try again or choose the folder yourself.' });
    return;
  }
  const picks = new Set([0]);
  const rows = candidates.map((c, i) => {
    const box = h('input', { type: 'checkbox', checked: i === 0 });
    box.addEventListener('change', () => (box.checked ? picks.add(i) : picks.delete(i)));
    return h('label', { class: `choice${i === 0 ? ' sel' : ''}`, onclick: (e) => { if (e.target !== box) return; e.currentTarget.classList.toggle('sel', box.checked); } },
      box,
      h('div', { class: 'grow' },
        h('div', { class: 'mono' }, c.path, c.include && c.include.length ? `  (${c.include.join(', ')})` : '', !c.portable ? '  — this PC only' : ''),
        h('div', { class: 'p' }, `${c.fileCount} changed file${c.fileCount === 1 ? '' : 's'} · ${c.reason}`),
        h('div', { class: 'files' }, c.files.slice(0, 8).join('\n'))));
  });
  const ok = await dialog({
    title: 'Files that changed while you played',
    text: 'Tick the save folder. The most likely one is ticked already.',
    body: rows, wide: true,
    buttons: [{ label: 'Cancel', value: false, cls: 'ghost' }, { label: 'Use selected', value: true, cls: 'primary' }],
  });
  if (!ok) return;
  for (const i of picks) {
    const c = candidates[i];
    await call('addSaveRule', id, { path: c.path, include: c.include });
  }
  toast('Save location added.', 'good');
  if (view === 'detail' && currentId === id) renderDetail(id, { noAuto: true });
  refreshStatus(id);
}

// ------------------------------------------------------------------ events & boot

vns.on('game-state', async (s) => {
  live[s.id] = s;
  const g = games.find((x) => x.id === s.id);
  if (s.state === 'idle' && s.message) toast(`${g ? g.title : ''}: ${s.message}`, 'good');
  if (s.state === 'error') toast(s.message, 'bad');
  if (s.state === 'idle' || s.state === 'error') refreshStatus(s.id);
  updateCard(s.id);
  if (view === 'detail' && currentId === s.id) updateStatusLine();
  if (s.state === 'conflict') {
    const v = await conflictDialog(s.info);
    if (v) syncNow(s.id, { resolution: v });
  }
});
vns.on('games-changed', () => { if (view === 'library') loadGames(); });
vns.on('saveonce-result', showSaveOnceResult);

$('#search').addEventListener('input', renderGrid);
$('#backBtn').addEventListener('click', showLibrary);
$('#addBtn').addEventListener('click', addGameFlow);
$('#settingsBtn').addEventListener('click', () => settingsDialog(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view === 'detail' && !$('#dlg').open) showLibrary();
});

// Drag an .exe onto the window to add it.
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
  if (!setup.configured) await settingsDialog(true);
  await loadGames();
})();
