'use strict';
// Remembers addresses you have sent mail to, for autocomplete in the compose window.
// Stored locally in recipients.json; ranked by how often and how recently each address was used.

const fs = require('fs');
const addressparser = require('nodemailer/lib/addressparser');

const MAX_ENTRIES = 5000;

// Addresses that belong to automated systems (Gmail's one-click unsubscribe "sends" mail to these).
const AUTOMATED = /^(unsubscribe|unsub|no-?reply|do-?not-?reply|donotreply|bounces?|mailer-daemon|postmaster|list-?unsubscribe)([+._-]|@)|unsubscribe/i;
function isLikelyAutomated(address) {
  return AUTOMATED.test(String(address).split('@')[0] + '@');
}

/** Parses "Name <a@b.com>; c@d.com, ..." into [{name, address}] (lower-cased addresses, deduplicated). */
function parseAddresses(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const walk = (list) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address && /@/.test(a.address)) {
        const address = a.address.trim().toLowerCase();
        if (seen.has(address)) continue;
        seen.add(address);
        out.push({ name: (a.name || '').trim(), address });
      }
    }
  };
  walk(addressparser(String(text).replace(/;/g, ',')));
  return out;
}

class RecipientBook {
  constructor(file) {
    this.file = file;
    this.data = { seeded: false, entries: {} };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* first run */
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /** Records that mail was sent to these recipients. */
  add(recipients, when = new Date(), { save = true } = {}) {
    const t = new Date(when).getTime() || Date.now();
    for (const r of recipients) {
      if (!r.address) continue;
      const e = this.data.entries[r.address] || { address: r.address, name: '', count: 0, last: 0 };
      e.count += 1;
      if (t >= e.last) {
        e.last = t;
        if (r.name) e.name = r.name; // the most recent display name wins
      } else if (!e.name && r.name) {
        e.name = r.name;
      }
      this.data.entries[r.address] = e;
    }
    this.trim();
    if (save) this.save();
  }

  addFromFields(fields, when) {
    this.add([].concat(...fields.map(parseAddresses)), when);
  }

  forget(address) {
    delete this.data.entries[String(address).toLowerCase()];
    this.save();
  }

  trim() {
    const all = Object.values(this.data.entries);
    if (all.length <= MAX_ENTRIES) return;
    for (const e of this.rank(all).slice(MAX_ENTRIES)) delete this.data.entries[e.address];
  }

  /** Most useful first: frequent and recent addresses score highest. */
  rank(list) {
    const now = Date.now();
    const score = (e) => Math.log2(1 + e.count) * 10 - (now - e.last) / (30 * 86400000);
    return [...list].sort((a, b) => score(b) - score(a));
  }

  list() {
    return this.rank(Object.values(this.data.entries));
  }
}

module.exports = { RecipientBook, parseAddresses, isLikelyAutomated };
