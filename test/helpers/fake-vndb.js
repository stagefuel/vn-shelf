'use strict';
// A stand-in for VNDB's list API (authinfo, ulist_labels, ulist, PATCH ulist), with the behaviour
// that matters: token check, labels_set/labels_unset, null unsets, lastmod, paging, 429 on demand.
// Use `fetch` in-process, or `listen()` for an HTTP server the app can be pointed at (VNS_VNDB_API).

const http = require('http');

class FakeVndb {
  constructor({ token = 'tok-1', user = { id: 'u42', username: 'reader' }, permissions = ['listread', 'listwrite'] } = {}) {
    this.token = token;
    this.user = user;
    this.permissions = permissions;
    this.labels = [
      { id: 1, label: 'Playing', private: false }, { id: 2, label: 'Finished', private: false },
      { id: 3, label: 'Stalled', private: false }, { id: 4, label: 'Dropped', private: false },
      { id: 5, label: 'Wishlist', private: false }, { id: 6, label: 'Blacklist', private: false },
      { id: 7, label: 'Voted', private: false },
    ];
    this.entries = new Map(); // vid -> { id, labels:Set, vote, started, finished, lastmod, vn }
    this.requests = [];
    this.vns = new Map(); // extra VN info for /vn lookups
    this.extras = new Map(); // vid -> { screenshots, relations, staff, developers } as VNDB returns them
    this.characters = new Map(); // vid -> [character]
    this.works = new Map(); // s…/p… -> [vn]
    this.names = new Map(); // s…/p… -> { name, original }
    this.releases = new Map(); // vid -> [{ engine, official, platforms, languages }]
    this.rateLimitNext = 0;
    this.clock = 1700000000;
  }

  tick() { this.clock += 1; return this.clock; }

  addLabel(id, label) { this.labels.push({ id, label, private: false }); }

  setEntry(vid, { labels = [], vote = null, started = null, finished = null, vn = null } = {}) {
    this.entries.set(vid, { id: vid, labels: new Set(labels), vote, started, finished, lastmod: this.tick(), vn: vn || { title: `Title ${vid}` } });
  }

  entry(vid) {
    const e = this.entries.get(vid);
    return e ? { ...e, labels: [...e.labels].sort((a, b) => a - b) } : null;
  }

