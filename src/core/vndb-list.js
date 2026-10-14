'use strict';
// Two-way sync between the library and the owner's VNDB list (https://api.vndb.org/kana).
//
// What syncs, per game linked to a VNDB entry:
//   status      <-> the list labels Playing/Finished/Stalled/Dropped/Wishlist (ids 1–5)
//   categories  <-> the owner's own labels (id >= 10) with the same name, case ignored
//   vote        <-> "Your rating" (10–100)
//   started / finished dates
// Notes never sync.
//
// Each field is merged three ways against what both sides agreed on last time (the "base", kept in
// game.json under vndbSync[<VNDB user id>], so every PC shares it). A side that changed wins; when
// both changed, the newer change wins. A failed write leaves the base alone, so the next run simply
// tries again: nothing needs a separate queue.

const DEFAULT_API = 'https://api.vndb.org/kana';

// VNDB's predefined label ids for each reading status.
const STATUS_LABELS = { playing: 1, finished: 2, stalled: 3, dropped: 4, wishlist: 5 };
const LABEL_STATUS = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, v]) => [v, k]));
// When an entry has more than one status label, the one shown here first wins.
const STATUS_PRIORITY = ['finished', 'playing', 'stalled', 'dropped', 'wishlist'];
const BLACKLIST = 6;
const CUSTOM_MIN = 10; // ids below this are VNDB's own labels

const LIST_FIELDS = 'id,labels.id,vote,started,finished,lastmod,'
  + 'vn.title,vn.alttitle,vn.released,vn.image.url,vn.image.sexual,vn.developers.name';

class VndbError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small client for the list endpoints. Requests run one at a time, at most one a second. */
class VndbListClient {
  constructor({ token, fetchImpl = fetch, apiBase = DEFAULT_API, gapMs = 1000, wait = sleep } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.gapMs = gapMs;
    this.wait = wait;
    this.chain = Promise.resolve();
    this.last = 0;
  }

  request(method, p, body) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const gap = this.last + this.gapMs - Date.now();
        if (gap > 0) await this.wait(gap);
        this.last = Date.now();
        let res;
        try {
          res = await this.fetchImpl(`${this.apiBase}${p}`, {
            method,
            headers: {
              'User-Agent': 'VN-Shelf',
              Authorization: `Token ${this.token}`,
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
        } catch (e) {
          throw new VndbError(`Couldn't reach VNDB (${e.message})`, 'offline');
        }
        if (res.status === 429 && attempt < 3) {
          // Over the limit: wait as long as VNDB asks (or a minute), then try again.
          const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          await this.wait(Math.min(120, after > 0 ? after : 60) * 1000);
          continue;
        }
        if (res.status === 401) throw new VndbError('VNDB didn\'t accept the token. Make a new one and connect again.', 'bad-token', 401);
        if (res.status === 429) throw new VndbError('VNDB is rate-limiting requests; it will try again later.', 'rate-limited', 429);
        if (!res.ok) {
          let msg = '';
          try { msg = (await res.text()).slice(0, 200); } catch { /* none */ }
          throw new VndbError(`VNDB request failed (${res.status}${msg ? `: ${msg}` : ''})`, 'http', res.status);
        }
        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
    };
    const next = this.chain.catch(() => {}).then(run);
    this.chain = next;
    return next;
  }

  /** { id, username, permissions } of the token's owner. */
  authinfo() { return this.request('GET', '/authinfo'); }

  async labels(user) {
    const r = await this.request('GET', `/ulist_labels?user=${encodeURIComponent(user)}`);
    return (r && r.labels) || [];
  }

  /**
   * The owner's list, newest change first. With `since` (unix seconds), stops at the first page
   * that reaches entries not changed since then (usually one request).
   */
  async list(user, { since = 0, pageSize = 100, maxPages = 100 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.request('POST', '/ulist', {
        user, fields: LIST_FIELDS, sort: 'lastmod', reverse: true, results: pageSize, page,
      });
      const results = (r && r.results) || [];
      let reachedOld = false;
      for (const e of results) {
        if (since && e.lastmod < since) { reachedOld = true; break; }
        out.push(e);
      }
      if (reachedOld || !(r && r.more)) break;
    }
    return out;
  }

  patch(vid, body) { return this.request('PATCH', `/ulist/${vid}`, body); }
}

// ---------------------------------------------------------------- pure merge logic

const lc = (s) => String(s || '').trim().toLowerCase();
const sortNames = (a) => [...a].sort((x, y) => lc(x).localeCompare(lc(y)));

function cleanVote(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 10 && n <= 100 ? n : null;
}

function cleanDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : '';
}

/** The status an entry's labels show (see STATUS_PRIORITY), or ''. */
function statusOf(labelIds) {
  const set = new Set(labelIds);
  return STATUS_PRIORITY.find((s) => set.has(STATUS_LABELS[s])) || '';
}

