'use strict';
// [MS-PST] Messaging layer: the message store, folders, messages, recipients and attachments.
// This is the API the rest of OpenMail uses; it reads any PST (Unicode or ANSI) and writes Unicode PSTs.

const crypto = require('crypto');
const { Ndb } = require('./ndb-writer');
const { readPC, readTC, buildPC, buildTC } = require('./ltp');
const { NamedPropMap, PS_PUBLIC_STRINGS } = require('./named-props');
const { NID, NID_TYPE, PT } = require('./constants');

const P = {
  IMPORTANCE: 0x0017,
  MESSAGE_CLASS: 0x001a,
  SENSITIVITY: 0x0036,
  SUBJECT: 0x0037,
  CLIENT_SUBMIT_TIME: 0x0039,
  SENT_REPRESENTING_NAME: 0x0042,
  MESSAGE_TO_ME: 0x0057,
  MESSAGE_CC_ME: 0x0058,
  SENT_REPRESENTING_EMAIL: 0x0065,
  SENT_REPRESENTING_ADDRTYPE: 0x0064,
  CONVERSATION_TOPIC: 0x0070,
  CONVERSATION_INDEX: 0x0071,
  TRANSPORT_HEADERS: 0x007d,
  RECIPIENT_TYPE: 0x0c15,
  SENDER_NAME: 0x0c1a,
  SENDER_ADDRTYPE: 0x0c1e,
  SENDER_EMAIL: 0x0c1f,
  DISPLAY_BCC: 0x0e02,
  DISPLAY_CC: 0x0e03,
  DISPLAY_TO: 0x0e04,
  MESSAGE_DELIVERY_TIME: 0x0e06,
  MESSAGE_FLAGS: 0x0e07,
  MESSAGE_SIZE: 0x0e08,
  RESPONSIBILITY: 0x0e0f,
  MESSAGE_STATUS: 0x0e17,
  HASATTACH: 0x0e1b,
  NORMALIZED_SUBJECT: 0x0e1d,
  ATTACH_SIZE: 0x0e20,
  ATTACH_NUM: 0x0e21,
  RECORD_KEY: 0x0ff9,
  OBJECT_TYPE: 0x0ffe,
  ENTRY_ID: 0x0fff,
  BODY: 0x1000,
  HTML: 0x1013,
  INTERNET_MESSAGE_ID: 0x1035,
  INTERNET_REFERENCES: 0x1039,
  IN_REPLY_TO: 0x1042,
  FLAG_STATUS: 0x1090,
  DISPLAY_NAME: 0x3001,
  ADDRTYPE: 0x3002,
  EMAIL_ADDRESS: 0x3003,
  COMMENT: 0x3004,
  CREATION_TIME: 0x3007,
  LAST_MODIFICATION_TIME: 0x3008,
  SEARCH_KEY: 0x300b,
  VALID_FOLDER_MASK: 0x35df,
  IPM_SUBTREE_ENTRYID: 0x35e0,
  IPM_WASTEBASKET_ENTRYID: 0x35e3,
  FINDER_ENTRYID: 0x35e7,
  CONTENT_COUNT: 0x3602,
  CONTENT_UNREAD: 0x3603,
  SUBFOLDERS: 0x360a,
  CONTAINER_CLASS: 0x3613,
  ATTACH_DATA: 0x3701,
  ATTACH_EXTENSION: 0x3703,
  ATTACH_FILENAME: 0x3704,
  ATTACH_METHOD: 0x3705,
  ATTACH_LONG_FILENAME: 0x3707,
  RENDERING_POSITION: 0x370b,
  ATTACH_MIME_TAG: 0x370e,
  ATTACH_CONTENT_ID: 0x3712,
  ATTACH_FLAGS: 0x3714,
  DISPLAY_TYPE: 0x3900,
  SMTP_ADDRESS: 0x39fe,
  DISPLAY_NAME_7BIT: 0x39ff,
  SEND_RICH_INFO: 0x3a40,
  INTERNET_CPID: 0x3fde,
  MESSAGE_CODEPAGE: 0x3ffd,
  SENDER_SMTP: 0x5d01,
  SENT_REPRESENTING_SMTP: 0x5d02,
  ROW_ID: 0x67f2,
  ROW_VER: 0x67f3,
  ATTACHMENT_HIDDEN: 0x7ffe,
};

const MSGFLAG_READ = 0x01;
const MSGFLAG_UNSENT = 0x08;
const MSGFLAG_HASATTACH = 0x10;
const MSGFLAG_FROMME = 0x20;

const nidType = (nid) => nid & 0x1f;
const makeNid = (type, index) => ((index << 5) | type) >>> 0;
const tableNid = (folderNid, type) => ((folderNid & ~0x1f) | type) >>> 0;

/** Property bag helper: Map(id → {type, value}) with typed getters. */
function bag(props) {
  return {
    props,
    get: (id) => props.get(id)?.value,
    has: (id) => props.has(id),
  };
}

class PstStore {
  /**
   * Opens an existing PST.
   * @param {string} file
   * @param {{readOnly?: boolean}} [opts]
   */
  static open(file, opts = {}) {
    const ndb = Ndb.open(file, opts);
    return new PstStore(ndb);
  }

