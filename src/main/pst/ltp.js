'use strict';
// [MS-PST] Lists, Tables and Properties (LTP) layer: Heap-on-Node (HN), BTree-on-Heap (BTH),
// Property Context (PC) and Table Context (TC) — both reading and building.

const { PT, FIXED_SIZE, BTYPE, NID_TYPE } = require('./constants');
const { PstFormatError } = require('./ndb');

const HN_SIG = 0xec;
const MAX_ALLOC = 3580;
const HN_PAGE_MAX = 8176; // max data bytes in one block = one heap page

const isHid = (hnid) => (hnid & 0x1f) === NID_TYPE.HID;
const hidOf = (page, index) => ((page << 16) | ((index + 1) << 5)) >>> 0;

// =================================================================== reading

class HeapReader {
  /**
   * @param {Buffer[]} pages node data blocks
   * @param {Map} subnodes Map(nid → subnode) of the owning node, for values stored in subnodes
   * @param {import('./ndb').Ndb} ndb
   */
  constructor(pages, subnodes, ndb) {
    if (!pages.length || pages[0][2] !== HN_SIG) throw new PstFormatError('Node data is not a heap (HN)');
    this.pages = pages;
    this.subnodes = subnodes;
    this.ndb = ndb;
    const h = pages[0];
    this.clientSig = h[3];
    this.hidUserRoot = h.readUInt32LE(4);
    this.maps = pages.map((p) => {
      const ib = p.readUInt16LE(0);
      const cAlloc = p.readUInt16LE(ib);
      const offs = [];
      for (let i = 0; i <= cAlloc; i++) offs.push(p.readUInt16LE(ib + 4 + i * 2));
      return offs;
    });
  }

  get(hid) {
    if (!hid) return Buffer.alloc(0);
    const page = hid >>> 16;
    const index = ((hid >>> 5) & 0x7ff) - 1;
    const offs = this.maps[page];
    if (!offs || index < 0 || index >= offs.length - 1) throw new PstFormatError(`Bad HID 0x${hid.toString(16)}`);
    return this.pages[page].subarray(offs[index], offs[index + 1]);
  }

  /** Value of an HNID: heap allocation or a subnode's data. */
  getHnid(hnid) {
    if (!hnid) return Buffer.alloc(0);
    if (isHid(hnid)) return this.get(hnid);
    const sub = this.subnodes && this.subnodes.get(hnid);
    if (!sub) throw new PstFormatError(`Missing subnode 0x${hnid.toString(16)}`);
    return this.ndb.readData(sub.bidData);
  }

  /** All records of a BTH as [{key:Buffer, data:Buffer}], in key order. */
  readBth(hid) {
    const hdr = this.get(hid);
    if (hdr[0] !== BTYPE.BTH) throw new PstFormatError('Bad BTH header');
    const cbKey = hdr[1];
    const cbEnt = hdr[2];
    const levels = hdr[3];
    const root = hdr.readUInt32LE(4);
    const out = [];
    const walk = (h, level) => {
      if (!h) return;
      const b = this.get(h);
      if (level === 0) {
        for (let o = 0; o + cbKey + cbEnt <= b.length; o += cbKey + cbEnt) out.push({ key: b.subarray(o, o + cbKey), data: b.subarray(o + cbKey, o + cbKey + cbEnt) });
      } else {
        for (let o = 0; o + cbKey + 4 <= b.length; o += cbKey + 4) walk(b.readUInt32LE(o + cbKey), level - 1);
      }
    };
    walk(root, levels);
    return { cbKey, cbEnt, records: out };
  }
}

// Subjects in PSTs can begin with U+0001 followed by a character holding the prefix length.
function stripPrefixMarker(s) {
  return s.charCodeAt(0) === 1 && s.length >= 2 ? s.slice(2) : s;
}

