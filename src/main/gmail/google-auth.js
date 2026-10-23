'use strict';
// Google OAuth 2.0 for installed apps: loopback redirect + PKCE, opened in the system browser.

const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// gmail.modify: read, label, trash and send. It cannot permanently delete mail.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class GoogleAuth {
  constructor(store) {
    this.store = store;
    this.tokens = store.loadTokens();
    this.refreshing = null;
  }

  get credentials() {
    const { clientId, clientSecret } = this.store.settings.google;
    if (!clientId) throw new Error('Google OAuth client ID is not configured. Open Settings → Gmail account.');
    return { clientId, clientSecret };
  }

  isSignedIn() {
    return !!(this.tokens && this.tokens.refresh_token);
  }

  async signIn() {
    const { clientId, clientSecret } = this.credentials;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<html><body style="font-family:Segoe UI,sans-serif;padding:40px"><h2>${
            ok ? 'OpenMail is connected to Gmail.' : 'Sign-in failed.'
          }</h2><p>You can close this tab and return to OpenMail.</p></body></html>`
        );
        server.close();
        clearTimeout(timer);
        if (ok) resolve({ code: url.searchParams.get('code'), redirectUri: server.redirectUri });
        else reject(new Error(url.searchParams.get('error') || 'OAuth state mismatch'));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Timed out waiting for Google sign-in'));
      }, 5 * 60 * 1000);
      server.listen(0, '127.0.0.1', () => {
        server.redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: server.redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
        shell.openExternal(`${AUTH_URL}?${params}`);
      });
    });

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (clientSecret) body.set('client_secret', clientSecret);
    const tokens = await postToken(body);
    tokens.expires_at = Date.now() + (tokens.expires_in - 60) * 1000;
    this.tokens = tokens;
    this.store.saveTokens(tokens);
    return true;
  }

  async getAccessToken() {
    if (!this.isSignedIn()) throw new Error('Not signed in to Gmail');
    if (this.tokens.access_token && Date.now() < this.tokens.expires_at) return this.tokens.access_token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const { clientId, clientSecret } = this.credentials;
        const body = new URLSearchParams({
          client_id: clientId,
          refresh_token: this.tokens.refresh_token,
          grant_type: 'refresh_token',
        });
        if (clientSecret) body.set('client_secret', clientSecret);
        const fresh = await postToken(body);
        this.tokens = { ...this.tokens, ...fresh, expires_at: Date.now() + (fresh.expires_in - 60) * 1000 };
        this.store.saveTokens(this.tokens);
      })().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.tokens.access_token;
  }

  async signOut() {
    if (this.tokens?.refresh_token) {
      try {
        await fetch(`${REVOKE_URL}?token=${encodeURIComponent(this.tokens.refresh_token)}`, { method: 'POST' });
      } catch {
        // Revocation is best-effort; local tokens are removed regardless.
      }
    }
    this.tokens = null;
    this.store.clearTokens();
  }
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(`Google token error: ${json.error_description || json.error || res.status}`);
    err.code = json.error;
    throw err;
  }
  return json;
}

module.exports = { GoogleAuth };
