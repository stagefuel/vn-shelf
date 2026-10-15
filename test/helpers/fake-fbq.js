'use strict';
// A stand-in Filebrowser Quantum server with what VN Shelf uses: password login, API tokens,
// logout, search, and file downloads with byte ranges. Files live in memory: { '/dir/file': Buffer }.

const http = require('http');
const crypto = require('crypto');

class FakeFbq {
  constructor({ users = { reader: { password: 'pw', api: true } }, source = 'Home', files = {} } = {}) {
    this.users = users;
    this.source = source;
    this.files = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
    this.sessions = new Map(); // session -> user
    this.tokens = new Map(); // token -> { user, name }
    this.requests = [];
    this.searchLags = false; // search doesn't know new files yet (like a real server between scans)
    this.slowMs = 0; // delay between chunks, to test pausing
    this.dropAfter = null; // cut a download off after this many bytes (once)
  }

  who(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    if (this.sessions.has(m[1])) return { user: this.sessions.get(m[1]), session: m[1] };
    if (this.tokens.has(m[1])) return { user: this.tokens.get(m[1]).user, token: this.tokens.get(m[1]) };
    return null;
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
    };
    this.requests.push({ method: req.method, path: u.pathname, query: q, range: req.headers.range || null });
    if (req.method === 'POST' && u.pathname === '/api/auth/login') {
      const user = this.users[q.username];
      if (!user || user.password !== decodeURIComponent(req.headers['x-password'] || '')) return send(401, { status: 401, message: 'unauthorized' });
      const s = crypto.randomBytes(12).toString('hex');
      this.sessions.set(s, q.username);
      return send(200, s, { 'Content-Type': 'text/plain' });
    }
    const w = this.who(req);
    if (!w) return send(401, { status: 401, message: 'invalid token provided' });
    if (u.pathname === '/api/auth/logout') { this.sessions.delete(w.session); return send(200); }
    if (u.pathname === '/api/auth/token') {
      if (!this.users[w.user].api) return send(403, { status: 403, message: 'permission denied' });
      if (req.method === 'DELETE') {
        for (const [t, v] of this.tokens) if (v.user === w.user && v.name === q.name) this.tokens.delete(t);
        return send(200);
      }
      if ([...this.tokens.values()].some((v) => v.user === w.user && v.name === q.name)) return send(409, { status: 409, message: 'token already exists' });
      const t = `tok-${crypto.randomBytes(8).toString('hex')}`;
      this.tokens.set(t, { user: w.user, name: q.name, days: Number(q.days) });
      return send(200, { message: 'here is your token!', token: t });
    }
    if (u.pathname === '/api/users' && req.method === 'GET') { // a member only sees itself
      return send(200, [{ username: w.user, scopes: [{ name: this.source, scope: '/files' }] }]);
    }
    if (u.pathname === '/api/resources' && req.method === 'GET') { // metadata: exists or not
      if (q.source !== this.source) return send(403, { status: 403, message: 'no source' });
      const f = this.files.get(q.path);
      return f ? send(200, { name: q.path.split('/').pop(), size: f.length, type: 'blob' }) : send(404, { status: 404, message: 'the resource does not exist' });
    }
    if (u.pathname === '/api/resources/items') {
      const dir = q.path.replace(/\/+$/, '');
      const kids = new Set([...this.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split('/')).filter((x) => x.length > 1).map((x) => x[0]));
      return send(200, { folders: [...kids] });
    }
    if (u.pathname === '/api/tools/search') {
      if (!q.sources) return send(400, { status: 400, message: "'sources' or repeated scope=sourceName:path query parameters are required" });
      if (!q.sources.split(',').includes(this.source) || this.searchLags) return send(200, []);
      const hits = [...this.files.keys()].filter((p) => p.split('/').pop().includes(q.query))
        .map((p) => ({ path: p.replace(/^\//, ''), type: 'application/json', size: this.files.get(p).length, source: this.source }));
      return send(200, hits);
    }
    if (u.pathname === '/api/resources/download') {
      if (q.source !== this.source) return send(403, { status: 403, message: `source name not found: ${q.source}` });
      const body = this.files.get(q.file);
      if (!body) return send(404, { status: 404, message: 'the resource does not exist' });
      let start = 0;
      const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (m) {
        start = Number(m[1]);
        if (start >= body.length) return send(416, '', { 'Content-Range': `bytes */${body.length}` });
      }
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': body.length - start,
        ...(m ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
      });
      const step = 4096;
      for (let i = start; i < body.length; i += step) {
        if (this.dropAfter != null && i - start >= this.dropAfter) { this.dropAfter = null; res.destroy(); return undefined; }
        if (!res.write(body.subarray(i, Math.min(body.length, i + step)))) await new Promise((r) => res.once('drain', r));
        if (this.slowMs) await new Promise((r) => setTimeout(r, this.slowMs));
        if (res.destroyed) return undefined;
      }
      return res.end();
    }
    return send(404, { status: 404, message: 'not found' });
  }

  listen() {
    const server = http.createServer((req, res) => { req.resume(); this.handle(req, res).catch(() => res.destroy()); });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
      server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    })));
  }
}

module.exports = { FakeFbq };