function decodeValue(type, buf, unicode = true) {
  switch (type) {
    case PT.SHORT:
      return buf.readInt16LE(0);
    case PT.LONG:
    case PT.ERROR:
      return buf.readInt32LE(0);
    case PT.FLOAT:
      return buf.readFloatLE(0);
    case PT.DOUBLE:
    case PT.APPTIME:
      return buf.readDoubleLE(0);
    case PT.BOOLEAN:
      return buf[0] !== 0;
    case PT.I8:
    case PT.CURRENCY:
      return buf.readBigInt64LE(0);
    case PT.SYSTIME: {
      const ft = buf.readBigUInt64LE(0);
      if (ft === 0n) return null;
      return new Date(Number(ft / 10000n - 11644473600000n));
    }
    case PT.UNICODE:
      return stripPrefixMarker(buf.toString('utf16le'));
    case PT.STRING8:
      return stripPrefixMarker(buf.toString('latin1').replace(/\0+$/, ''));
    case PT.CLSID:
      return Buffer.from(buf);
    case PT.MV_UNICODE:
    case PT.MV_STRING8:
    case PT.MV_BINARY: {
      if (buf.length < 4) return [];
      const n = buf.readUInt32LE(0);
      const offs = [];
      for (let i = 0; i < n; i++) offs.push(buf.readUInt32LE(4 + i * 4));
      offs.push(buf.length);
      const items = offs.slice(0, -1).map((o, i) => buf.subarray(o, offs[i + 1]));
      if (type === PT.MV_BINARY) return items.map((b) => Buffer.from(b));
      return items.map((b) => (type === PT.MV_UNICODE ? b.toString('utf16le') : b.toString('latin1').replace(/\0+$/, '')));
    }
    case PT.MV_LONG: {
      const out = [];
      for (let o = 0; o + 4 <= buf.length; o += 4) out.push(buf.readInt32LE(o));
      return out;
    }
    default:
      return Buffer.from(buf);
  }
}

/** Reads a Property Context into Map(propId → {type, value}). */
function readPC(ndb, node, subnodes) {
  const pages = ndb.readDataBlocks(node.bidData);
  const subs = subnodes || ndb.readSubnodes(node.bidSub);
  const heap = new HeapReader(pages, subs, ndb);
  if (heap.clientSig !== BTYPE.PC) throw new PstFormatError('Node is not a property context');
  const { records } = heap.readBth(heap.hidUserRoot);
  const props = new Map();
  for (const r of records) {
    const id = r.key.readUInt16LE(0);
    const type = r.data.readUInt16LE(0);
    const raw = r.data.readUInt32LE(2);
    let buf;
    const size = FIXED_SIZE[type];
    if (size !== undefined && size <= 4) {
      buf = r.data.subarray(2, 6);
    } else {
      try {
        buf = heap.getHnid(raw);
      } catch (e) {
        props.set(id, { type, value: null, error: e.message });
        continue;
      }
    }
    const inline = size !== undefined && size <= 4;
    props.set(id, { type, value: decodeValue(type, buf, ndb.fmt.unicode), hnid: inline ? 0 : raw });
  }
  return { props, subnodes: subs };
}

/**
 * Reads a Table Context. Returns { columns:[{tag,id,type,ib,cb,iBit}], rows:[Map(propId→value)] , rowIds }.
 * @param {object} [opts] { columns: optional list of prop ids to decode (others skipped) }
 */
