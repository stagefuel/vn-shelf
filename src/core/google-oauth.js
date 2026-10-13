'use strict';
// "Sign in with Google" for a desktop app: the browser opens Google's consent page, Google redirects
// back to a one-off local web server on 127.0.0.1, and the code is swapped for tokens (with PKCE).
// Only the drive.file scope is requested: VN Shelf can see the Drive files it created, nothing else.

const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>VN Shelf</title>
<body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${ok ? 'Signed in to VN Shelf' : 'Sign-in did not finish'}</h2><p style="color:#9aa1b2">${msg}</p></div>`;

class GoogleAuth {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {string} o.clientSecret       desktop-app secret (not confidential per Google)
   * @param {{load: () => object|null, save: (t: object) => void, clear: () => void}} o.tokenStore
   * @param {(url: string) => any} o.openUrl
   */
  constructor(o) {
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.store = o.tokenStore;
    this.openUrl = o.openUrl;
    this.fetch = o.fetchImpl || fetch;
    this.authUrl = o.authUrl || AUTH_URL;
    this.tokenUrl = o.tokenUrl || TOKEN_URL;
    this.revokeUrl = o.revokeUrl || REVOKE_URL;
    this.refreshing = null;
  }

  signedIn() {
    const t = this.store.load();
    return !!(t && t.refresh_token);
  }

  /** Run the browser sign-in. Resolves with the saved tokens. */
  async signIn({ timeoutMs = 5 * 60 * 1000 } = {}) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let redirectUri;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
        const err = u.searchParams.get('error');
        const gotState = u.searchParams.get('state');
        const gotCode = u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (err || gotState !== state || !gotCode) {
          res.end(DONE_PAGE(false, err === 'access_denied' ? 'Access was not allowed. You can close this tab.' : 'Something went wrong. Close this tab and try again from VN Shelf.'));
          finish(new AuthError(err === 'access_denied' ? 'denied' : 'failed', err === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed${err ? `: ${err}` : ''}.`));
          return;
        }
        res.end(DONE_PAGE(true, 'You can close this tab and go back to VN Shelf.'));
        finish(null, { code: gotCode, redirectUri });
      });
      const timer = setTimeout(() => finish(new AuthError('timeout', 'Google sign-in timed out.')), timeoutMs);
      let done = false;
      function finish(e, v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        server.close();
        if (e) reject(e); else resolve(v);
      }
      server.on('error', (e) => finish(new AuthError('failed', `Couldn't start the sign-in helper: ${e.message}`)));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}`;
        const url = new URL(this.authUrl);
        const params = {
          client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
          code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
        };
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        Promise.resolve(this.openUrl(url.toString())).catch((e) => finish(new AuthError('failed', e.message)));
      });
    });

    const t = await this.tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    });
    if (!t.refresh_token) throw new AuthError('failed', 'Google did not return a long-lived sign-in. Please try again.');
    const tokens = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 };
    this.store.save(tokens);
    return tokens;
  }

  async tokenRequest(fields) {
    let res;
    try {
      res = await this.fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...fields }).toString(),
      });
    } catch (e) {
      throw Object.assign(new AuthError('offline', `Can't reach Google: ${e.message}`), { status: 0 });
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = j.error === 'invalid_grant' ? 'signed-out' : 'failed';
      throw new AuthError(code, code === 'signed-out'
        ? 'Your Google sign-in has expired or was revoked. Sign in again in Settings.'
        : `Google sign-in error: ${j.error_description || j.error || res.status}`);
    }
    return j;
  }

  /** A valid access token, refreshing it when it is about to expire. */
  async getAccessToken() {
    const t = this.store.load();
    if (!t || !t.refresh_token) throw new AuthError('signed-out', 'Not signed in to Google Drive. Sign in in Settings.');
    if (t.access_token && t.expires_at - Date.now() > 60 * 1000) return t.access_token;
    return this.refreshAccessToken();
  }

  async refreshAccessToken() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const t = this.store.load();
        if (!t || !t.refresh_token) throw new AuthError('signed-out', 'Not signed in to Google Drive.');
        try {
          const r = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
          const next = { ...t, access_token: r.access_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 };
          if (r.refresh_token) next.refresh_token = r.refresh_token;
          this.store.save(next);
          return next.access_token;
        } catch (e) {
          if (e.code === 'signed-out') this.store.clear();
          throw e;
        }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** Revoke access with Google and forget the tokens. */
  async signOut() {
    const t = this.store.load();
    this.store.clear();
    if (t && t.refresh_token) {
      try {
        await this.fetch(this.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t.refresh_token }).toString(),
        });
      } catch { /* offline: tokens are gone locally anyway */ }
    }
  }
}

module.exports = { GoogleAuth, AuthError, SCOPE };
