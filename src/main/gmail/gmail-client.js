'use strict';
// Thin Gmail REST API client (no googleapis dependency) with retry/backoff for rate limits.

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

class GmailClient {
  constructor(auth) {
    this.auth = auth;
  }

  async request(method, path, { query, body, raw } = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.getAccessToken();
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        if (res.status === 204) return null;
        return raw ? res.text() : res.json();
      }
      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit|userRateLimit/i.test(text));
      if (retryable && attempt < 6) {
        const wait = Math.min(64000, 1000 * 2 ** attempt) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        this.auth.tokens.expires_at = 0; // force refresh once
        continue;
      }
      const err = new Error(`Gmail API ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  }

  profile() {
    return this.request('GET', '/profile');
  }

  async labels() {
    const res = await this.request('GET', '/labels');
    return res.labels || [];
  }

  listMessages({ q, pageToken, maxResults = 500, includeSpamTrash = false, labelIds } = {}) {
    return this.request('GET', '/messages', { query: { q, pageToken, maxResults, includeSpamTrash, labelIds } });
  }

  // Iterate every message id matching a query.
  async *iterateMessageIds(opts = {}) {
    let pageToken = opts.pageToken;
    do {
      const res = await this.listMessages({ ...opts, pageToken });
      yield { messages: res.messages || [], nextPageToken: res.nextPageToken, estimate: res.resultSizeEstimate };
      pageToken = res.nextPageToken;
    } while (pageToken);
  }

  getMetadata(id) {
    return this.request('GET', `/messages/${id}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe'] },
    });
  }

  async getRaw(id) {
    const res = await this.request('GET', `/messages/${id}`, { query: { format: 'raw' } });
    return {
      id: res.id,
      threadId: res.threadId,
      labelIds: res.labelIds || [],
      historyId: res.historyId,
      internalDate: res.internalDate,
      sizeEstimate: res.sizeEstimate,
      snippet: res.snippet,
      raw: Buffer.from(res.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    };
  }

  trash(id) {
    return this.request('POST', `/messages/${id}/trash`);
  }

  untrash(id) {
    return this.request('POST', `/messages/${id}/untrash`);
  }

  modify(id, addLabelIds = [], removeLabelIds = []) {
    return this.request('POST', `/messages/${id}/modify`, { body: { addLabelIds, removeLabelIds } });
  }

  batchModify(ids, addLabelIds = [], removeLabelIds = []) {
    return this.request('POST', '/messages/batchModify', { body: { ids, addLabelIds, removeLabelIds } });
  }

  history(startHistoryId, pageToken) {
    return this.request('GET', '/history', {
      query: { startHistoryId, pageToken, historyTypes: 'messageAdded', maxResults: 500 },
    });
  }

  send(rawMime, threadId) {
    const raw = Buffer.from(rawMime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.request('POST', '/messages/send', { body: { raw, ...(threadId ? { threadId } : {}) } });
  }
}

module.exports = { GmailClient };
