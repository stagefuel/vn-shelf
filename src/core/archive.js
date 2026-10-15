'use strict';
// Downloading VNs from a Filebrowser Quantum server you have an account on. The server keeps an
// index file (vnshelf-index.json) listing each VN with its VNDB id(s), files and sizes; paths in it
// are relative to the folder the index is in. VN Shelf stores only an API token made from your
// login (on this PC, encrypted), never the password. Downloads go one at a time and resume with
// HTTP ranges, so a paused or interrupted download carries on where it stopped.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const INDEX_NAME = 'vnshelf-index.json';
const UA = 'VN-Shelf';

function cleanServer(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('Enter the server address.');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const p = new URL(u);
  return `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, '')}`;
}

async function failure(res, what) {
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) {
    return Object.assign(new Error(`${what}: not allowed${msg ? ` (${msg})` : ''}.`), { code: 'denied', status: res.status });
  }
  return Object.assign(new Error(`${what} failed (${res.status}${msg ? `: ${msg}` : ''}).`), { status: res.status });
}

/**
 * Log in once and make a long-lived API token named `tokenName`; the login session is ended right
 * after. Needs an account allowed to make API tokens.
 */
async function connect(server, username, password, { tokenName = 'VN Shelf', days = 3650, fetchImpl = fetch } = {}) {
  const base = cleanServer(server);
  const login = await fetchImpl(`${base}/api/auth/login?${new URLSearchParams({ username })}`, {
    method: 'POST', headers: { 'X-Password': encodeURIComponent(password), 'User-Agent': UA },
  });
  if (login.status === 401 || login.status === 403) throw Object.assign(new Error('Wrong username or password.'), { code: 'login' });
  if (!login.ok) throw await failure(login, 'Login');
  const session = (await login.text()).trim();
  const auth = { Authorization: `Bearer ${session}`, 'User-Agent': UA };
  try {
    const name = tokenName.slice(0, 60);
    // A token with this name from an earlier connect would block a new one: replace it.
    await fetchImpl(`${base}/api/auth/token?${new URLSearchParams({ name })}`, { method: 'DELETE', headers: auth }).catch(() => {});
    const res = await fetchImpl(`${base}/api/auth/token?${new URLSearchParams({ name, days: String(days), minimal: 'true' })}`, { method: 'POST', headers: auth });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('This account can\'t make API tokens. Ask the server\'s admin.'), { code: 'no-api' });
    if (!res.ok) throw await failure(res, 'Making a token');
    const body = await res.json();
    if (!body.token) throw new Error('The server didn\'t return a token.');
    return { server: base, username, token: body.token, tokenName: name };
  } finally {
    await fetchImpl(`${base}/api/auth/logout`, { method: 'POST', headers: auth }).catch(() => {});
  }
}

/** Delete this PC's token on the server (best effort: disconnecting works offline too). */
async function revoke(server, token, tokenName, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${cleanServer(server)}/api/auth/token?${new URLSearchParams({ name: tokenName })}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
  });
  return res.ok;
}

class ArchiveClient {
  constructor({ server, token, fetchImpl = fetch }) {
    this.base = cleanServer(server);
    this.token = token;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) { return { Authorization: `Bearer ${this.token}`, 'User-Agent': UA, ...extra }; }

  async get(p, params) {
    const res = await this.fetch(`${this.base}${p}?${new URLSearchParams(params)}`, { headers: this.headers() });
    if (!res.ok) throw await failure(res, 'The archive');
    return res;
  }

  /**
   * Where the index is: at the top of a source or in one of its top-level folders, else wherever
   * the server's search finds it (search can lag behind new files, so it's the fallback).
   */
  async findIndex() {
    const me = await (await this.get('/api/users', {})).json();
    const users = Array.isArray(me) ? me : [me];
    const sources = [...new Set(users.flatMap((u) => (u.scopes || []).map((sc) => sc.name)).filter(Boolean))];
    if (!sources.length) throw Object.assign(new Error('This account can\'t see any files.'), { code: 'denied' });
    const exists = async (source, p) => {
      const res = await this.fetch(`${this.base}/api/resources?${new URLSearchParams({ source, path: p })}`, { headers: this.headers() });
      if (res.status === 401) throw await failure(res, 'The archive');
      return res.ok;
    };
    for (const source of sources) {
      if (await exists(source, `/${INDEX_NAME}`)) return { source, path: `/${INDEX_NAME}` };
      let folders = [];
      try { folders = ((await (await this.get('/api/resources/items', { source, path: '/', only: 'folders' })).json()).folders || []); } catch { /* can't list: rely on search */ }
      for (const f of folders.slice(0, 50)) {
        const p = `/${f}/${INDEX_NAME}`;
        if (await exists(source, p)) return { source, path: p };
      }
    }
    const res = await this.get('/api/tools/search', { query: INDEX_NAME, sources: sources.join(',') });
    const hits = (await res.json()) || [];
    const hit = hits.filter((h) => path.posix.basename(h.path) === INDEX_NAME)
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
    if (!hit) throw Object.assign(new Error('No VN index on this server.'), { code: 'no-index' });
    return { source: hit.source || sources[0], path: `/${hit.path.replace(/^\/+/, '')}` };
  }

  /** The index, with each item's files turned into server paths. */
  async fetchIndex(where) {
    const res = await this.get('/api/resources/download', { source: where.source, file: where.path });
    const index = await res.json();
    const dir = path.posix.dirname(where.path);
    for (const it of index.items || []) {
      for (const f of it.files || []) f.remote = path.posix.join(dir, f.path);
    }
    return index;
  }

