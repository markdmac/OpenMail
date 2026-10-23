'use strict';
// Local persistence: settings, sync state, rules, encrypted tokens, and the processed-message ledger.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  google: { clientId: '', clientSecret: '' },
  pstPath: '',
  pstDisplayName: 'OpenMail Archive',
  pollMinutes: 5,
  // Backup copy of the mailbox, made when OpenMail closes (if switched on for that session).
  backup: { folder: '', keep: 3 },
  // Email signature (HTML), added automatically to new messages and/or replies and forwards.
  signature: { html: '', newMessages: true, replies: true },
  sync: {
    // Safety switch: nothing is ever trashed in Gmail until the user turns this on in Settings.
    trashingEnabled: false,
    // Initial sync copies the whole mailbox; trashing during it is opt-in.
    trashDuringInitialSync: false,
    // After the initial sync: messages that are already read when first seen stay in Gmail and are ignored.
    newMailUnreadOnly: true,
    trashNewMail: true,
    // Sent mail is never "unread"; archive it to Sent Items but leave it in Gmail by default.
    archiveSent: true,
    trashSent: false,
    // Keep a raw .eml copy of every downloaded message as an extra safety net.
    keepEmlBackup: true,
    emlBackupDir: '',
    excludeSpam: true,
    // Starred messages are copied to the mailbox but never moved to Gmail Trash.
    keepStarredInGmail: true,
    // How messages with several Gmail labels are filed: 'first' label is the folder, the rest become categories.
    labelMode: 'first',
  },
};

const DEFAULT_STATE = {
  initialSyncComplete: false,
  initialPageToken: null,
  initialStartedAt: null,
  historyId: null,
  lastSyncAt: null,
  totals: { downloaded: 0, trashed: 0, ignored: 0, errors: 0 },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    fs.mkdirSync(this.dir, { recursive: true });
    this.files = {
      settings: path.join(this.dir, 'settings.json'),
      state: path.join(this.dir, 'sync-state.json'),
      rules: path.join(this.dir, 'rules.json'),
      tokens: path.join(this.dir, 'tokens.bin'),
      ledger: path.join(this.dir, 'processed.log'),
    };
    const docs = app.getPath('documents');
    const defaults = deepMerge(DEFAULT_SETTINGS, {
      pstPath: path.join(docs, 'OpenMail', 'Mailbox.pst'),
      sync: { emlBackupDir: path.join(docs, 'OpenMail', 'eml-backup') },
    });
    this.settings = deepMerge(defaults, readJson(this.files.settings, {}));
    this.state = deepMerge(DEFAULT_STATE, readJson(this.files.state, {}));
    this.rules = readJson(this.files.rules, []);
    this.processed = this.loadLedger();
  }

  saveSettings(patch) {
    this.settings = deepMerge(this.settings, patch);
    writeJsonAtomic(this.files.settings, this.settings);
    return this.settings;
  }

  saveState(patch) {
    this.state = deepMerge(this.state, patch);
    writeJsonAtomic(this.files.state, this.state);
    return this.state;
  }

  saveRules(rules) {
    this.rules = rules;
    writeJsonAtomic(this.files.rules, rules);
    return rules;
  }

  // ---- OAuth tokens (encrypted with Windows DPAPI via Electron safeStorage) ----
  saveTokens(tokens) {
    const json = JSON.stringify(tokens);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
    fs.writeFileSync(this.files.tokens, data);
  }

  loadTokens() {
    if (!fs.existsSync(this.files.tokens)) return null;
    const data = fs.readFileSync(this.files.tokens);
    try {
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  clearTokens() {
    if (fs.existsSync(this.files.tokens)) fs.unlinkSync(this.files.tokens);
  }

  // ---- Ledger: every Gmail message we have handled, so we never process (or re-trash) it twice ----
  loadLedger() {
    const map = new Map();
    if (!fs.existsSync(this.files.ledger)) return map;
    for (const line of fs.readFileSync(this.files.ledger, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const [gmailId, status, entryId, folder] = line.split('\t');
      map.set(gmailId, { status, entryId, folder });
    }
    return map;
  }

  record(gmailId, status, entryId = '', folder = '') {
    this.processed.set(gmailId, { status, entryId, folder });
    fs.appendFileSync(this.files.ledger, `${gmailId}\t${status}\t${entryId}\t${folder}\n`);
  }

  isProcessed(gmailId) {
    return this.processed.has(gmailId);
  }

  resetSync() {
    this.saveState({ ...DEFAULT_STATE });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { Store };