  /** Creates a new, empty Unicode PST (structure mirrors one freshly created by Outlook). */
  static create(file, { displayName = 'OpenMail' } = {}) {
    require('./pst-create').createPstFile(file, displayName);
    return PstStore.open(file);
  }

  constructor(ndb) {
    this.ndb = ndb;
    this.tcCache = new Map(); // nid → table model (rows kept in memory between commits)
    this.dirtyTables = new Set();
    this.dirtyFolders = new Set();
    const store = readPC(ndb, ndb.getNode(NID.MESSAGE_STORE)).props;
    this.storeProps = store;
    this.recordKey = store.get(P.RECORD_KEY)?.value || Buffer.alloc(16);
    this.displayName = store.get(P.DISPLAY_NAME)?.value || '';
    this.ipmSubtree = this.nidFromEntryId(store.get(P.IPM_SUBTREE_ENTRYID)?.value) || 0x8022;
    this.wastebasket = this.nidFromEntryId(store.get(P.IPM_WASTEBASKET_ENTRYID)?.value) || 0x8062;
    this._named = null;
  }

  get readOnly() {
    return this.ndb.readOnly;
  }

  get isUnicode() {
    return this.ndb.fmt.unicode;
  }

  close() {
    if (this.ndb.txn) this.commit();
    this.ndb.close();
  }

  // ------------------------------------------------------------------ helpers
  nidFromEntryId(eid) {
    if (!Buffer.isBuffer(eid) || eid.length < 24) return 0;
    return eid.readUInt32LE(20);
  }

  entryIdFor(nid) {
    const b = Buffer.alloc(24);
    this.recordKey.copy(b, 4);
    b.writeUInt32LE(nid >>> 0, 20);
    return b;
  }

  get named() {
    if (!this._named) this._named = new NamedPropMap(readPC(this.ndb, this.ndb.getNode(NID.NAME_TO_ID_MAP)).props);
    return this._named;
  }

  /** PidNameKeywords (Outlook categories). */
  get keywordsPropId() {
    return this.named.idFor(PS_PUBLIC_STRINGS, 'Keywords', !this.readOnly);
  }

  stringType() {
    return this.isUnicode ? PT.UNICODE : PT.STRING8;
  }

  allocNid(type) {
    const h = this.ndb.header;
    // rgnid holds the last index handed out for each NID type.
    const index = h.rgnid[type] + 1;
    h.rgnid[type] = index;
    return makeNid(type, index);
  }

  // ------------------------------------------------------------------ store
  setDisplayName(name) {
    this.ndb.begin();
    const props = [...this.storeProps].map(([id, p]) => ({ id, type: p.type, value: id === P.DISPLAY_NAME ? name : p.value }));
    this.writePCNode(NID.MESSAGE_STORE, 0, props, null);
    this.storeProps = readPC(this.ndb, this.ndb.getNode(NID.MESSAGE_STORE)).props;
    this.displayName = name;
    // The IPM subtree folder name is what Outlook shows as the top of the store.
    const f = this.folderProps(this.ipmSubtree);
    this.updateFolderProps(this.ipmSubtree, { [P.DISPLAY_NAME]: name }, f);
  }

  // ------------------------------------------------------------------ folders
  folderProps(nid) {
    const node = this.ndb.getNode(nid);
    if (!node) throw new Error(`Folder 0x${nid.toString(16)} not found`);
    return readPC(this.ndb, node).props;
  }

  getFolder(nid) {
    const p = bag(this.folderProps(nid));
    return {
      nid,
      name: p.get(P.DISPLAY_NAME) || '',
      count: p.get(P.CONTENT_COUNT) || 0,
      unread: p.get(P.CONTENT_UNREAD) || 0,
      hasSubfolders: !!p.get(P.SUBFOLDERS),
      containerClass: p.get(P.CONTAINER_CLASS) || '',
      parent: this.ndb.getNode(nid)?.nidParent,
    };
  }

  /** Direct child folder NIDs (from the hierarchy table). */
  childFolders(nid) {
    const t = this.table(tableNid(nid, NID_TYPE.HIERARCHY_TABLE));
    if (!t) return [];
    return t.rows.map((r) => r.rowId);
  }

  /** Folder tree under the IPM subtree: [{nid, name, count, unread, path, children}] */
  folderTree(rootNid = this.ipmSubtree, prefix = '') {
    return this.childFolders(rootNid)
      .map((nid) => {
        let f;
        try {
          f = this.getFolder(nid);
        } catch {
          return null;
        }
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        return { ...f, path, children: this.folderTree(nid, path) };
      })
      .filter(Boolean);
  }

  findFolderByPath(path, create = false) {
    let current = this.ipmSubtree;
    for (const part of String(path).split('/').filter(Boolean)) {
      let next = this.childFolders(current).find((nid) => {
        try {
          return this.getFolder(nid).name.toLowerCase() === part.toLowerCase();
        } catch {
          return false;
        }
      });
      if (!next) {
        if (!create) return null;
        next = this.createFolder(current, part);
      }
      current = next;
    }
    return current;
  }

