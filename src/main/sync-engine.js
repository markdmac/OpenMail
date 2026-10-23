'use strict';
// Gmail → PST sync engine.
//
// Initial sync: every message in Gmail (except spam/trash) is downloaded and filed into the PST.
// Ongoing sync: new messages are picked up via the Gmail history API. A new message that is still
// unread is downloaded, filed, and moved to Gmail Trash. A message that was already read by the time
// we see it stays in Gmail and is ignored. Every handled message id goes in a ledger, so a message you
// rescue from Gmail Trash is never processed again.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseRaw } = require('./from-mime');
const rulesEngine = require('./rules');

const SYSTEM_FOLDERS = { INBOX: 'Inbox', SENT: 'Sent Items' };
const CATEGORY_LABELS = {
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};
const DOWNLOAD_CONCURRENCY = 4;
const TRASH_BATCH = 25;

class SyncEngine extends EventEmitter {
  constructor({ store, gmail, mailbox }) {
    super();
    this.store = store;
    this.gmail = gmail;
    this.mailbox = mailbox;
    this.trashQueue = [];
    this.flushing = null;
    this.running = null;
    this.stopRequested = false;
    this.labelMap = new Map();
    this.timer = null;
    this.status = { phase: 'idle', done: 0, total: 0, message: '' };
  }