  json(status, body) {
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
      json: async () => body,
    };
  }

  handle(method, url, headers, body) {
    this.requests.push({ method, url, body });
    if (this.rateLimitNext > 0) { this.rateLimitNext--; return this.json(429, undefined); }
    const u = new URL(url, 'http://x');
    const p = u.pathname.replace(/^\/kana/, '');
    if (method === 'POST' && p === '/vn' && body.filters && ['staff', 'developer'].includes(body.filters[0])) { // works by a person or brand
      return this.json(200, { results: this.works.get(body.filters[2][2]) || [], more: false });
    }
    if (method === 'POST' && p === '/vn' && /screenshots|relations/.test(body.fields || '')) { // a game page's extras
      const x = this.extras.get(body.filters[2]);
      return this.json(200, { results: x ? [{ id: body.filters[2], screenshots: [], relations: [], staff: [], developers: [], ...x }] : [], more: false });
    }
    if (method === 'POST' && p === '/release') return this.json(200, { results: (this.releases.get(body.filters[2][2]) || []).map((r, i) => ({ id: `r${i + 1}`, title: `Release ${i + 1}`, released: '2020-01-01', ...r })), more: false });
    if (method === 'POST' && p === '/character') return this.json(200, { results: this.characters.get(body.filters[2][2]) || [], more: false });
    if (method === 'POST' && (p === '/staff' || p === '/producer')) {
      const n = this.names.get(body.filters[2]);
      return this.json(200, { results: n ? [{ id: body.filters[2], ...n }] : [], more: false });
    }
    if (method === 'POST' && p === '/vn' && body.filters && body.filters[0] === 'or') { // several ids at once
      const ids = body.filters.slice(1).filter((f) => f[0] === 'id').map((f) => f[2]);
      const results = ids.map((id) => [id, this.vns.get(id) || (this.entries.get(id) || {}).vn]).filter(([, vn]) => vn)
        .map(([id, vn]) => ({ id, alttitle: '', released: '2020-01-01', developers: [], image: null, ...vn }));
      return this.json(200, { results, more: false });
    }
    if (method === 'POST' && p === '/vn') { // VN lookups by id (no token needed), from the entries' VN info
      const id = body.filters && body.filters[0] === 'id' ? body.filters[2] : null;
      const vn = id && (this.vns.get(id) || (this.entries.get(id) || {}).vn);
      return this.json(200, { results: vn ? [{ id, alttitle: '', released: '2020-01-01', developers: [], image: null, ...vn }] : [], more: false });
    }
    if ((headers.Authorization || headers.authorization) !== `Token ${this.token}`) return this.json(401, undefined);
    if (method === 'GET' && p === '/authinfo') return this.json(200, { ...this.user, permissions: this.permissions });
    if (method === 'GET' && p === '/ulist_labels') return this.json(200, { labels: this.labels });
    if (method === 'POST' && p === '/ulist') {
      const list = [...this.entries.values()].sort((a, b) => (body.reverse ? b.lastmod - a.lastmod : a.lastmod - b.lastmod));
      const size = body.results || 10;
      const page = body.page || 1;
      const slice = list.slice((page - 1) * size, page * size);
      return this.json(200, {
        more: list.length > page * size,
        results: slice.map((e) => ({
          id: e.id, labels: [...e.labels].map((id) => ({ id, label: (this.labels.find((l) => l.id === id) || {}).label })),
          vote: e.vote, started: e.started, finished: e.finished, lastmod: e.lastmod, vn: e.vn,
        })),
      });
    }
    const m = /^\/ulist\/(v\d+)$/.exec(p);
    if (m && method === 'PATCH') {
      if (!this.permissions.includes('listwrite')) return this.json(401, undefined);
      let e = this.entries.get(m[1]);
      if (!e) { e = { id: m[1], labels: new Set(), vote: null, started: null, finished: null, lastmod: 0, vn: { title: `Title ${m[1]}` } }; this.entries.set(m[1], e); }
      if (body.labels) e.labels = new Set(body.labels);
      for (const id of body.labels_set || []) { if (id === 0 || id === 7) return this.json(400, { error: 'bad label' }); e.labels.add(id); }
      for (const id of body.labels_unset || []) e.labels.delete(id);
      // Like VNDB: a date can be set but not cleared.
      for (const k of ['started', 'finished']) if (k in body && !/^\d{4}-\d{2}-\d{2}$/.test(String(body[k]))) return this.json(400, { error: `Invalid '${k}' member.` });
      for (const k of ['vote', 'started', 'finished']) if (k in body) e[k] = body[k];
      if (e.vote) e.labels.add(7); else e.labels.delete(7);
      e.lastmod = this.tick();
      return this.json(204, undefined);
    }
    if (m && method === 'DELETE') { this.entries.delete(m[1]); return this.json(204, undefined); }
    return this.json(404, undefined);
  }

  get fetch() {
    return async (url, opts = {}) => this.handle(opts.method || 'GET', url, opts.headers || {}, opts.body ? JSON.parse(opts.body) : undefined);
  }

  listen(port = 0) {
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', async () => {
        const body = data ? JSON.parse(data) : undefined;
        // Optionally slow down full-info lookups (applying a match), to test late answers.
        if (this.slowInfoMs && body && /description/.test(body.fields || '')) await new Promise((r) => setTimeout(r, this.slowInfoMs));
        const r = this.handle(req.method, req.url, req.headers, body);
        const text = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(text);
      });
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
      server, url: `http://127.0.0.1:${server.address().port}/kana`, close: () => new Promise((r) => server.close(r)),
    })));
  }
}

module.exports = { FakeVndb };