  createFolder(parentNid, name, containerClass = 'IPF.Note') {
    this.ndb.begin();
    const nid = this.allocNid(NID_TYPE.NORMAL_FOLDER);
    const props = [
      { id: P.DISPLAY_NAME, type: this.stringType(), value: name },
      { id: P.CONTENT_COUNT, type: PT.LONG, value: 0 },
      { id: P.CONTENT_UNREAD, type: PT.LONG, value: 0 },
      { id: P.SUBFOLDERS, type: PT.BOOLEAN, value: false },
      { id: P.CONTAINER_CLASS, type: this.stringType(), value: containerClass },
    ];
    this.writePCNode(nid, parentNid, props, null);
    // New folder tables start as copies of the store's empty templates (shared blocks, like Outlook).
    for (const [type, template] of [
      [NID_TYPE.HIERARCHY_TABLE, NID.HIERARCHY_TABLE_TEMPLATE],
      [NID_TYPE.CONTENTS_TABLE, NID.CONTENTS_TABLE_TEMPLATE],
      [NID_TYPE.ASSOC_CONTENTS_TABLE, NID.ASSOC_CONTENTS_TABLE_TEMPLATE],
    ]) {
      const t = this.ndb.getNode(template);
      this.ndb.putNode({ nid: tableNid(nid, type), bidData: t.bidData, bidSub: 0, nidParent: 0 });
      this.ndb.addRef(t.bidData);
    }
    this.addTableRow(tableNid(parentNid, NID_TYPE.HIERARCHY_TABLE), nid, this.folderProps(nid));
    this.updateFolderProps(parentNid, { [P.SUBFOLDERS]: true });
    return nid;
  }

  renameFolder(nid, name) {
    this.updateFolderProps(nid, { [P.DISPLAY_NAME]: name });
  }

  /** Permanently deletes a folder with all its messages and subfolders. */
  deleteFolder(nid) {
    if ([this.ipmSubtree, this.wastebasket, NID.ROOT_FOLDER].includes(nid)) throw new Error('This folder cannot be deleted');
    this.ndb.begin();
    for (const child of this.childFolders(nid)) this.deleteFolder(child);
    const contents = this.table(tableNid(nid, NID_TYPE.CONTENTS_TABLE));
    for (const r of contents ? contents.rows : []) this.ndb.deleteNode(r.rowId);
    const parent = this.ndb.getNode(nid).nidParent;
    for (const t of [NID_TYPE.HIERARCHY_TABLE, NID_TYPE.CONTENTS_TABLE, NID_TYPE.ASSOC_CONTENTS_TABLE]) {
      const tn = tableNid(nid, t);
      this.tcCache.delete(tn);
      this.dirtyTables.delete(tn);
      this.ndb.deleteNode(tn);
    }
    this.ndb.deleteNode(nid);
    this.removeTableRow(tableNid(parent, NID_TYPE.HIERARCHY_TABLE), nid);
    if (!this.childFolders(parent).length) this.updateFolderProps(parent, { [P.SUBFOLDERS]: false });
  }

  /** Moves a folder under a new parent. */
  moveFolder(nid, newParent) {
    this.ndb.begin();
    const node = this.ndb.getNode(nid);
    const oldParent = node.nidParent;
    if (oldParent === newParent) return;
    this.ndb.putNode({ ...node, nidParent: newParent });
    this.removeTableRow(tableNid(oldParent, NID_TYPE.HIERARCHY_TABLE), nid);
    this.addTableRow(tableNid(newParent, NID_TYPE.HIERARCHY_TABLE), nid, this.folderProps(nid));
    this.updateFolderProps(newParent, { [P.SUBFOLDERS]: true });
    if (!this.childFolders(oldParent).length) this.updateFolderProps(oldParent, { [P.SUBFOLDERS]: false });
  }

  /** Changes folder PC properties and mirrors them into the parent's hierarchy table row. */
  updateFolderProps(nid, changes, current) {
    this.ndb.begin();
    const props = current || this.folderProps(nid);
    for (const [k, v] of Object.entries(changes)) {
      const id = Number(k);
      const type = props.get(id)?.type ?? (typeof v === 'boolean' ? PT.BOOLEAN : typeof v === 'number' ? PT.LONG : this.stringType());
      props.set(id, { type, value: v });
    }
    const node = this.ndb.getNode(nid);
    this.writePCNode(nid, node.nidParent, [...props].map(([id, p]) => ({ id, type: p.type, value: p.value })), node);
    if (nid !== NID.ROOT_FOLDER && node.nidParent && node.nidParent !== nid) {
      this.updateTableRow(tableNid(node.nidParent, NID_TYPE.HIERARCHY_TABLE), nid, props);
    }
  }

  // ------------------------------------------------------------------ tables (in-memory models)
  table(nid) {
    if (this.tcCache.has(nid)) return this.tcCache.get(nid);
    const node = this.ndb.getNode(nid);
    if (!node || !node.bidData) return null;
    const t = readTC(this.ndb, node);
    const model = {
      nid,
      columns: t.columns.map((c) => [c.id, c.type]),
      // Keep the table's existing column layout so rewrites stay compatible and unchanged rows identical.
      layout: { cols: t.columns.map((c) => ({ ...c })), rgib: t.rgib, cbRow: t.rgib[3] },
      rows: t.rows.map((values, i) => ({ rowId: t.rowIds[i], rowVer: values.get(P.ROW_VER), values })),
    };
    model.index = new Map(model.rows.map((r, i) => [r.rowId, i]));
    this.tcCache.set(nid, model);
    if (this.tcCache.size > 64) {
      for (const k of this.tcCache.keys()) {
        if (!this.dirtyTables.has(k)) {
          this.tcCache.delete(k);
          break;
        }
      }
    }
    return model;
  }