/** The owner's own labels, by lower-cased name: { name -> { id, label } }. */
function customLabels(labels) {
  const m = new Map();
  for (const l of labels || []) if (l.id >= CUSTOM_MIN && l.label && !m.has(lc(l.label))) m.set(lc(l.label), { id: l.id, label: l.label });
  return m;
}

/** What the library says, in list terms. Only categories with a matching label take part. */
function localView(game, custom) {
  const labels = [];
  for (const c of game.categories || []) {
    const l = custom.get(lc(c));
    if (l && !labels.includes(l.label)) labels.push(l.label);
  }
  return {
    status: game.status || '',
    labels: sortNames(labels),
    vote: cleanVote(game.vote),
    started: cleanDate(game.started),
    finished: cleanDate(game.finished),
  };
}

/** What a VNDB list entry says (an empty view when the VN isn't on the list). */
function remoteView(entry, custom) {
  if (!entry) return { status: '', labels: [], vote: null, started: '', finished: '' };
  const ids = (entry.labels || []).map((l) => (typeof l === 'object' ? l.id : l));
  const byId = new Map([...custom.values()].map((l) => [l.id, l.label]));
  return {
    status: statusOf(ids),
    labels: sortNames(ids.filter((id) => byId.has(id)).map((id) => byId.get(id))),
    vote: cleanVote(entry.vote),
    started: cleanDate(entry.started),
    finished: cleanDate(entry.finished),
  };
}

const FIELDS = ['status', 'vote', 'started', 'finished'];
const isEmpty = (v) => !v.status && !v.labels.length && !v.vote && !v.started && !v.finished;

/**
 * Merge one game. `localAt`/`remoteAt` are millisecond times of each side's latest change, used
 * only when both changed the same field. Returns the merged view.
 */
