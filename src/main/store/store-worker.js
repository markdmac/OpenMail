'use strict';
// Worker thread that owns the open PST. All mailbox reads and writes go through here so long-running
// work (imports, big folder rewrites) never blocks the Electron main process.

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { PstStore, P, tableNid } = require('../pst/pst-store');
const { checkPst } = require('../pst/pst-check');
const { importPst } = require('./pst-import');
const { NID_TYPE } = require('../pst/constants');

let store = null;
let storePath = null;
let pendingCommit = null;
let opsSinceCommit = 0;

const emit = (event, data) => parentPort.postMessage({ event, data });

function friendlyOpenError(e, file) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    return new Error(`The mailbox file is in use by another program (usually Outlook). Close "${path.basename(file)}" in Outlook (right-click it → Close) and try again.`);
  }
  return e;
}

function requireStore() {
  if (!store) throw new Error('Mailbox is not open');
  return store;
}

function scheduleCommit() {
  opsSinceCommit++;
  if (opsSinceCommit >= 200) return commitNow();
  if (pendingCommit) clearTimeout(pendingCommit);
  pendingCommit = setTimeout(commitNow, 1500);
}

function commitNow() {
  if (pendingCommit) clearTimeout(pendingCommit);
  pendingCommit = null;
  opsSinceCommit = 0;
  if (store && store.ndb.txn) {
    try {
      store.commit();
    } catch (e) {
      emit('error', `Saving the mailbox failed: ${e.message}`);
      try {
        store.ndb.rollback();
        store.tcCache.clear();
        store.dirtyTables.clear();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}

// ------------------------------------------------------------------ folder helpers
function folderNid(p) {
  const s = requireStore();
  if (!p) return s.ipmSubtree;
  const nid = s.findFolderByPath(p, false);
  if (!nid) throw new Error(`Folder not found: ${p}`);
  return nid;
}

function pathOf(nid) {
  const s = requireStore();
  const parts = [];
  let cur = nid;
  for (let guard = 0; cur && cur !== s.ipmSubtree && guard < 64; guard++) {
    const f = s.getFolder(cur);
    parts.unshift(f.name);
    cur = f.parent;
  }
  return parts.join('/');
}

function folderTree() {
  const s = requireStore();
  const map = (nodes) => nodes.map((f) => ({ id: f.nid, name: f.name, path: f.path, count: f.count, unread: f.unread, isDeletedItems: f.nid === s.wastebasket, children: map(f.children) }));
  return { name: s.displayName, wastebasketPath: pathOf(s.wastebasket), children: map(s.folderTree()) };
}

// ------------------------------------------------------------------ listing (sort / search / paging)
const SORTS = {
  date: (m) => (m.date ? m.date.getTime() : 0),
  from: (m) => (m.from || '').toLowerCase(),
  subject: (m) => (m.subject || '').replace(/^((re|fw|fwd|aw|wg|sv):\s*)+/i, '').toLowerCase(),
  size: (m) => m.size || 0,
};

function listItems({ folderPath, offset = 0, limit = 200, sort = 'date', dir = 'desc', search = '', unreadOnly = false }) {
  const s = requireStore();
  let items = s.listMessages(folderNid(folderPath));
  if (unreadOnly) items = items.filter((m) => m.unread);
  if (search) {
    const q = search.toLowerCase();
    items = items.filter((m) => (m.subject || '').toLowerCase().includes(q) || (m.from || '').toLowerCase().includes(q) || (m.to || '').toLowerCase().includes(q));
  }
  const key = SORTS[sort] || SORTS.date;
  const sign = dir === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -sign;
    if (ka > kb) return sign;
    return (SORTS.date(b) - SORTS.date(a)) || 0; // tie-break: newest first
  });
  const total = items.length;
  const page = items.slice(offset, offset + limit).map((m) => ({
    id: m.nid,
    subject: m.subject,
    from: m.from,
    to: m.to,
    date: m.date ? m.date.toISOString() : null,
    unread: m.unread,
    size: m.size,
    hasAttachments: m.hasAttachments,
    importance: m.importance,
  }));
  // Sender summary for "group by sender" and "select all from sender".
  const senders = sort === 'from' ? countSenders(items) : null;
  return { total, offset, items: page, senders };
}

function countSenders(items) {
  const counts = new Map();
  for (const m of items) counts.set(m.from || '', (counts.get(m.from || '') || 0) + 1);
  return Object.fromEntries(counts);
}

/** IDs of every message in a folder from a given sender (for bulk actions on a sender group). */
function idsFromSender({ folderPath, from }) {
  const s = requireStore();
  return s.listMessages(folderNid(folderPath)).filter((m) => (m.from || '') === (from || '')).map((m) => m.nid);
}

// ------------------------------------------------------------------ messages
function getItem({ id }) {
  const s = requireStore();
  const m = s.getMessage(id);
  const inlineImages = {};
  for (const a of m.attachments) {
    if (a.contentId && a.size < 5 * 1024 * 1024 && m.html.includes(`cid:${a.contentId}`)) {
      try {
        const data = s.getAttachmentData(id, a.nid);
        const mime = a.mimeType || guessMime(a.filename);
        inlineImages[a.contentId] = `data:${mime};base64,${data.toString('base64')}`;
      } catch {
        /* skip unreadable inline image */
      }
    }
  }
  const toStr = (type) => m.recipients.filter((r) => r.type === type).map((r) => (r.name && r.address && r.name !== r.address ? `${r.name} <${r.address}>` : r.address || r.name)).join('; ');
  return {
    id,
    subject: m.subject,
    from: m.from,
    fromAddress: m.fromAddress,
    to: toStr(1) || m.to,
    cc: toStr(2) || m.cc,
    bcc: toStr(3) || m.bcc,
    date: m.date ? m.date.toISOString() : null,
    sent: m.sent ? m.sent.toISOString() : null,
    html: m.html,
    text: m.text,
    unread: m.unread,
    flagged: m.flagged,
    importance: m.importance,
    categories: m.categories.join(', '),
    messageId: m.messageId,
    headers: m.headers,
    folderPath: pathOf(m.folder),
    attachments: m.attachments.filter((a) => !a.hidden).map((a) => ({ id: a.nid, name: a.filename, size: a.size })),
    inlineImages,
  };
}

function guessMime(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  return { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'application/octet-stream';
}

function moveItems({ ids, folderPath }) {
  const s = requireStore();
  const dest = s.findFolderByPath(folderPath, true);
  for (const id of ids) s.moveMessage(id, dest);
  scheduleCommit();
  return { ids };
}

/** Outlook semantics: delete moves to Deleted Items; deleting inside Deleted Items is permanent. */
function deleteItems({ ids }) {
  const s = requireStore();
  let moved = 0;
  let removed = 0;
  for (const id of ids) {
    const node = s.ndb.getNode(id);
    if (!node) continue;
    if (node.nidParent === s.wastebasket) {
      s.deleteMessage(id);
      removed++;
    } else {
      s.moveMessage(id, s.wastebasket);
      moved++;
    }
  }
  scheduleCommit();
  return { moved, removed };
}

function emptyDeletedItems() {
  const s = requireStore();
  for (const m of s.listMessages(s.wastebasket)) s.deleteMessage(m.nid);
  for (const child of s.childFolders(s.wastebasket)) s.deleteFolder(child);
  commitNow();
  return true;
}

// ------------------------------------------------------------------ commands
const handlers = {
  open({ pstPath, displayName }) {
    if (store) {
      commitNow();
      store.close();
      store = null;
    }
    try {
      if (!fs.existsSync(pstPath)) {
        fs.mkdirSync(path.dirname(pstPath), { recursive: true });
        store = PstStore.create(pstPath, { displayName: displayName || 'OpenMail' });
      } else {
        store = PstStore.open(pstPath);
      }
    } catch (e) {
      // Old ANSI PSTs can't be written; open them read-only so they can be viewed and converted.
      if (/ANSI/.test(e.message)) {
        store = PstStore.open(pstPath, { readOnly: true });
      } else {
        throw friendlyOpenError(e, pstPath);
      }
    }
    storePath = pstPath;
    return handlers.info();
  },
  info() {
    const s = requireStore();
    return { path: storePath, displayName: s.displayName, unicode: s.isUnicode, readOnly: s.readOnly, size: fs.statSync(storePath).size };
  },
  close() {
    if (store) {
      commitNow();
      store.close();
    }
    store = null;
    return true;
  },
  commit() {
    commitNow();
    return true;
  },
  folders: () => folderTree(),
  ensureFolder({ path: p }) {
    const nid = requireStore().findFolderByPath(p, true);
    scheduleCommit();
    return { id: nid };
  },
  renameFolder({ path: p, newName }) {
    requireStore().renameFolder(folderNid(p), newName);
    scheduleCommit();
    return true;
  },
  deleteFolder({ path: p }) {
    const s = requireStore();
    const nid = folderNid(p);
    // Like Outlook: folders go to Deleted Items first; deleting inside Deleted Items is permanent.
    let inWaste = false;
    for (let cur = nid, guard = 0; cur && guard < 64; guard++) {
      if (cur === s.wastebasket) inWaste = true;
      if (cur === s.ipmSubtree) break;
      cur = s.getFolder(cur).parent;
    }
    if (inWaste) s.deleteFolder(nid);
    else s.moveFolder(nid, s.wastebasket);
    scheduleCommit();
    return true;
  },
  moveFolder({ path: p, newParentPath }) {
    const s = requireStore();
    s.moveFolder(folderNid(p), newParentPath ? s.findFolderByPath(newParentPath, true) : s.ipmSubtree);
    scheduleCommit();
    return true;
  },
  listItems,
  idsFromSender,
  getItem,
  setRead({ ids, read }) {
    const s = requireStore();
    for (const id of ids) s.setRead(id, read);
    scheduleCommit();
    return true;
  },
  setFlag({ ids, flagged }) {
    const s = requireStore();
    for (const id of ids) s.setFlag(id, flagged);
    scheduleCommit();
    return true;
  },
  setCategories({ ids, categories }) {
    const s = requireStore();
    for (const id of ids) s.setCategories(id, categories);
    scheduleCommit();
    return true;
  },
  moveItems,
  deleteItems,
  emptyDeletedItems,
  saveAttachment({ id, attachmentId, path: dest }) {
    fs.writeFileSync(dest, requireStore().getAttachmentData(id, attachmentId));
    return { path: dest };
  },
  /** Adds one message; returns its id. Callers that must not lose data call commit afterwards. */
  addMessage({ folderPath, message }) {
    const s = requireStore();
    if (s.readOnly) throw new Error('This mailbox is in the old ANSI format and is read-only. Convert it first (Settings → Mailbox).');
    const folder = s.findFolderByPath(folderPath || 'Inbox', true);
    // Buffers arrive as Uint8Arrays after crossing the thread boundary.
    for (const a of message.attachments || []) if (a.content && !Buffer.isBuffer(a.content)) a.content = Buffer.from(a.content);
    for (const k of ['date', 'receivedDate']) if (message[k] && !(message[k] instanceof Date)) message[k] = new Date(message[k]);
    const id = s.addMessage(folder, message);
    scheduleCommit();
    return { id, folderPath };
  },
  /** Recipients of recent messages in Sent Items, used once to seed compose autocomplete. */
  sentRecipients({ limit = 3000 } = {}) {
    const s = requireStore();
    const sent = s.findFolderByPath('Sent Items', false);
    if (!sent) return [];
    const msgs = s.listMessages(sent).sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0)).slice(0, limit);
    const out = [];
    for (const m of msgs) {
      try {
        for (const r of s.getMessage(m.nid).recipients) {
          if (r.address && r.address.includes('@')) out.push({ name: r.name && r.name !== r.address ? r.name : '', address: r.address.toLowerCase(), date: m.date ? m.date.toISOString() : null });
        }
      } catch {
        /* skip unreadable messages */
      }
    }
    return out;
  },
  importPst({ path: src, targetPrefix = '', skipDuplicates = true }) {
    const s = requireStore();
    const result = importPst(s, src, {
      targetPrefix,
      skipDuplicates,
      onProgress: (p) => emit('import-progress', p),
      commitEvery: 100,
      commit: commitNow,
    });
    commitNow();
    return result;
  },
  check() {
    commitNow();
    const s = requireStore();
    s.close();
    try {
      return checkPst(storePath);
    } finally {
      store = PstStore.open(storePath, { readOnly: !s.isUnicode });
    }
  },
};

parentPort.on('message', async ({ id, cmd, args }) => {
  try {
    const h = handlers[cmd];
    if (!h) throw new Error(`Unknown store command ${cmd}`);
    const result = await h(args || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message, stack: e.stack });
  }
});