function readTC(ndb, node, opts = {}) {
  const pages = ndb.readDataBlocks(node.bidData);
  const subs = ndb.readSubnodes(node.bidSub);
  const heap = new HeapReader(pages, subs, ndb);
  if (heap.clientSig !== BTYPE.TC) throw new PstFormatError('Node is not a table context');
  const info = heap.get(heap.hidUserRoot);
  const cCols = info[1];
  const rgib = [info.readUInt16LE(2), info.readUInt16LE(4), info.readUInt16LE(6), info.readUInt16LE(8)];
  const hidRowIndex = info.readUInt32LE(10);
  const hnidRows = info.readUInt32LE(14);
  const columns = [];
  for (let i = 0; i < cCols; i++) {
    const o = 22 + i * 8;
    const tag = info.readUInt32LE(o);
    columns.push({ tag, id: tag >>> 16, type: tag & 0xffff, ib: info.readUInt16LE(o + 4), cb: info[o + 6], iBit: info[o + 7] });
  }
  const cbRow = rgib[3];
  const rowIndex = heap.readBth(hidRowIndex).records;
  const rowCount = rowIndex.length;

  // Row matrix: one heap allocation, or a subnode data tree whose blocks each hold whole rows.
  let rowBlocks = [];
  if (hnidRows) {
    if (isHid(hnidRows)) rowBlocks = [heap.get(hnidRows)];
    else {
      const sub = subs.get(hnidRows);
      if (!sub) throw new PstFormatError('Missing row matrix subnode');
      rowBlocks = ndb.readDataBlocks(sub.bidData);
    }
  }
  const rowsPerBlock = Math.floor(ndb.fmt.maxBlockData / cbRow);
  const rowAt = (i) => {
    if (rowBlocks.length === 1 && isHid(hnidRows)) return rowBlocks[0].subarray(i * cbRow, (i + 1) * cbRow);
    const b = rowBlocks[Math.floor(i / rowsPerBlock)];
    const o = (i % rowsPerBlock) * cbRow;
    return b ? b.subarray(o, o + cbRow) : null;
  };

  const want = opts.columns ? new Set(opts.columns) : null;
  const rows = [];
  const rowIds = [];
  for (const rec of rowIndex) {
    const rowId = rec.key.readUInt32LE(0);
    const idx = rec.data.length >= 4 ? rec.data.readUInt32LE(0) : rec.data.readUInt16LE(0);
    const row = rowAt(idx);
    if (!row || row.length < cbRow) continue;
    const values = new Map();
    for (const c of columns) {
      if (want && !want.has(c.id) && c.id !== 0x67f2) continue;
      const exists = (row[rgib[2] + (c.iBit >> 3)] >> (7 - (c.iBit & 7))) & 1;
      if (!exists) continue;
      const cell = row.subarray(c.ib, c.ib + c.cb);
      const size = FIXED_SIZE[c.type];
      let buf;
      if (size !== undefined && size <= 8 && c.cb === size) buf = cell;
      else {
        const hnid = cell.readUInt32LE(0);
        try {
          buf = heap.getHnid(hnid);
        } catch {
          continue;
        }
      }
      values.set(c.id, decodeValue(c.type, buf, ndb.fmt.unicode));
    }
    rows.push(values);
    rowIds.push(rowId);
  }
  return { columns, rgib, rows, rowIds, rowCount, subnodes: subs };
}

// =================================================================== building

/**
 * In-memory heap that serializes to HN pages. Allocations keep their page/index (and so their HID)
 * across rebuilds, which lets an unchanged page serialize to byte-identical blocks.
 */
class HeapBuilder {
  constructor(clientSig) {
    this.clientSig = clientSig;
    this.pages = [[]]; // each page: array of Buffer | null (freed)
    this.hidUserRoot = 0;
  }

  static headerSize(pageIndex) {
    if (pageIndex === 0) return 12; // HNHDR
    return (pageIndex - 8) % 128 === 0 && pageIndex >= 8 ? 66 : 2; // HNBITMAPHDR or HNPAGEHDR
  }

  pageSize(pi) {
    const allocs = this.pages[pi];
    let size = HeapBuilder.headerSize(pi);
    for (const a of allocs) if (a) size += a.length;
    size += size % 2; // page map is 2-byte aligned
    return size + 4 + 2 * (allocs.length + 1);
  }