function merge(L, R, B, { localAt = 0, remoteAt = 0 } = {}) {
  const localNewer = localAt > remoteAt;
  const M = {};
  for (const f of FIELDS) {
    if (B) {
      const lch = L[f] !== B[f];
      const rch = R[f] !== B[f];
      M[f] = lch && rch ? (localNewer ? L[f] : R[f]) : lch ? L[f] : R[f];
    } else {
      // First time: an empty side takes the other's value; when both have one, the newer wins.
      M[f] = !L[f] ? R[f] : !R[f] ? L[f] : L[f] === R[f] ? L[f] : localNewer ? L[f] : R[f];
    }
  }
  // Labels merge one by one: added or removed on either side sticks. The first time, both sides' labels are kept.
  const names = new Map();
  for (const n of [...L.labels, ...R.labels, ...((B && B.labels) || [])]) if (!names.has(lc(n))) names.set(lc(n), n);
  const has = (list, k) => list.some((n) => lc(n) === k);
  M.labels = sortNames([...names].filter(([k]) => {
    const inL = has(L.labels, k);
    const inR = has(R.labels, k);
    if (!B) return inL || inR;
    const inB = has(B.labels, k);
    return inL !== inB ? inL : inR;
  }).map(([, n]) => n));
  return M;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The PATCH body that turns entry view R (with raw label ids `rawIds`) into M, or null if nothing changes. */
function patchBody(M, R, rawIds, custom) {
  const body = {};
  if (M.status !== R.status) {
    const want = STATUS_LABELS[M.status];
    if (want) body.labels_set = [want];
    // VNDB doesn't take off the other status labels itself.
    const off = rawIds.filter((id) => LABEL_STATUS[id] && id !== want);
    if (off.length) body.labels_unset = off;
  }
  const idOf = (n) => (custom.get(lc(n)) || {}).id;
  const add = M.labels.filter((n) => !R.labels.some((x) => lc(x) === lc(n))).map(idOf).filter(Boolean);
  const del = R.labels.filter((n) => !M.labels.some((x) => lc(x) === lc(n))).map(idOf).filter(Boolean);
  if (add.length) body.labels_set = [...(body.labels_set || []), ...add];
  if (del.length) body.labels_unset = [...(body.labels_unset || []), ...del];
  if (M.vote !== R.vote) body.vote = M.vote;
  if (M.started !== R.started) body.started = M.started || null;
  if (M.finished !== R.finished) body.finished = M.finished || null;
  return Object.keys(body).length ? body : null;
}

/** The game.json changes that turn the library's view L into M. */
function localPatch(game, M, L, custom) {
  const p = {};
  if (M.status !== L.status) { p.status = M.status; p.statusAt = new Date().toISOString(); }
  if (!same(M.labels, L.labels)) {
    // Keep categories that have no label; replace the ones that do with the merged set.
    const keep = (game.categories || []).filter((c) => !custom.has(lc(c)));
    const existing = new Map((game.categories || []).map((c) => [lc(c), c]));
    p.categories = [...keep, ...M.labels.map((n) => existing.get(lc(n)) || n)];
  }
  if (M.vote !== L.vote) p.vote = M.vote;
  if (M.started !== L.started) p.started = M.started;
  if (M.finished !== L.finished) p.finished = M.finished;
  return p;
}

/**
 * One sync run.
 *   client   VndbListClient
 *   user     the VNDB user id ("u123")
 *   canWrite token has listwrite
 *   games    every game in the library
 *   cache    { lastmod, entries: { vid: entry } } kept on this PC between runs (updated in place)
 *   full     fetch the whole list (finds removed entries) instead of only what changed
 *   update   async (id, patch) => writes game.json
 * Returns { pulled, pushed, errors: [{ id, title, message }], cache }.
 */
async function syncList({ client, user, canWrite, games, cache, full = false, update, log = () => {} }) {
  const labels = await client.labels(user);
  const custom = customLabels(labels);
  const since = full ? 0 : (cache.lastmod || 0);
  const fetched = await client.list(user, { since });
  const entries = full ? {} : { ...(cache.entries || {}) };
  for (const e of fetched) entries[e.id] = e;
  let lastmod = full ? 0 : (cache.lastmod || 0);
  for (const e of fetched) lastmod = Math.max(lastmod, e.lastmod || 0);

  let pulled = 0;
  let pushed = 0;
  const errors = [];
  for (const game of games) {
    const vid = game.vndbId;
    if (!vid) continue;
    const entry = entries[vid] || null;
    // A blacklisted VN is left alone.
    if (entry && (entry.labels || []).some((l) => (l.id || l) === BLACKLIST)) continue;
    const sync = (game.vndbSync && game.vndbSync[user]) || null;
    const B = sync ? sync.base : null;
    const L = localView(game, custom);
    const R = remoteView(entry, custom);
    if (!B && isEmpty(L) && isEmpty(R)) continue;
    const localAt = Date.parse(game.listEditedAt || game.statusAt || 0) || 0;
    const remoteAt = entry ? (entry.lastmod || 0) * 1000 : 0;
    const M = merge(L, R, B, { localAt, remoteAt });
    const rawIds = entry ? (entry.labels || []).map((l) => l.id || l) : [];
    const body = canWrite ? patchBody(M, R, rawIds, custom) : null;
    const lp = localPatch(game, M, L, custom);
    let base = M;
    if (body) {
      try {
        await client.patch(vid, body);
        pushed++;
        // Remember what the entry now says, so the next run without a full fetch sees it.
        const ids = new Set(rawIds);
        for (const id of body.labels_unset || []) ids.delete(id);
        for (const id of body.labels_set || []) ids.add(id);
        entries[vid] = {
          ...(entry || { id: vid, vn: null }),
          labels: [...ids].map((id) => ({ id })),
          vote: M.vote, started: M.started || null, finished: M.finished || null,
          lastmod: Math.floor(Date.now() / 1000),
        };
      } catch (e) {
        if (e.code === 'bad-token' || e.code === 'offline') throw e;
        errors.push({ id: game.id, title: game.title, message: e.message });
        log(e);
        base = B; // try again next time
      }
    } else if (!canWrite) {
      base = M;
    }
    const baseChanged = !same(base, B);
    if (Object.keys(lp).length || baseChanged) {
      const vndbSync = { ...(game.vndbSync || {}) };
      if (base) vndbSync[user] = { base, at: new Date().toISOString() };
      await update(game.id, { ...lp, vndbSync });
      if (Object.keys(lp).length) pulled++;
    }
  }
  cache.entries = entries;
  cache.lastmod = lastmod;
  if (full) cache.fullAt = new Date().toISOString();
  return { pulled, pushed, errors, cache, labels: [...custom.values()] };
}

/** List entries whose VN isn't in the library (blacklisted ones left out), for "Your VNDB list". */
function listOnly(cache, games) {
  const have = new Set(games.map((g) => g.vndbId).filter(Boolean));
  return Object.values(cache.entries || {})
    .filter((e) => !have.has(e.id) && !(e.labels || []).some((l) => (l.id || l) === BLACKLIST))
    .map((e) => ({
      vndbId: e.id,
      title: (e.vn && e.vn.title) || e.id,
      titleAlt: (e.vn && e.vn.alttitle) || '',
      released: (e.vn && e.vn.released) || '',
      developer: ((e.vn && e.vn.developers) || []).map((d) => d.name).join(', '),
      image: e.vn && e.vn.image ? e.vn.image.url : null,
      imageSexual: e.vn && e.vn.image ? e.vn.image.sexual : 0,
      status: statusOf((e.labels || []).map((l) => l.id || l)),
      labelIds: (e.labels || []).map((l) => l.id || l),
      vote: cleanVote(e.vote),
      lastmod: e.lastmod || 0,
    }))
    .sort((a, b) => b.lastmod - a.lastmod);
}

/** Today's date on this PC as YYYY-MM-DD. */
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = {
  VndbListClient, VndbError, syncList, listOnly, merge, localView, remoteView, patchBody, localPatch,
  customLabels, statusOf, cleanVote, cleanDate, today, STATUS_LABELS, LIST_FIELDS,
};