  rowValuesFrom(model, props) {
    const values = new Map();
    for (const [id] of model.columns) {
      if (id === P.ROW_ID || id === P.ROW_VER) continue;
      const p = props instanceof Map ? props.get(id) : undefined;
      if (p && p.value !== undefined && p.value !== null) values.set(id, p.value);
    }
    return values;
  }

  addTableRow(tnid, rowId, props) {
    const model = this.table(tnid);
    if (!model) return;
    const values = this.rowValuesFrom(model, props);
    if (model.index.has(rowId)) {
      model.rows[model.index.get(rowId)].values = values;
    } else {
      model.rows.push({ rowId, values });
      model.index.set(rowId, model.rows.length - 1);
    }
    this.dirtyTables.add(tnid);
  }

  updateTableRow(tnid, rowId, props) {
    const model = this.table(tnid);
    if (!model || !model.index.has(rowId)) return this.addTableRow(tnid, rowId, props);
    const row = model.rows[model.index.get(rowId)];
    row.values = this.rowValuesFrom(model, props);
    this.dirtyTables.add(tnid);
  }

  removeTableRow(tnid, rowId) {
    const model = this.table(tnid);
    if (!model || !model.index.has(rowId)) return;
    const i = model.index.get(rowId);
    const last = model.rows.length - 1;
    // Swap-remove keeps every other row in place, so unchanged row blocks are reused on write.
    if (i !== last) {
      model.rows[i] = model.rows[last];
      model.index.set(model.rows[i].rowId, i);
    }
    model.rows.pop();
    model.index.delete(rowId);
    this.dirtyTables.add(tnid);
  }

  flushTables() {
    for (const tnid of this.dirtyTables) {
      const model = this.tcCache.get(tnid);
      if (!model) continue;
      const node = this.ndb.getNode(tnid);
      const subs = [];
      const pages = buildTC(
        model.columns,
        model.rows.map((r, i) => ({ rowId: r.rowId, rowVer: i + 1, values: r.values })),
        {
          allocSubnode: (data, kind) => {
            // Row matrix lives in subnode 0x3F (like Outlook); oversized cell values get store-wide NIDs.
            const nid = kind === 'rows' ? makeNid(NID_TYPE.LTP, 1) : this.allocNid(NID_TYPE.LTP);
            const old = kind === 'rows' && node?.bidSub ? this.ndb.readSubnodes(node.bidSub).get(nid) : null;
            subs.push({ nid, bidData: this.ndb.writeDataTreeReuse(data, old?.bidData), bidSub: 0 });
            return nid;
          },
        },
        model.layout
      );
      const bidData = this.ndb.writeDataTreeReuse(pages, node?.bidData);
      const bidSub = this.ndb.writeSubnodeTree(subs);
      this.ndb.putNode({ nid: tnid, bidData, bidSub, nidParent: node?.nidParent ?? 0 });
    }
    this.dirtyTables.clear();
  }

  /** Writes a PC node; large values go to subnodes. Existing subnodes not used by the PC are kept. */
  writePCNode(nid, nidParent, props, oldNode, extraSubnodes = []) {
    const subs = [...extraSubnodes];
    const pages = buildPC(props, (data) => {
      const snid = this.allocNid(NID_TYPE.LTP); // store-wide counter, as Outlook does
      subs.push({ nid: snid, bidData: this.ndb.writeDataTree(data), bidSub: 0 });
      return snid;
    });
    const bidData = this.ndb.writeDataTreeReuse(pages, oldNode?.bidData);
    const bidSub = this.ndb.writeSubnodeTree(subs);
    return this.ndb.putNode({ nid, bidData, bidSub, nidParent });
  }

  // ------------------------------------------------------------------ messages
  /**
   * Lists messages in a folder from its contents table (fast: no message bodies are read).
   * @returns {Array<{nid, subject, from, fromAddress?, date, unread, size, hasAttachments, flagged, importance, to}>}
   */
  listMessages(folderNid) {
    const t = this.table(tableNid(folderNid, NID_TYPE.CONTENTS_TABLE));
    if (!t) return [];
    return t.rows.map((r) => {
      const v = r.values;
      const flags = v.get(P.MESSAGE_FLAGS) || 0;
      return {
        nid: r.rowId,
        subject: v.get(P.SUBJECT) || '',
        from: v.get(P.SENT_REPRESENTING_NAME) || '',
        to: v.get(P.DISPLAY_TO) || '',
        date: v.get(P.MESSAGE_DELIVERY_TIME) || v.get(P.CLIENT_SUBMIT_TIME) || null,
        unread: !(flags & MSGFLAG_READ),
        size: v.get(P.MESSAGE_SIZE) || 0,
        hasAttachments: !!(flags & MSGFLAG_HASATTACH),
        importance: v.get(P.IMPORTANCE) ?? 1,
        messageClass: v.get(P.MESSAGE_CLASS) || 'IPM.Note',
      };
    });
  }