  log(msg) {
    this.emit('log', `[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  startPolling() {
    this.stopPolling();
    const minutes = Math.max(1, Number(this.store.settings.pollMinutes) || 5);
    this.timer = setInterval(() => {
      if (!this.running) this.syncNow().catch((e) => this.log(`Sync error: ${e.message}`));
    }, minutes * 60000);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop() {
    this.stopRequested = true;
  }

  syncNow() {
    if (this.running) return this.running;
    this.stopRequested = false;
    this.running = (async () => {
      try {
        await this.refreshLabels();
        if (!this.store.state.initialSyncComplete) await this.initialSync();
        if (this.store.state.initialSyncComplete && !this.stopRequested) await this.incrementalSync();
        await this.flushTrash();
        this.store.saveState({ lastSyncAt: new Date().toISOString() });
        this.setStatus({ phase: 'idle', message: this.stopRequested ? 'Sync paused' : 'Up to date' });
      } catch (e) {
        await this.flushTrash().catch(() => {});
        this.setStatus({ phase: 'error', message: e.message });
        throw e;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Messages are moved to Gmail Trash only after the PST holding them has been committed to disk,
   * so a crash can never lose mail: at worst a message stays in Gmail.
   */
  async flushTrash() {
    while (this.flushing) await this.flushing;
    if (!this.trashQueue.length) return;
    const batch = this.trashQueue.splice(0);
    this.flushing = (async () => {
      await this.mailbox.call('commit');
      for (const t of batch) {
        try {
          // The user may have starred it since it was downloaded: re-check right before trashing.
          if (await this.isProtectedStarred(t.id)) {
            this.log(`Kept in Gmail (starred): ${t.id}`);
            continue;
          }
          await this.gmail.trash(t.id);
          this.store.record(t.id, 'archived+trashed', t.entryId, t.folder);
          this.bumpTotal('trashed');
        } catch (e) {
          this.log(`Could not move ${t.id} to Gmail Trash: ${e.message}`);
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /** True if "keep starred in Gmail" is on and the message is currently starred. */
  async isProtectedStarred(id) {
    if (this.store.settings.sync.keepStarredInGmail === false) return false;
    const m = await this.gmail.request('GET', `/messages/${id}`, { query: { format: 'minimal' } });
    return (m.labelIds || []).includes('STARRED');
  }

  async refreshLabels() {
    const labels = await this.gmail.labels();
    this.labelMap = new Map(labels.map((l) => [l.id, l]));
    return labels;
  }

  baseQuery() {
    return this.store.settings.sync.excludeSpam ? '-in:spam -in:trash' : '-in:trash';
  }

  async initialSync() {
    const st = this.store.state;
    if (!st.initialStartedAt) {
      // Remember where Gmail's history is now, so mail arriving during the initial sync is caught afterwards.
      const profile = await this.gmail.profile();
      this.store.saveState({ initialStartedAt: new Date().toISOString(), historyId: profile.historyId });
      this.log(`Starting initial sync of ${profile.emailAddress} (${profile.messagesTotal} messages)`);
    } else {
      this.log('Resuming initial sync');
    }
    const profile = await this.gmail.profile();
    let done = this.store.processed.size;
    this.setStatus({ phase: 'initial', done, total: profile.messagesTotal, message: 'Initial sync' });

    let pageToken = st.initialPageToken || undefined;
    for (;;) {
      if (this.stopRequested) return;
      const res = await this.gmail.listMessages({ q: this.baseQuery(), pageToken, maxResults: 500 });
      const ids = (res.messages || []).map((m) => m.id).filter((id) => !this.store.isProcessed(id));
      await this.runPool(ids, async (id) => {
        await this.processMessage(id, 'initial');
        done++;
        this.setStatus({ done });
      });
      if (this.stopRequested) return;
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
      this.store.saveState({ initialPageToken: pageToken });
    }
    this.store.saveState({ initialSyncComplete: true, initialPageToken: null });
    this.log('Initial sync complete');
  }

  async incrementalSync() {
    const startId = this.store.state.historyId;
    this.setStatus({ phase: 'incremental', done: 0, total: 0, message: 'Checking for new mail' });
    const added = new Map();
    let latestHistoryId = startId;
    try {
      let pageToken;
      do {
        const res = await this.gmail.history(startId, pageToken);
        for (const h of res.history || []) {
          for (const m of h.messagesAdded || []) added.set(m.message.id, m.message);
        }
        latestHistoryId = res.historyId || latestHistoryId;
        pageToken = res.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (e.status !== 404) throw e;
      // History ids expire after about a week offline: fall back to a date-based scan.
      this.log('Gmail history expired; scanning recent mail instead');
      const since = this.store.state.lastSyncAt ? new Date(this.store.state.lastSyncAt) : new Date(Date.now() - 7 * 86400000);
      const after = Math.floor(since.getTime() / 1000) - 86400;
      for await (const page of this.gmail.iterateMessageIds({ q: `${this.baseQuery()} after:${after}` })) {
        page.messages.forEach((m) => added.set(m.id, m));
      }
      latestHistoryId = (await this.gmail.profile()).historyId;
    }

    const ids = [...added.keys()].filter((id) => !this.store.isProcessed(id));
    if (ids.length) this.log(`${ids.length} new message(s) to process`);
    let done = 0;
    this.setStatus({ total: ids.length, message: ids.length ? 'Processing new mail' : 'Up to date' });
    await this.runPool(ids, async (id) => {
      await this.processMessage(id, 'new');
      this.setStatus({ done: ++done });
    });
    if (!this.stopRequested) this.store.saveState({ historyId: latestHistoryId });
  }

  async runPool(items, worker) {
    let i = 0;
    const next = async () => {
      while (i < items.length && !this.stopRequested) {
        const item = items[i++];
        try {
          await worker(item);
          if (this.trashQueue.length >= TRASH_BATCH) await this.flushTrash();
        } catch (e) {
          this.bumpTotal('errors');
          this.log(`Error on message ${item}: ${e.message}`);
          if (/Not signed in|invalid_grant/.test(e.message)) {
            this.stopRequested = true;
            throw e;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, next));
    await this.flushTrash();
  }

  bumpTotal(key, n = 1) {
    const totals = { ...this.store.state.totals };
    totals[key] = (totals[key] || 0) + n;
    this.store.saveState({ totals });
  }

  /**
   * @param {string} id Gmail message id
   * @param {'initial'|'new'|'rule'} mode
   * @param {object} [opts] { rules: override rule list (for "run rule now") }
   */
  async processMessage(id, mode, opts = {}) {
    const cfg = this.store.settings.sync;
    const existing = this.store.processed.get(id);

    if (mode === 'new' || mode === 'initial') {
      if (existing) return { status: 'already' };
      const minimal = await this.gmail.request('GET', `/messages/${id}`, { query: { format: 'minimal' } });
      const labels = minimal.labelIds || [];
      if (labels.includes('DRAFT')) return { status: 'draft' }; // drafts change; not recorded
      if (labels.includes('TRASH') || (cfg.excludeSpam && labels.includes('SPAM'))) return { status: 'excluded' };
      const isSent = labels.includes('SENT') && !labels.includes('INBOX');
      if (isSent && !cfg.archiveSent) {
        this.store.record(id, 'ignored-sent');
        return { status: 'ignored-sent' };
      }
      if (mode === 'new' && !isSent && cfg.newMailUnreadOnly && !labels.includes('UNREAD')) {
        this.store.record(id, 'ignored-read');
        this.bumpTotal('ignored');
        this.log(`Ignored (already read in Gmail): ${id}`);
        return { status: 'ignored-read' };
      }
    }

    const msg = await this.gmail.getRaw(id);
    const parsed = await parseRaw(msg.raw, { internalDate: msg.internalDate });
    const labelNames = msg.labelIds.map((l) => this.labelMap.get(l)?.name || l);
    const isSent = msg.labelIds.includes('SENT') && !msg.labelIds.includes('INBOX');
    const unread = msg.labelIds.includes('UNREAD');
    const ctx = {
      from: parsed.from.name ? `${parsed.from.name} <${parsed.from.address}>` : parsed.from.address,
      fromAddress: parsed.from.address,
      to: parsed.to.map((r) => `${r.name} <${r.address}>`).join(', '),
      cc: parsed.cc.map((r) => `${r.name} <${r.address}>`).join(', '),
      subject: parsed.subject,
      body: parsed.text || '',
      labels: labelNames,
      hasAttachment: parsed.attachments.some((a) => !a.inline),
      isNewsletter: /^list-unsubscribe:/im.test(parsed.headers) || /^list-id:/im.test(parsed.headers),
      unread,
      date: parsed.receivedDate,
      sizeKB: msg.raw.length / 1024,
    };
    const plan = rulesEngine.evaluate(opts.rules || this.store.rules, ctx);
    const tag = plan.matched.length ? ` [rule: ${plan.matched.join(', ')}]` : '';
    // Gmail search only narrows candidates; when running a single rule, act only on real matches.
    if (mode === 'rule' && !plan.matched.length) return { status: 'no-match' };

    if (plan.skip) {
      if (mode !== 'rule') this.store.record(id, 'skipped');
      this.log(`Skipped by rule: ${parsed.subject}${tag}`);
      return { status: 'skipped', plan };
    }

    const starred = msg.labelIds.includes('STARRED');
    const keepStarred = starred && cfg.keepStarredInGmail !== false;
    if (plan.deleteOnly && keepStarred) {
      // Starred mail is never removed from Gmail; archive a copy instead of deleting it.
      this.log(`Starred, so not trashed (archiving a copy instead): ${parsed.subject}${tag}`);
      plan.deleteOnly = false;
      plan.gmail = 'keep';
    }

    if (plan.deleteOnly) {
      if (!cfg.trashingEnabled) {
        this.log(`Would trash (trashing disabled in Settings): ${parsed.subject}${tag}`);
        return { status: 'trash-disabled', plan };
      }
      await this.gmail.trash(id);
      this.store.record(id, 'deleted');
      this.bumpTotal('trashed');
      this.log(`Moved to Gmail Trash without archiving: ${parsed.subject}${tag}`);
      return { status: 'deleted', plan };
    }

    // File into the PST (or, for an already-archived message, move it to the rule's folder).
    const { folder, categories } = this.folderFor(msg.labelIds, plan);
    let entryId = existing?.entryId;
    if (existing && mode === 'rule') {
      // Already in the PST: move it if the rule says so (entries from the old Outlook-based version
      // have no PST id and are left where they are).
      if (/^\d+$/.test(entryId || '') && plan.folder && plan.folder !== existing.folder) {
        await this.mailbox.call('moveItems', { ids: [Number(entryId)], folderPath: folder });
      }
    } else {
      if (cfg.keepEmlBackup) this.writeBackup(id, parsed.receivedDate, msg.raw);
      const res = await this.mailbox.call('addMessage', {
        folderPath: folder,
        message: {
          ...parsed,
          unread: unread && !plan.markRead,
          flagged: plan.flag || starred,
          categories,
          rawSize: msg.raw.length,
        },
      });
      entryId = String(res.id);
      this.bumpTotal('downloaded');
    }
    // Record before trashing: if we crash in between, the message simply stays in Gmail.
    this.store.record(id, 'archived', entryId, folder);

    let trash;
    if (plan.gmail === 'trash') trash = true;
    else if (plan.gmail === 'keep') trash = false;
    else if (mode === 'initial') trash = cfg.trashDuringInitialSync && (!isSent || cfg.trashSent);
    else if (mode === 'new') trash = isSent ? cfg.trashSent : cfg.trashNewMail;
    else trash = false;
    if (keepStarred) trash = false; // overrides rules and sync settings

    if (trash && cfg.trashingEnabled) this.trashQueue.push({ id, entryId, folder });
    const kept = keepStarred ? ' (starred: kept in Gmail)' : '';
    this.log(`${trash && cfg.trashingEnabled ? 'Archived + trashed' : 'Archived'}${kept} → ${folder}: ${parsed.subject}${tag}`);
    return { status: 'archived', folder, trashed: !!(trash && cfg.trashingEnabled), plan };
  }

  folderFor(labelIds, plan) {
    const userLabels = labelIds
      .map((id) => this.labelMap.get(id))
      .filter((l) => l && l.type === 'user')
      .map((l) => l.name)
      .sort((a, b) => a.localeCompare(b));
    const categories = [...plan.categories];
    for (const id of labelIds) if (CATEGORY_LABELS[id]) categories.push(CATEGORY_LABELS[id]);

    let folder = plan.folder;
    if (!folder) {
      if (userLabels.length) folder = userLabels[0];
      else if (labelIds.includes('INBOX')) folder = SYSTEM_FOLDERS.INBOX;
      else if (labelIds.includes('SENT')) folder = SYSTEM_FOLDERS.SENT;
      else folder = 'Archive';
    }
    // Remaining Gmail labels become Outlook categories so nothing is lost.
    for (const l of userLabels) if (l !== folder && !categories.includes(l)) categories.push(l);
    return { folder, categories: [...new Set(categories)] };
  }

  writeBackup(id, date, raw) {
    const d = new Date(date);
    const dir = path.join(this.store.settings.sync.emlBackupDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.eml`), raw);
  }

  // ---------- Rules against mail already in Gmail ----------

  async previewRule(rule, limit = 25) {
    await this.refreshLabels();
    const q = rulesEngine.toGmailQuery(rule);
    const query = `${this.baseQuery()} ${q || ''}`.trim();
    const res = await this.gmail.listMessages({ q: query, maxResults: 200 });
    const ids = (res.messages || []).map((m) => m.id);
    const sample = [];
    for (const id of ids) {
      if (sample.length >= limit) break;
      const meta = await this.gmail.getMetadata(id);
      const h = Object.fromEntries((meta.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      const ctx = {
        from: h.from || '',
        fromAddress: (h.from || '').match(/<([^>]+)>/)?.[1] || h.from || '',
        to: h.to || '',
        cc: h.cc || '',
        subject: h.subject || '',
        body: meta.snippet || '',
        labels: (meta.labelIds || []).map((l) => this.labelMap.get(l)?.name || l),
        hasAttachment: false,
        isNewsletter: !!h['list-unsubscribe'],
        unread: (meta.labelIds || []).includes('UNREAD'),
        date: new Date(Number(meta.internalDate)),
        sizeKB: (meta.sizeEstimate || 0) / 1024,
      };
      // hasAttachment can't be judged from metadata; trust Gmail's has:attachment for it.
      const local = { ...rule, conditions: rule.conditions.filter((c) => c.field !== 'hasAttachment' && c.field !== 'body') };
      if (local.conditions.length && !rulesEngine.ruleMatches(local, ctx)) continue;
      sample.push({ id, from: ctx.from, subject: ctx.subject, date: ctx.date.toISOString(), archived: this.store.isProcessed(id) });
    }
    return { query, estimate: res.resultSizeEstimate || 0, hasMore: !!res.nextPageToken, sample };
  }

  runRuleNow(rule) {
    if (this.running) throw new Error('A sync is already running. Wait for it to finish or pause it.');
    this.stopRequested = false;
    this.running = (async () => {
      try {
        await this.refreshLabels();
        const q = rulesEngine.toGmailQuery(rule);
        const query = `${this.baseQuery()} ${q || ''}`.trim();
        this.log(`Running rule "${rule.name}" on Gmail (${query})`);
        const ids = [];
        for await (const page of this.gmail.iterateMessageIds({ q: query })) ids.push(...page.messages.map((m) => m.id));
        this.setStatus({ phase: 'rule', done: 0, total: ids.length, message: `Rule: ${rule.name}` });
        let done = 0;
        const counts = {};
        await this.runPool(ids, async (id) => {
          const r = await this.processMessage(id, 'rule', { rules: [{ ...rule, enabled: true, stopProcessing: true }] });
          counts[r.status] = (counts[r.status] || 0) + 1;
          this.setStatus({ done: ++done });
        });
        await this.flushTrash();
        this.log(`Rule "${rule.name}" finished: ${JSON.stringify(counts)}`);
        this.setStatus({ phase: 'idle', message: `Rule finished (${done} messages)` });
        return counts;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

module.exports = { SyncEngine };