  alloc(buf) {
    if (buf.length > MAX_ALLOC) throw new Error(`Heap allocation too large (${buf.length})`);
    for (let pi = this.pages.length - 1; pi >= 0; pi--) {
      const allocs = this.pages[pi];
      const free = allocs.indexOf(null);
      const extra = buf.length + (free === -1 ? 2 : 0) + 1;
      if (this.pageSize(pi) + extra <= HN_PAGE_MAX && allocs.length < 2047) {
        if (free !== -1) {
          allocs[free] = buf;
          return hidOf(pi, free);
        }
        allocs.push(buf);
        return hidOf(pi, allocs.length - 1);
      }
      if (pi < this.pages.length - 1) break; // only fall back to the last page, then grow
    }
    this.pages.push([buf]);
    return hidOf(this.pages.length - 1, 0);
  }

  free(hid) {
    if (!hid) return;
    const pi = hid >>> 16;
    const idx = ((hid >>> 5) & 0x7ff) - 1;
    if (this.pages[pi]) this.pages[pi][idx] = null;
  }

  get(hid) {
    return this.pages[hid >>> 16][((hid >>> 5) & 0x7ff) - 1];
  }

  /** Replace an allocation's contents; may move it (returns the possibly new HID). */
  set(hid, buf) {
    const pi = hid >>> 16;
    const idx = ((hid >>> 5) & 0x7ff) - 1;
    const old = this.pages[pi][idx];
    this.pages[pi][idx] = buf;
    if (this.pageSize(pi) <= HN_PAGE_MAX) return hid;
    this.pages[pi][idx] = old;
    this.free(hid);
    return this.alloc(buf);
  }

  /** Load from existing heap pages (keeps layout and HIDs). */
  static fromPages(pages) {
    const hb = new HeapBuilder(pages[0][3]);
    hb.hidUserRoot = pages[0].readUInt32LE(4);
    hb.pages = pages.map((p) => {
      const ib = p.readUInt16LE(0);
      const cAlloc = p.readUInt16LE(ib);
      const offs = [];
      for (let i = 0; i <= cAlloc; i++) offs.push(p.readUInt16LE(ib + 4 + i * 2));
      const allocs = [];
      for (let i = 0; i < cAlloc; i++) allocs.push(offs[i + 1] > offs[i] ? Buffer.from(p.subarray(offs[i], offs[i + 1])) : null);
      return allocs;
    });
    return hb;
  }

  serialize() {
    // Drop trailing empty pages (never page 0).
    while (this.pages.length > 1 && this.pages[this.pages.length - 1].every((a) => !a)) this.pages.pop();
    const last = this.pages.length - 1;
    return this.pages.map((allocs, pi) => {
      // Every heap page except the last fills a whole 8176-byte block (Outlook addresses pages that way).
      const size = pi < last ? HN_PAGE_MAX : this.pageSize(pi);
      const buf = Buffer.alloc(size);
      let off = HeapBuilder.headerSize(pi);
      const offs = [];
      for (const a of allocs) {
        offs.push(off);
        if (a) {
          a.copy(buf, off);
          off += a.length;
        }
      }
      offs.push(off);
      off += off % 2;
      const ibHnpm = off;
      buf.writeUInt16LE(ibHnpm, 0);
      if (pi === 0) {
        buf[2] = HN_SIG;
        buf[3] = this.clientSig;
        buf.writeUInt32LE(this.hidUserRoot >>> 0, 4);
        // rgbFillLevel left zero (informational)
      }
      buf.writeUInt16LE(allocs.length, ibHnpm);
      buf.writeUInt16LE(allocs.filter((a) => !a).length, ibHnpm + 2);
      offs.forEach((o, i) => buf.writeUInt16LE(o, ibHnpm + 4 + i * 2));
      return buf;
    });
  }
}

/**
 * Builds a BTH from sorted records inside a heap. Returns the HID of the BTHHEADER.
 * Existing BTH allocations (if hidHeader given) are freed first.
 */