  /** Full message: properties, recipients, attachment list. */
  getMessage(nid) {
    const node = this.ndb.getNode(nid);
    if (!node) throw new Error(`Message 0x${nid.toString(16)} not found`);
    const { props, subnodes } = readPC(this.ndb, node);
    const p = bag(props);
    const recipients = [];
    const rsub = subnodes.get(NID.RECIPIENT_TABLE);
    if (rsub) {
      const t = readTC(this.ndb, { bidData: rsub.bidData, bidSub: rsub.bidSub });
      for (const r of t.rows) {
        recipients.push({
          type: r.get(P.RECIPIENT_TYPE) || 1,
          name: r.get(P.DISPLAY_NAME) || '',
          address: r.get(P.SMTP_ADDRESS) || r.get(P.EMAIL_ADDRESS) || '',
          addrType: r.get(P.ADDRTYPE) || '',
        });
      }
    }
    const attachments = [];
    const asub = subnodes.get(NID.ATTACHMENT_TABLE);
    if (asub) {
      const t = readTC(this.ndb, { bidData: asub.bidData, bidSub: asub.bidSub });
      t.rowIds.forEach((anid) => {
        const sn = subnodes.get(anid);
        if (!sn) return;
        try {
          const ap = bag(readPC(this.ndb, sn).props);
          attachments.push({
            nid: anid,
            filename: ap.get(P.ATTACH_LONG_FILENAME) || ap.get(P.ATTACH_FILENAME) || ap.get(P.DISPLAY_NAME) || 'attachment',
            size: ap.get(P.ATTACH_SIZE) || 0,
            mimeType: ap.get(P.ATTACH_MIME_TAG) || '',
            contentId: ap.get(P.ATTACH_CONTENT_ID) || '',
            hidden: !!ap.get(P.ATTACHMENT_HIDDEN),
            method: ap.get(P.ATTACH_METHOD) || 1,
          });
        } catch {
          /* unreadable attachment: skip */
        }
      });
    }
    const flags = p.get(P.MESSAGE_FLAGS) || 0;
    let html = p.get(P.HTML);
    if (Buffer.isBuffer(html)) html = decodeHtml(html, p.get(P.INTERNET_CPID));
    const kw = this.named.find(PS_PUBLIC_STRINGS, 'Keywords');
    return {
      nid,
      folder: node.nidParent,
      subject: p.get(P.SUBJECT) || '',
      from: p.get(P.SENT_REPRESENTING_NAME) || p.get(P.SENDER_NAME) || '',
      fromAddress: p.get(P.SENT_REPRESENTING_SMTP) || p.get(P.SENDER_SMTP) || p.get(P.SENT_REPRESENTING_EMAIL) || p.get(P.SENDER_EMAIL) || '',
      to: p.get(P.DISPLAY_TO) || '',
      cc: p.get(P.DISPLAY_CC) || '',
      bcc: p.get(P.DISPLAY_BCC) || '',
      recipients,
      date: p.get(P.MESSAGE_DELIVERY_TIME) || p.get(P.CLIENT_SUBMIT_TIME) || null,
      sent: p.get(P.CLIENT_SUBMIT_TIME) || null,
      text: p.get(P.BODY) || '',
      html: html || '',
      headers: p.get(P.TRANSPORT_HEADERS) || '',
      messageId: p.get(P.INTERNET_MESSAGE_ID) || '',
      unread: !(flags & MSGFLAG_READ),
      flagged: p.get(P.FLAG_STATUS) === 2,
      importance: p.get(P.IMPORTANCE) ?? 1,
      categories: kw ? p.get(kw.propId) || [] : [],
      attachments,
      props,
    };
  }

  getAttachmentData(msgNid, attNid) {
    const node = this.ndb.getNode(msgNid);
    const subs = this.ndb.readSubnodes(node.bidSub);
    const sn = subs.get(attNid);
    if (!sn) throw new Error('Attachment not found');
    const { props } = readPC(this.ndb, sn);
    const d = props.get(P.ATTACH_DATA)?.value;
    if (Buffer.isBuffer(d)) return d;
    const obj = props.get(P.ATTACH_DATA);
    if (obj && obj.type === PT.OBJECT) throw new Error('Embedded-object attachments are not supported yet');
    return Buffer.alloc(0);
  }

  /**
   * Adds a message to a folder.
   * @param {number} folderNid
   * @param {object} m { subject, from:{name,address}, to[], cc[], bcc[], date, receivedDate, text, html, headers,
   *                     messageId, inReplyTo, references, importance, unread, flagged, categories[], attachments[] }
   * @returns {number} message NID
   */
  addMessage(folderNid, m) {
    this.ndb.begin();
    const { props, subnodes } = this.buildMessage(m);
    return this.addRawMessage(folderNid, props, subnodes, !!m.unread);
  }

  /** Adds a message from ready-made properties and subnodes (used by import and addMessage). */
  addRawMessage(folderNid, props, subnodes, unread) {
    this.ndb.begin();
    const nid = this.allocNid(NID_TYPE.NORMAL_MESSAGE);
    this.writePCNode(nid, folderNid, props, null, subnodes);
    const pmap = new Map(props.map((p) => [p.id, p]));
    this.addTableRow(tableNid(folderNid, NID_TYPE.CONTENTS_TABLE), nid, pmap);
    this.adjustCounts(folderNid, 1, unread ? 1 : 0);
    return nid;
  }

