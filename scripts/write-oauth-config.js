'use strict';
// Writes src/main/oauth-config.json (git-ignored) with the Google OAuth client for Drive mode.
// Source: VNS_GOOGLE_CLIENT_ID / VNS_GOOGLE_CLIENT_SECRET, or ~/.secrets/google-oauth-vnshelf.
// Without either, the app still builds; it just won't offer "Google Drive (sign in)".
const fs = require('fs');
const os = require('os');
const path = require('path');

let id = process.env.VNS_GOOGLE_CLIENT_ID;
let secret = process.env.VNS_GOOGLE_CLIENT_SECRET;
if (!id || !secret) {
  try {
    const kv = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.secrets', 'google-oauth-vnshelf'), 'utf8')
      .split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
    id = id || kv.client_id;
    secret = secret || kv.client_secret;
  } catch { /* none */ }
}
const out = path.join(__dirname, '..', 'src', 'main', 'oauth-config.json');
if (!id || !secret) {
  fs.rmSync(out, { force: true });
  console.warn('write-oauth-config: no Google client configured; building without Google Drive sign-in.');
} else {
  fs.writeFileSync(out, JSON.stringify({ clientId: id, clientSecret: secret }));
  console.log(`write-oauth-config: Google Drive sign-in enabled (${id.split('-')[0]}-…)`);
}