function buildBth(heap, cbKey, cbEnt, records, oldHeaderHid, reservedHeaderHid) {
  if (oldHeaderHid) freeBth(heap, oldHeaderHid);
  const recSize = cbKey + cbEnt;
  let level = 0;
  let nodes = [];
  if (records.length) {
    const perLeaf = Math.floor(MAX_ALLOC / recSize);
    for (let i = 0; i < records.length; i += perLeaf) {
      const chunk = records.slice(i, i + perLeaf);
      const b = Buffer.alloc(chunk.length * recSize);
      chunk.forEach((r, j) => {
        r.key.copy(b, j * recSize);
        r.data.copy(b, j * recSize + cbKey);
      });
      nodes.push({ key: chunk[0].key, hid: heap.alloc(b) });
    }
    const perNode = Math.floor(MAX_ALLOC / (cbKey + 4));
    while (nodes.length > 1) {
      level++;
      const next = [];
      for (let i = 0; i < nodes.length; i += perNode) {
        const chunk = nodes.slice(i, i + perNode);
        const b = Buffer.alloc(chunk.length * (cbKey + 4));
        chunk.forEach((n, j) => {
          n.key.copy(b, j * (cbKey + 4));
          b.writeUInt32LE(n.hid, j * (cbKey + 4) + cbKey);
        });
        next.push({ key: chunk[0].key, hid: heap.alloc(b) });
      }
      nodes = next;
    }
  }
  const hdr = Buffer.alloc(8);
  hdr[0] = BTYPE.BTH;
  hdr[1] = cbKey;
  hdr[2] = cbEnt;
  hdr[3] = level;
  hdr.writeUInt32LE(nodes.length ? nodes[0].hid : 0, 4);
  if (reservedHeaderHid) {
    heap.set(reservedHeaderHid, hdr);
    return reservedHeaderHid;
  }
  return heap.alloc(hdr);
}

function freeBth(heap, hdrHid) {
  const hdr = heap.get(hdrHid);
  if (!hdr) return;
  const cbKey = hdr[1];
  const walk = (hid, level) => {
    if (!hid) return;
    if (level > 0) {
      const b = heap.get(hid);
      for (let o = 0; o + cbKey + 4 <= b.length; o += cbKey + 4) walk(b.readUInt32LE(o + cbKey), level - 1);
    }
    heap.free(hid);
  };
  walk(hdr.readUInt32LE(4), hdr[3]);
  heap.free(hdrHid);
}

function encodeValue(type, value) {
  switch (type) {
    case PT.SHORT: {
      const b = Buffer.alloc(2);
      b.writeInt16LE(value);
      return b;
    }
    case PT.LONG:
    case PT.ERROR: {
      const b = Buffer.alloc(4);
      b.writeInt32LE(value | 0);
      return b;
    }
    case PT.FLOAT: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(value);
      return b;
    }
    case PT.DOUBLE:
    case PT.APPTIME: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(value);
      return b;
    }
    case PT.BOOLEAN:
      return Buffer.from([value ? 1 : 0]);
    case PT.I8:
    case PT.CURRENCY: {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(value));
      return b;
    }
    case PT.SYSTIME: {
      const b = Buffer.alloc(8);
      const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
      b.writeBigUInt64LE((BigInt(Math.round(ms)) + 11644473600000n) * 10000n);
      return b;
    }
    case PT.UNICODE:
      return Buffer.from(String(value), 'utf16le');
    case PT.STRING8:
      return Buffer.from(String(value), 'latin1');
    case PT.MV_UNICODE:
    case PT.MV_BINARY: {
      const items = value.map((v) => (type === PT.MV_UNICODE ? Buffer.from(String(v), 'utf16le') : Buffer.from(v)));
      const head = Buffer.alloc(4 + 4 * items.length);
      head.writeUInt32LE(items.length, 0);
      let off = head.length;
      items.forEach((it, i) => {
        head.writeUInt32LE(off, 4 + i * 4);
        off += it.length;
      });
      return Buffer.concat([head, ...items]);
    }
    case PT.MV_LONG: {
      const b = Buffer.alloc(4 * value.length);
      value.forEach((v, i) => b.writeInt32LE(v, i * 4));
      return b;
    }
    default:
      return Buffer.from(value);
  }
}