  buildMessage(m) {
    const S = this.stringType();
    const from = m.from || { name: '', address: '' };
    const to = m.to || [];
    const cc = m.cc || [];
    const bcc = m.bcc || [];
    const atts = m.attachments || [];
    const sent = m.date ? new Date(m.date) : new Date();
    const received = m.receivedDate ? new Date(m.receivedDate) : sent;
    const subject = m.subject || '';
    const normalized = subject.replace(/^((re|fw|fwd|aw|wg|sv|antw)\s*(\[\d+\])?:\s*)+/i, '');
    const display = (list) => list.map((r) => r.name || r.address).filter(Boolean).join('; ');
    const html = m.html ? Buffer.from(m.html, 'utf8') : null;
    const flags = (m.unread ? 0 : MSGFLAG_READ) | (atts.length ? MSGFLAG_HASATTACH : 0);
    const size = (m.rawSize || 0) || subject.length * 2 + (m.text || '').length * 2 + (html ? html.length : 0) + atts.reduce((s, a) => s + (a.content?.length || 0), 0);

    const props = [
      { id: P.MESSAGE_CLASS, type: S, value: m.messageClass || 'IPM.Note' },
      { id: P.SUBJECT, type: S, value: subject },
      { id: P.NORMALIZED_SUBJECT, type: S, value: normalized },
      { id: P.CONVERSATION_TOPIC, type: S, value: normalized },
      { id: P.IMPORTANCE, type: PT.LONG, value: { low: 0, normal: 1, high: 2 }[m.importance] ?? (typeof m.importance === 'number' ? m.importance : 1) },
      { id: P.SENSITIVITY, type: PT.LONG, value: 0 },
      { id: P.CLIENT_SUBMIT_TIME, type: PT.SYSTIME, value: sent },
      { id: P.MESSAGE_DELIVERY_TIME, type: PT.SYSTIME, value: received },
      { id: P.CREATION_TIME, type: PT.SYSTIME, value: received },
      { id: P.LAST_MODIFICATION_TIME, type: PT.SYSTIME, value: received },
      { id: P.MESSAGE_FLAGS, type: PT.LONG, value: flags },
      { id: P.MESSAGE_STATUS, type: PT.LONG, value: 0 },
      { id: P.MESSAGE_SIZE, type: PT.LONG, value: Math.min(size, 0x7fffffff) },
      { id: P.HASATTACH, type: PT.BOOLEAN, value: atts.length > 0 },
      { id: P.SEARCH_KEY, type: PT.BINARY, value: crypto.randomBytes(16) },
      { id: P.SENDER_NAME, type: S, value: from.name || from.address },
      { id: P.SENDER_EMAIL, type: S, value: from.address },
      { id: P.SENDER_ADDRTYPE, type: S, value: 'SMTP' },
      { id: P.SENDER_SMTP, type: S, value: from.address },
      { id: P.SENT_REPRESENTING_NAME, type: S, value: from.name || from.address },
      { id: P.SENT_REPRESENTING_EMAIL, type: S, value: from.address },
      { id: P.SENT_REPRESENTING_ADDRTYPE, type: S, value: 'SMTP' },
      { id: P.SENT_REPRESENTING_SMTP, type: S, value: from.address },
      { id: P.DISPLAY_TO, type: S, value: display(to) },
      { id: P.DISPLAY_CC, type: S, value: display(cc) },
      { id: P.DISPLAY_BCC, type: S, value: display(bcc) },
      { id: P.MESSAGE_TO_ME, type: PT.BOOLEAN, value: false },
      { id: P.MESSAGE_CC_ME, type: PT.BOOLEAN, value: false },
      { id: P.TRANSPORT_HEADERS, type: S, value: m.headers },
      { id: P.INTERNET_MESSAGE_ID, type: S, value: m.messageId },
      { id: P.IN_REPLY_TO, type: S, value: m.inReplyTo },
      { id: P.INTERNET_REFERENCES, type: S, value: m.references },
      { id: P.BODY, type: S, value: m.text || '' },
      { id: P.INTERNET_CPID, type: PT.LONG, value: 65001 },
      { id: P.MESSAGE_CODEPAGE, type: PT.LONG, value: 65001 },
    ];
    if (html) props.push({ id: P.HTML, type: PT.BINARY, value: html });
    if (m.flagged) props.push({ id: P.FLAG_STATUS, type: PT.LONG, value: 2 });
    if (m.categories && m.categories.length) props.push({ id: this.keywordsPropId, type: PT.MV_UNICODE, value: m.categories });
    const filtered = props.filter((p) => p.value !== undefined && p.value !== null && !(typeof p.value === 'string' && p.value === '' && p.id !== P.BODY));

    // Subnodes: recipient table (always), attachment table + one PC per attachment.
    const subnodes = [];
    const recipRows = [];
    [...to.map((r) => [r, 1]), ...cc.map((r) => [r, 2]), ...bcc.map((r) => [r, 3])].forEach(([r, type], i) => {
      const name = r.name || r.address || '';
      const values = new Map([
        [P.RECIPIENT_TYPE, type],
        [P.RESPONSIBILITY, false],
        [P.OBJECT_TYPE, 6],
        [P.DISPLAY_NAME, name],
        [P.ADDRTYPE, 'SMTP'],
        [P.EMAIL_ADDRESS, r.address || ''],
        [P.DISPLAY_TYPE, 0],
        [P.DISPLAY_NAME_7BIT, name],
        [P.SEND_RICH_INFO, false],
        [P.SMTP_ADDRESS, r.address || ''],
        [P.SEARCH_KEY, Buffer.from(`SMTP:${(r.address || '').toUpperCase()}\0`, 'latin1')],
      ]);
      recipRows.push({ rowId: i, values });
    });
    const recipCols = this.templateColumns(NID.RECIPIENT_TABLE, [
      [P.RECIPIENT_TYPE, PT.LONG],
      [P.RESPONSIBILITY, PT.BOOLEAN],
      [P.RECORD_KEY, PT.BINARY],
      [P.OBJECT_TYPE, PT.LONG],
      [P.ENTRY_ID, PT.BINARY],
      [P.DISPLAY_NAME, S],
      [P.ADDRTYPE, S],
      [P.EMAIL_ADDRESS, S],
      [P.SEARCH_KEY, PT.BINARY],
      [P.DISPLAY_TYPE, PT.LONG],
      [P.DISPLAY_NAME_7BIT, S],
      [P.SEND_RICH_INFO, PT.BOOLEAN],
      [P.ROW_ID, PT.LONG],
      [P.ROW_VER, PT.LONG],
    ]);
    // Recipient tables carry the SMTP address as an extra column (Outlook adds it the same way).
    if (!recipCols.find(([id]) => id === P.SMTP_ADDRESS)) recipCols.push([P.SMTP_ADDRESS, S]);
    subnodes.push(this.tableSubnode(NID.RECIPIENT_TABLE, recipCols, recipRows));

    if (atts.length) {
      const attRows = [];
      atts.forEach((a, i) => {
        const anid = this.allocNid(NID_TYPE.ATTACHMENT);
        const filename = a.filename || `attachment${i + 1}`;
        const content = a.content || Buffer.alloc(0);
        const ext = (filename.match(/\.[^.]+$/) || [''])[0];
        const aprops = [
          { id: P.ATTACH_SIZE, type: PT.LONG, value: content.length },
          { id: P.ATTACH_NUM, type: PT.LONG, value: i },
          { id: P.ATTACH_METHOD, type: PT.LONG, value: 1 },
          { id: P.RENDERING_POSITION, type: PT.LONG, value: -1 },
          { id: P.DISPLAY_NAME, type: S, value: filename },
          { id: P.ATTACH_FILENAME, type: S, value: filename },
          { id: P.ATTACH_LONG_FILENAME, type: S, value: filename },
          { id: P.ATTACH_EXTENSION, type: S, value: ext },
          { id: P.ATTACH_MIME_TAG, type: S, value: a.contentType },
          { id: P.ATTACH_DATA, type: PT.BINARY, value: content },
          { id: P.OBJECT_TYPE, type: PT.LONG, value: 7 },
          { id: P.CREATION_TIME, type: PT.SYSTIME, value: received },
          { id: P.LAST_MODIFICATION_TIME, type: PT.SYSTIME, value: received },
        ];
        if (a.contentId) aprops.push({ id: P.ATTACH_CONTENT_ID, type: S, value: String(a.contentId).replace(/^<|>$/g, '') });
        if (a.inline && a.contentId) aprops.push({ id: P.ATTACHMENT_HIDDEN, type: PT.BOOLEAN, value: true }, { id: P.ATTACH_FLAGS, type: PT.LONG, value: 4 });
        const asubs = [];
        const pages = buildPC(
          aprops.filter((p) => p.value !== undefined && p.value !== null && p.value !== ''),
          (data) => {
            const snid = this.allocNid(NID_TYPE.LTP);
            asubs.push({ nid: snid, bidData: this.ndb.writeDataTree(data), bidSub: 0 });
            return snid;
          }
        );
        subnodes.push({ nid: anid, bidData: this.ndb.writeDataTree(pages), bidSub: this.ndb.writeSubnodeTree(asubs) });
        attRows.push({ rowId: anid, values: new Map([[P.ATTACH_SIZE, content.length], [P.ATTACH_FILENAME, filename], [P.ATTACH_METHOD, 1], [P.RENDERING_POSITION, -1]]) });
      });
      const attCols = this.templateColumns(NID.ATTACHMENT_TABLE, [
        [P.ATTACH_SIZE, PT.LONG],
        [P.ATTACH_FILENAME, S],
        [P.ATTACH_METHOD, PT.LONG],
        [P.RENDERING_POSITION, PT.LONG],
        [P.ROW_ID, PT.LONG],
        [P.ROW_VER, PT.LONG],
      ]);
      subnodes.push(this.tableSubnode(NID.ATTACHMENT_TABLE, attCols, attRows));
    }
    return { props: filtered, subnodes };
  }

