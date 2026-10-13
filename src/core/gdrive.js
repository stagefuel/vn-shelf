'use strict';
// Minimal Google Drive v3 client (fetch only, no SDK). With the drive.file scope it can only see
// files and folders VN Shelf itself created.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

class DriveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = status === 0 ? 'cloud-unavailable' : 'drive-error';
  }
}

function q(str) { return `'${String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

class DriveClient {
  /**
   * @param {object} o
   * @param {() => Promise<string>} o.getAccessToken  returns a valid access token
   * @param {() => Promise<string>} [o.refreshAccessToken]  forces a refresh (after a 401)
   * @param {string} [o.apiBase] / [o.uploadBase]  overridable for tests
   */
  constructor(o) {
    this.getAccessToken = o.getAccessToken;
    this.refreshAccessToken = o.refreshAccessToken || o.getAccessToken;
    this.api = o.apiBase || API;
    this.upload = o.uploadBase || UPLOAD;
    this.fetch = o.fetchImpl || fetch;
  }

  async request(method, url, { query, body, headers = {}, raw = false, json } = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) u.searchParams.set(k, v);
    let payload = body;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      headers = { ...headers, 'Content-Type': 'application/json; charset=UTF-8' };
    }
    let token = await this.getAccessToken();
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(u, { method, headers: { ...headers, Authorization: `Bearer ${token}` }, body: payload });
      } catch (e) {
        if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
        throw new DriveError(0, `Can't reach Google Drive: ${e.message}`);
      }
      if (res.status === 401 && attempt === 0) { token = await this.refreshAccessToken(); continue; }
      if ((res.status === 429 || res.status >= 500 || res.status === 403 && /rate/i.test(res.statusText)) && attempt < 5) {
        await sleep(Math.min(16000, 700 * 2 ** attempt + Math.random() * 300));
        continue;
      }
      if (!res.ok) {
        let msg = res.statusText;
        try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch { /* not json */ }
        throw new DriveError(res.status, `Google Drive: ${msg} (${res.status})`);
      }
      if (raw) return Buffer.from(await res.arrayBuffer());
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  /** List files matching a Drive query, following pages. */
  async list(qstr, fields = 'id,name,size,md5Checksum,modifiedTime,parents,appProperties,mimeType') {
    const out = [];
    let pageToken;
    do {
      const r = await this.request('GET', `${this.api}/files`, {
        query: { q: qstr, fields: `nextPageToken,files(${fields})`, pageSize: '1000', pageToken, spaces: 'drive' },
      });
      out.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFolder(name, parentId, appProperties) {
    return this.request('POST', `${this.api}/files`, {
      query: { fields: 'id,name,appProperties' },
      json: { name, mimeType: FOLDER, parents: parentId ? [parentId] : undefined, appProperties },
    });
  }

  /** Create a file with content (multipart upload). */
  async createFile(name, parentId, buf, mime = 'application/octet-stream', appProperties) {
    const boundary = `vns${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name, parents: [parentId], mimeType: mime, appProperties });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.request('POST', `${this.upload}/files`, {
      query: { uploadType: 'multipart', fields: 'id,name,size,md5Checksum,modifiedTime' },
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  /** Replace a file's content. */
  async updateFile(id, buf, mime = 'application/octet-stream') {
    return this.request('PATCH', `${this.upload}/files/${id}`, {
      query: { uploadType: 'media', fields: 'id,name,size,md5Checksum,modifiedTime' },
      headers: { 'Content-Type': mime },
      body: buf,
    });
  }

  async download(id) { return this.request('GET', `${this.api}/files/${id}`, { query: { alt: 'media' }, raw: true }); }

  async remove(id) { return this.request('DELETE', `${this.api}/files/${id}`); }

  async trash(id) { return this.request('PATCH', `${this.api}/files/${id}`, { query: { fields: 'id' }, json: { trashed: true } }); }

  async about() { return this.request('GET', `${this.api}/about`, { query: { fields: 'user(emailAddress,displayName)' } }); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { DriveClient, DriveError, FOLDER, q };
