'use strict';
// A small in-memory stand-in for the Google Drive v3 API (and Google's token endpoint), covering
// exactly the calls VN Shelf makes. Lets the Drive code be tested without a Google account.

const http = require('http');
const crypto = require('crypto');

function startFakeDrive({ pageSize = 4 } = {}) {
  const files = new Map(); // id -> { id, name, mimeType, parents, appProperties, trashed, content, modifiedTime }
  let nextId = 1;
  const state = {
    validToken: 'tok-1',
    refreshToken: 'refresh-1',
    failNext: [], // status codes to return for the next requests
    requests: 0,
    files,
  };

  let lastNow = 0;
  const now = () => { lastNow = Math.max(Date.now(), lastNow + 1); return new Date(lastNow).toISOString(); };
  const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
  const view = (f) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties,
    size: f.content ? String(f.content.length) : undefined, md5Checksum: f.content ? md5(f.content) : undefined,
    modifiedTime: f.modifiedTime,
  });
  const isTrashed = (f) => {
    for (let cur = f; cur; cur = cur.parents && files.get(cur.parents[0])) if (cur.trashed) return true;
    return false;
  };

  function matches(f, q) {
    let rest = q;
    const take = (re) => { const m = re.exec(rest); if (!m) return null; rest = rest.replace(m[0], ''); return m; };
    let m;
    while ((m = take(/\((name = '[^']*'(?: or name = '[^']*')*)\)/))) {
      const names = [...m[1].matchAll(/name = '([^']*)'/g)].map((x) => x[1]);
      if (!names.includes(f.name)) return false;
    }
    while ((m = take(/modifiedTime > '([^']*)'/))) if (!(f.modifiedTime > m[1])) return false;
    while ((m = take(/appProperties has \{ key='([^']*)' and value='([^']*)' \}/))) {
      if (!f.appProperties || f.appProperties[m[1]] !== m[2]) return false;
    }
    while ((m = take(/'((?:[^'\\]|\\.)*)' in parents/))) if (!(f.parents || []).includes(m[1])) return false;
    while ((m = take(/name = '((?:[^'\\]|\\.)*)'/))) if (f.name !== m[1].replace(/\\(.)/g, '$1')) return false;
    while ((m = take(/mimeType = '([^']*)'/))) if (f.mimeType !== m[1]) return false;
    while ((m = take(/trashed = (true|false)/))) if (isTrashed(f) !== (m[1] === 'true')) return false;
    if (rest.replace(/\band\b/g, '').trim()) throw new Error(`fake drive: unsupported query part: ${rest}`);
    return true;
  }

  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    state.requests++;
    const u = new URL(req.url, 'http://x');
    const body = await readBody(req);

    // Google OAuth token + revoke endpoints
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body.toString());
      if (p.get('grant_type') === 'refresh_token') {
        if (p.get('refresh_token') !== state.refreshToken) return send(res, 400, { error: 'invalid_grant' });
        state.validToken = `tok-${Date.now()}`;
        return send(res, 200, { access_token: state.validToken, expires_in: 3600 });
      }
      if (p.get('grant_type') === 'authorization_code') {
        if (!p.get('code_verifier')) return send(res, 400, { error: 'invalid_request' });
        return send(res, 200, { access_token: state.validToken, refresh_token: state.refreshToken, expires_in: 3600 });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/revoke') { state.refreshToken = `revoked-${Date.now()}`; return send(res, 200, {}); }

    if (req.headers.authorization !== `Bearer ${state.validToken}`) return send(res, 401, { error: { message: 'Invalid Credentials' } });
    if (state.failNext.length) return send(res, state.failNext.shift(), { error: { message: 'injected failure' } });

    const idm = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    try {
      if (req.method === 'GET' && u.pathname === '/drive/v3/about') {
        return send(res, 200, { user: { emailAddress: 'tester@example.com', displayName: 'Tester' } });
      }
      if (req.method === 'GET' && u.pathname === '/drive/v3/files') {
        const q = u.searchParams.get('q') || '';
        const all = [...files.values()].filter((f) => matches(f, q));
        const start = Number(u.searchParams.get('pageToken') || 0);
        const page = all.slice(start, start + pageSize).map(view);
        return send(res, 200, { files: page, nextPageToken: start + pageSize < all.length ? String(start + pageSize) : undefined });
      }
      if (req.method === 'POST' && u.pathname === '/drive/v3/files') {
        const meta = JSON.parse(body.toString());
        const f = { id: `f${nextId++}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || ['root'], appProperties: meta.appProperties, modifiedTime: now() };
        files.set(f.id, f);
        return send(res, 200, view(f));
      }
      if (req.method === 'POST' && u.pathname === '/upload/drive/v3/files') {
        const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'])[1];
        const raw = body.toString('latin1');
        const parts = raw.split(`--${boundary}`).filter((p) => p && !p.startsWith('--'));
        const partBody = (p) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
        const meta = JSON.parse(Buffer.from(partBody(parts[0]), 'latin1').toString('utf8'));
        const content = Buffer.from(partBody(parts[1]), 'latin1');
        const f = { id: `f${nextId++}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, appProperties: meta.appProperties, content, modifiedTime: now() };
        files.set(f.id, f);
        return send(res, 200, view(f));
      }
      if (idm) {
        const f = files.get(idm[1]);
        if (!f) return send(res, 404, { error: { message: 'File not found' } });
        if (req.method === 'GET' && u.searchParams.get('alt') === 'media') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          return res.end(f.content || Buffer.alloc(0));
        }
        if (req.method === 'PATCH' && u.pathname.startsWith('/upload/')) {
          f.content = body; f.modifiedTime = now();
          return send(res, 200, view(f));
        }
        if (req.method === 'PATCH') {
          Object.assign(f, JSON.parse(body.toString())); f.modifiedTime = now();
          return send(res, 200, view(f));
        }
        if (req.method === 'DELETE') { files.delete(f.id); res.writeHead(204); return res.end(); }
      }
      return send(res, 400, { error: { message: `fake drive: unsupported ${req.method} ${u.pathname}` } });
    } catch (e) {
      return send(res, 500, { error: { message: e.message } });
    }
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      base, state, server,
      apiBase: `${base}/drive/v3`, uploadBase: `${base}/upload/drive/v3`,
      tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke`,
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

module.exports = { startFakeDrive };