  /** Column definitions from the store's template table (fallback: given defaults). */
  templateColumns(templateNid, fallback) {
    this._templates = this._templates || new Map();
    if (!this._templates.has(templateNid)) {
      let cols = null;
      try {
        const node = this.ndb.getNode(templateNid);
        if (node) cols = readTC(this.ndb, node).columns.map((c) => [c.id, c.type]);
      } catch {
        cols = null;
      }
      this._templates.set(templateNid, cols);
    }
    return [...(this._templates.get(templateNid) || fallback)];
  }

  tableSubnode(nid, columns, rows) {
    const subs = [];
    const pages = buildTC(columns, rows, {
      allocSubnode: (data, kind) => {
        const snid = kind === 'rows' ? makeNid(NID_TYPE.LTP, 1) : this.allocNid(NID_TYPE.LTP);
        subs.push({ nid: snid, bidData: this.ndb.writeDataTree(data), bidSub: 0 });
        return snid;
      },
    });
    return { nid, bidData: this.ndb.writeDataTree(pages), bidSub: this.ndb.writeSubnodeTree(subs) };
  }

  adjustCounts(folderNid, dCount, dUnread) {
    if (!dCount && !dUnread) return;
    const props = this.folderProps(folderNid);
    const count = Math.max(0, (props.get(P.CONTENT_COUNT)?.value || 0) + dCount);
    const unread = Math.max(0, (props.get(P.CONTENT_UNREAD)?.value || 0) + dUnread);
    this.updateFolderProps(folderNid, { [P.CONTENT_COUNT]: count, [P.CONTENT_UNREAD]: unread }, props);
  }