  /**
   * Download one file to `dest`, carrying on from `dest.part` if a previous try stopped part-way.
   * `size` (from the index) is checked at the end.
   */
  async downloadFile({ source, remote, size }, dest, { signal, onProgress } = {}) {
    const part = `${dest}.part`;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch { /* fresh start */ }
    if (size != null && have > size) { await fsp.rm(part, { force: true }); have = 0; }
    if (size != null && have === size) { await fsp.rename(part, dest); return { bytes: 0 }; }
    const res = await this.fetch(`${this.base}/api/resources/download?${new URLSearchParams({ source, file: remote })}`, {
      headers: this.headers(have ? { Range: `bytes=${have}-` } : {}), signal,
    });
    if (res.status === 416 && size != null && have === size) { await fsp.rename(part, dest); return { bytes: 0 }; }
    if (!res.ok) throw await failure(res, `Downloading ${path.posix.basename(remote)}`);
    if (have && res.status !== 206) have = 0; // the server sent the whole file: start over
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let got = 0;
    try {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk);
        got += b.length;
        if (!out.write(b)) await new Promise((r) => out.once('drain', r));
        if (onProgress) onProgress(have + got);
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      await new Promise((r) => out.end(r));
      throw e;
    }
    const total = have + got;
    if (size != null && total !== size) {
      if (total > size) await fsp.rm(part, { force: true });
      throw new Error(`${path.posix.basename(remote)} came out the wrong size; try again.`);
    }
    await fsp.rename(part, dest);
    return { bytes: got };
  }
}

/**
 * Downloads, one at a time, in order. Each job is one index item: its files go into `dest` keeping
 * their folders (relative to the item). The list is saved so jobs survive a restart (paused).
 * Job states: queued, downloading, paused, done, error.
 */
class DownloadQueue {
  constructor({ client, file, onChange = () => {}, onDone = async () => {}, onDenied = () => {} }) {
    this.client = client;
    this.onDenied = onDenied;
    this.file = file;
    this.onChange = onChange;
    this.onDone = onDone;
    this.jobs = [];
    this.active = null;
  }

  async load() {
    try { this.jobs = JSON.parse(await fsp.readFile(this.file, 'utf8')); } catch { this.jobs = []; }
    for (const j of this.jobs) if (j.state === 'downloading') j.state = 'paused';
    return this;
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.jobs.map(({ abort, ...j }) => j)));
    await fsp.rename(tmp, this.file);
  }

  changed() { this.onChange(this.list()); this.save().catch(() => {}); }

  list() { return this.jobs.map(({ abort, ...j }) => j); }

  /** item: an index item; source: the index's source; dest: folder for its files. */
  add(item, { source, dest }) {
    if (this.jobs.some((j) => j.key === item.path && !['done', 'error'].includes(j.state))) return null;
    this.jobs = this.jobs.filter((j) => j.key !== item.path);
    const base = item.kind === 'folder' ? item.path : path.posix.dirname(item.path);
    const job = {
      key: item.path, title: item.title, vids: item.vids || [], igdb: item.igdb || null, part: item.part || null,
      source, dest, state: 'queued', received: 0, total: item.size || 0, done: [],
      files: (item.files || []).map((f) => ({ remote: f.remote, rel: path.posix.relative(base, f.path), size: f.size })),
      added: Date.now(),
    };
    this.jobs.push(job);
    this.changed();
    this.pump();
    return job;
  }

  pause(key) {
    const j = this.jobs.find((x) => x.key === key);
    if (!j) return;
    if (j.abort) j.abort.abort();
    if (['queued', 'downloading'].includes(j.state)) j.state = 'paused';
    this.changed();
  }

  resume(key) {
    const j = this.jobs.find((x) => x.key === key);
    if (!j || !['paused', 'error'].includes(j.state)) return;
    j.state = 'queued';
    j.error = null;
    this.changed();
    this.pump();
  }

  /** Stop and forget a job; its partly downloaded files are deleted (finished ones are kept). */
  async cancel(key) {
    const j = this.jobs.find((x) => x.key === key);
    if (!j) return;
    if (j.abort) j.abort.abort();
    this.jobs = this.jobs.filter((x) => x !== j);
    for (const f of j.files) await fsp.rm(`${path.join(j.dest, ...f.rel.split('/'))}.part`, { force: true }).catch(() => {});
    this.changed();
  }

  clearFinished() { this.jobs = this.jobs.filter((j) => j.state !== 'done'); this.changed(); }

  async pump() {
    if (this.active) return;
    const j = this.jobs.find((x) => x.state === 'queued');
    if (!j) return;
    this.active = j;
    j.state = 'downloading';
    j.abort = new AbortController();
    this.changed();
    let last = 0;
    try {
      const doneBytes = () => j.files.filter((f) => j.done.includes(f.rel)).reduce((s, f) => s + (f.size || 0), 0);
      for (const f of j.files) {
        if (j.done.includes(f.rel)) continue;
        const dest = path.join(j.dest, ...f.rel.split('/'));
        const before = doneBytes();
        await this.client.downloadFile({ source: j.source, remote: f.remote, size: f.size }, dest, {
          signal: j.abort.signal,
          onProgress: (n) => {
            j.received = before + n;
            if (Date.now() - last > 250) { last = Date.now(); this.onChange(this.list()); }
          },
        });
        j.done.push(f.rel);
        j.received = doneBytes();
        this.changed();
      }
      j.state = 'done';
      j.finished = Date.now();
      delete j.abort;
      this.changed();
      await this.onDone(j).catch(() => {});
    } catch (e) {
      delete j.abort;
      if (j.state === 'downloading') { j.state = 'error'; j.error = e.message; }
      this.changed();
      if (e.code === 'denied') this.onDenied(e);
    } finally {
      this.active = null;
      this.pump();
    }
  }
}

module.exports = { connect, revoke, ArchiveClient, DownloadQueue, cleanServer, INDEX_NAME };