/**
 * Builds a Property Context.
 * @param {Array<{id:number,type:number,value:any}>} props
 * @param {(data:Buffer)=>number} allocSubnode stores a large value in a new subnode, returns its NID
 * @returns {Buffer[]} heap pages
 */
function buildPC(props, allocSubnode) {
  const heap = new HeapBuilder(BTYPE.PC);
  const headerHid = heap.alloc(Buffer.alloc(8)); // HID 0x20: BTHHEADER, filled in below
  const records = [];
  for (const p of [...props].sort((a, b) => a.id - b.id)) {
    if (p.value === undefined || p.value === null) continue;
    const enc = encodeValue(p.type, p.value);
    const data = Buffer.alloc(6);
    data.writeUInt16LE(p.type, 0);
    const size = FIXED_SIZE[p.type];
    if (size !== undefined && size <= 4) {
      enc.copy(data, 2);
    } else if (enc.length === 0) {
      data.writeUInt32LE(0, 2);
    } else if (enc.length <= MAX_ALLOC) {
      data.writeUInt32LE(heap.alloc(enc), 2);
    } else {
      data.writeUInt32LE(allocSubnode(enc), 2);
    }
    const key = Buffer.alloc(2);
    key.writeUInt16LE(p.id, 0);
    records.push({ key, data });
  }
  heap.hidUserRoot = buildBth(heap, 2, 6, records, 0, headerHid);
  return heap.serialize();
}

// ------------------------------------------------------------------- TC builder

const TCI_4b = 0;
const TCI_2b = 1;
const TCI_1b = 2;
const TCI_bm = 3;

function cellSize(type) {
  const s = FIXED_SIZE[type];
  if (s === undefined || s > 8) return 4; // HNID
  return s;
}

/** Computes the column layout for a set of [id,type] column definitions. */
function layoutColumns(defs) {
  const cols = defs.map(([id, type]) => ({ id, type, tag: ((id << 16) | type) >>> 0, cb: cellSize(type) }));
  const rowId = cols.find((c) => c.id === 0x67f2);
  const rowVer = cols.find((c) => c.id === 0x67f3);
  if (!rowId || !rowVer) throw new Error('TC must contain PidTagLtpRowId and PidTagLtpRowVer');
  const ordered = [rowId, rowVer, ...cols.filter((c) => c !== rowId && c !== rowVer)];
  ordered.forEach((c, i) => (c.iBit = i));
  let off;
  // 4- and 8-byte cells first (row id at 0, row version at 4), then 2-byte, then 1-byte, then the CEB.
  rowId.ib = 0;
  rowVer.ib = 4;
  off = 8;
  for (const c of ordered.slice(2).filter((c) => c.cb === 8)) (c.ib = off), (off += 8);
  for (const c of ordered.slice(2).filter((c) => c.cb === 4)) (c.ib = off), (off += 4);
  const end4 = off;
  for (const c of ordered.slice(2).filter((c) => c.cb === 2)) (c.ib = off), (off += 2);
  const end2 = off;
  for (const c of ordered.slice(2).filter((c) => c.cb === 1)) (c.ib = off), (off += 1);
  const end1 = off;
  const endBm = end1 + Math.ceil(ordered.length / 8);
  return { cols: ordered, rgib: [end4, end2, end1, endBm], cbRow: endBm };
}

/**
 * Builds a complete Table Context.
 * @param {Array<[number,number]>} columnDefs [propId, propType]
 * @param {Array<{rowId:number, values: Map|object}>} rows
 * @param {object} io { allocSubnode(data:Buffer, kind:'rows'|'value'): nid, rowVer?: number }
 * @returns {Buffer[]} heap pages
 */