  /** Rewrites a message's PC with property changes (subnodes are kept as they are). */
  updateMessageProps(nid, changes) {
    this.ndb.begin();
    const node = this.ndb.getNode(nid);
    const { props, subnodes } = readPC(this.ndb, node);
    // Subnodes holding the PC's own large values are rewritten with it; everything else
    // (recipient table, attachments, …) is kept as-is.
    const pcValueNids = new Set([...props.values()].map((p) => p.hnid).filter((h) => h && (h & 0x1f) !== 0));
    for (const [id, v] of changes) {
      if (v.value === undefined || v.value === null) props.delete(id);
      else props.set(id, v);
    }
    const keep = [...subnodes.values()].filter((s) => !pcValueNids.has(s.nid));
    const list = [...props].map(([id, p]) => ({ id, type: p.type, value: p.value }));
    this.writePCNode(nid, node.nidParent, list, node, keep);
    this.updateTableRow(tableNid(node.nidParent, NID_TYPE.CONTENTS_TABLE), nid, props);
    return props;
  }

  setRead(nid, read) {
    const node = this.ndb.getNode(nid);
    const { props } = readPC(this.ndb, node);
    const flags = props.get(P.MESSAGE_FLAGS)?.value || 0;
    const wasRead = !!(flags & MSGFLAG_READ);
    if (wasRead === read) return;
    this.updateMessageProps(nid, new Map([[P.MESSAGE_FLAGS, { type: PT.LONG, value: read ? flags | MSGFLAG_READ : flags & ~MSGFLAG_READ }]]));
    this.adjustCounts(node.nidParent, 0, read ? -1 : 1);
  }

  setFlag(nid, flagged) {
    this.updateMessageProps(nid, new Map([[P.FLAG_STATUS, { type: PT.LONG, value: flagged ? 2 : null }]]));
  }

  setCategories(nid, categories) {
    this.updateMessageProps(nid, new Map([[this.keywordsPropId, { type: PT.MV_UNICODE, value: categories && categories.length ? categories : null }]]));
  }

  moveMessage(nid, destFolder) {
    this.ndb.begin();
    const node = this.ndb.getNode(nid);
    const src = node.nidParent;
    if (src === destFolder) return nid;
    const { props } = readPC(this.ndb, node);
    const unread = !((props.get(P.MESSAGE_FLAGS)?.value || 0) & MSGFLAG_READ);
    this.ndb.putNode({ ...node, nidParent: destFolder });
    this.removeTableRow(tableNid(src, NID_TYPE.CONTENTS_TABLE), nid);
    this.addTableRow(tableNid(destFolder, NID_TYPE.CONTENTS_TABLE), nid, props);
    this.adjustCounts(src, -1, unread ? -1 : 0);
    this.adjustCounts(destFolder, 1, unread ? 1 : 0);
    return nid;
  }

  /** Permanently deletes a message. */
  deleteMessage(nid) {
    this.ndb.begin();
    const node = this.ndb.getNode(nid);
    if (!node) return;
    const { props } = readPC(this.ndb, node);
    const unread = !((props.get(P.MESSAGE_FLAGS)?.value || 0) & MSGFLAG_READ);
    this.removeTableRow(tableNid(node.nidParent, NID_TYPE.CONTENTS_TABLE), nid);
    this.adjustCounts(node.nidParent, -1, unread ? -1 : 0);
    this.ndb.deleteNode(nid);
  }

  // ------------------------------------------------------------------ commit
  commit() {
    if (!this.ndb.txn) return;
    if (this._named && this._named.dirty) {
      this.writePCNode(NID.NAME_TO_ID_MAP, 0, this._named.toProps(), this.ndb.getNode(NID.NAME_TO_ID_MAP));
      this._named.dirty = false;
    }
    this.flushTables();
    this.ndb.commit();
  }
}

function decodeHtml(buf, cpid) {
  if (!cpid || cpid === 65001 || cpid === 20127) return buf.toString('utf8');
  if (cpid === 1200) return buf.toString('utf16le');
  try {
    return new TextDecoder(`windows-${cpid}`).decode(buf);
  } catch {
    try {
      return new TextDecoder(cpid === 28591 ? 'latin1' : `iso-8859-${cpid - 28590}`).decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

module.exports = { PstStore, P, tableNid, makeNid, nidType, MSGFLAG_READ, MSGFLAG_HASATTACH, MSGFLAG_UNSENT, MSGFLAG_FROMME };