function buildTC(columnDefs, rows, io, existingLayout) {
  const layout = existingLayout || layoutColumns(columnDefs);
  const heap = new HeapBuilder(BTYPE.TC);
  const { cols, rgib, cbRow } = layout;
  // Outlook's layout, which some readers rely on: HID 0x20 = row-index BTHHEADER, HID 0x40 = TCINFO.
  const bthHid = heap.alloc(Buffer.alloc(8));
  const infoHid = heap.alloc(Buffer.alloc(22 + 8 * cols.length));

  const rowBufs = rows.map((r, idx) => {
    const values = r.values instanceof Map ? r.values : new Map(Object.entries(r.values).map(([k, v]) => [Number(k), v]));
    const row = Buffer.alloc(cbRow);
    const setBit = (i) => (row[rgib[TCI_1b] + (i >> 3)] |= 0x80 >> (i & 7));
    for (const c of cols) {
      let v;
      if (c.id === 0x67f2) v = r.rowId;
      else if (c.id === 0x67f3) v = r.rowVer ?? idx + 1;
      else v = values.get(c.id);
      if (v === undefined || v === null) continue;
      const enc = encodeValue(c.type, v);
      const fixed = FIXED_SIZE[c.type];
      if (fixed !== undefined && fixed <= 8) {
        enc.copy(row, c.ib, 0, c.cb);
      } else if (enc.length === 0) {
        row.writeUInt32LE(0, c.ib);
      } else if (enc.length <= MAX_ALLOC) {
        row.writeUInt32LE(heap.alloc(enc), c.ib);
      } else {
        row.writeUInt32LE(io.allocSubnode(enc, 'value'), c.ib);
      }
      setBit(c.iBit);
    }
    return row;
  });

  // Row index BTH: rowId → row index, sorted by rowId.
  const index = rows
    .map((r, i) => {
      const key = Buffer.alloc(4);
      key.writeUInt32LE(r.rowId >>> 0);
      const data = Buffer.alloc(4);
      data.writeUInt32LE(i);
      return { key, data, id: r.rowId >>> 0 };
    })
    .sort((a, b) => a.id - b.id);
  const hidRowIndex = buildBth(heap, 4, 4, index, 0, bthHid);

  // Row matrix.
  let hnidRows = 0;
  if (rowBufs.length) {
    const total = rowBufs.length * cbRow;
    if (total <= MAX_ALLOC) {
      hnidRows = heap.alloc(Buffer.concat(rowBufs));
    } else {
      const perBlock = Math.floor(HN_PAGE_MAX / cbRow);
      const blocks = [];
      for (let i = 0; i < rowBufs.length; i += perBlock) {
        const chunk = Buffer.concat(rowBufs.slice(i, i + perBlock));
        const isLast = i + perBlock >= rowBufs.length;
        blocks.push(isLast ? chunk : Buffer.concat([chunk, Buffer.alloc(HN_PAGE_MAX - chunk.length)]));
      }
      hnidRows = io.allocSubnode(blocks, 'rows');
    }
  }

  const info = Buffer.alloc(22 + 8 * cols.length);
  info[0] = BTYPE.TC;
  info[1] = cols.length;
  rgib.forEach((v, i) => info.writeUInt16LE(v, 2 + i * 2));
  info.writeUInt32LE(hidRowIndex, 10);
  info.writeUInt32LE(hnidRows >>> 0, 14);
  info.writeUInt32LE(0, 18);
  // TCOLDESCs sorted by property tag.
  [...cols]
    .sort((a, b) => a.tag - b.tag)
    .forEach((c, i) => {
      const o = 22 + i * 8;
      info.writeUInt32LE(c.tag, o);
      info.writeUInt16LE(c.ib, o + 4);
      info[o + 6] = c.cb;
      info[o + 7] = c.iBit;
    });
  heap.set(infoHid, info);
  heap.hidUserRoot = infoHid;
  return heap.serialize();
}

module.exports = { HeapReader, HeapBuilder, readPC, readTC, buildPC, buildTC, buildBth, encodeValue, decodeValue, layoutColumns, MAX_ALLOC, HN_PAGE_MAX, isHid };
