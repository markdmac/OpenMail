'use strict';
// [MS-PST] Node Database (NDB) layer: header, pages, blocks, the node and block B-trees, data trees and
// subnode trees, plus space allocation (AMaps) and copy-on-write commits for Unicode PST files.
// ANSI (pre-2003) files are supported read-only.

const fs = require('fs');
const { crc32, computeSig } = require('./crc');
const crypt = require('./crypt');
const { PTYPE, AMAP_FIRST, AMAP_COVERAGE, DLIST_OFFSET } = require('./constants');

const PAGE = 512;
const BLOCK_ALIGN = 64;
const MAX_BLOCK = 8192;
const INVALID_AMAP = 0x00;
const VALID_AMAP2 = 0x02;

const UNICODE = {
  unicode: true,
  ptrSize: 8,
  pageData: 496,
  btEntries: 488,
  blockTrailer: 16,
  maxBlockData: 8176,
  nbtEnt: 32,
  bbtEnt: 24,
  btEnt: 24,
  slEnt: 24,
  siEnt: 16,
  sbHeader: 8, // SLBLOCK/SIBLOCK header (btype, cLevel, cEnt, dwPadding)
  xbHeader: 8, // XBLOCK header (btype, cLevel, cEnt, lcbTotal)
};
const ANSI = {
  unicode: false,
  ptrSize: 4,
  pageData: 500,
  btEntries: 496,
  blockTrailer: 12,
  maxBlockData: 8180,
  nbtEnt: 16,
  bbtEnt: 12,
  btEnt: 12,
  slEnt: 12,
  siEnt: 8,
  sbHeader: 4,
  xbHeader: 8,
};

class PstFormatError extends Error {}

function readPtr(buf, off, fmt) {
  return fmt.ptrSize === 8 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
}
function writePtr(buf, off, v) {
  buf.writeBigUInt64LE(BigInt(v), off);
}

const isInternalBid = (bid) => (bid & 2) !== 0;
const bidKey = (bid) => bid - (bid % 2); // ignore the reserved low bit when looking up blocks

class Ndb {
  /**
   * @param {string} file
   * @param {{readOnly?: boolean}} [opts]
   */
  static open(file, opts = {}) {
    const fd = fs.openSync(file, opts.readOnly ? 'r' : 'r+');
    try {
      return new Ndb(fd, file, opts);
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  }

  constructor(fd, file, opts) {
    this.fd = fd;
    this.file = file;
    this.readOnly = !!opts.readOnly;
    this.pageCache = new Map();
    this.readHeader();
    if (!this.fmt.unicode && !this.readOnly) throw new PstFormatError('ANSI PST files can only be opened read-only (import them instead).');
    this.txn = null;
  }

  // ---------------------------------------------------------------- low-level IO
  read(ib, len) {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, buf, got, len - got, ib + got);
      if (n === 0) throw new PstFormatError(`Unexpected end of file at ${ib + got}`);
      got += n;
    }
    return buf;
  }

  write(ib, buf) {
    let done = 0;
    while (done < buf.length) done += fs.writeSync(this.fd, buf, done, buf.length - done, ib + done);
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  // ---------------------------------------------------------------- header
  readHeader() {
    const h = this.read(0, 564);
    if (h.toString('latin1', 0, 4) !== '!BDN') throw new PstFormatError('Not a PST file (bad magic)');
    const wMagicClient = h.readUInt16LE(8);
    if (wMagicClient !== 0x4d53) throw new PstFormatError('This is an OST or unsupported file, not a PST');
    const wVer = h.readUInt16LE(10);
    this.wVer = wVer;
    if (wVer >= 23) {
      if (wVer === 36) throw new PstFormatError('4K-page PST/OST files are not supported');
      this.fmt = UNICODE;
      this.header = {
        raw: h,
        bidNextP: Number(h.readBigUInt64LE(32)),
        dwUnique: h.readUInt32LE(40),
        rgnid: Array.from({ length: 32 }, (_, i) => h.readUInt32LE(44 + i * 4)),
        ibFileEof: Number(h.readBigUInt64LE(184)),
        ibAMapLast: Number(h.readBigUInt64LE(192)),
        cbAMapFree: Number(h.readBigUInt64LE(200)),
        cbPMapFree: Number(h.readBigUInt64LE(208)),
        nbt: { bid: Number(h.readBigUInt64LE(216)), ib: Number(h.readBigUInt64LE(224)) },
        bbt: { bid: Number(h.readBigUInt64LE(232)), ib: Number(h.readBigUInt64LE(240)) },
        fAMapValid: h[248],
        bCryptMethod: h[513],
        bidNextB: Number(h.readBigUInt64LE(516)),
      };
      if (h.readUInt32LE(524) !== crc32(h, 8, 8 + 516)) throw new PstFormatError('PST header checksum mismatch (file may be damaged)');
    } else if (wVer === 14 || wVer === 15) {
      this.fmt = ANSI;
      this.header = {
        raw: h,
        bidNextB: h.readUInt32LE(24),
        bidNextP: h.readUInt32LE(28),
        dwUnique: h.readUInt32LE(32),
        rgnid: Array.from({ length: 32 }, (_, i) => h.readUInt32LE(36 + i * 4)),
        ibFileEof: h.readUInt32LE(168),
        ibAMapLast: h.readUInt32LE(172),
        cbAMapFree: h.readUInt32LE(176),
        cbPMapFree: h.readUInt32LE(180),
        nbt: { bid: h.readUInt32LE(184), ib: h.readUInt32LE(188) },
        bbt: { bid: h.readUInt32LE(192), ib: h.readUInt32LE(196) },
        fAMapValid: h[200],
        bCryptMethod: h[461],
      };
    } else {
      throw new PstFormatError(`Unsupported PST version ${wVer}`);
    }
    if (![crypt.CRYPT_NONE, crypt.CRYPT_PERMUTE, crypt.CRYPT_CYCLIC].includes(this.header.bCryptMethod)) {
      throw new PstFormatError(`Unknown PST encryption method ${this.header.bCryptMethod}`);
    }
  }

  writeHeader() {
    const hd = this.header;
    const h = Buffer.from(hd.raw);
    h.writeBigUInt64LE(BigInt(hd.bidNextP), 32);
    h.writeUInt32LE(hd.dwUnique >>> 0, 40);
    hd.rgnid.forEach((v, i) => h.writeUInt32LE(v >>> 0, 44 + i * 4));
    h.writeBigUInt64LE(BigInt(hd.ibFileEof), 184);
    h.writeBigUInt64LE(BigInt(hd.ibAMapLast), 192);
    h.writeBigUInt64LE(BigInt(hd.cbAMapFree), 200);
    h.writeBigUInt64LE(BigInt(hd.cbPMapFree), 208);
    h.writeBigUInt64LE(BigInt(hd.nbt.bid), 216);
    h.writeBigUInt64LE(BigInt(hd.nbt.ib), 224);
    h.writeBigUInt64LE(BigInt(hd.bbt.bid), 232);
    h.writeBigUInt64LE(BigInt(hd.bbt.ib), 240);
    h[248] = hd.fAMapValid;
    h[513] = hd.bCryptMethod;
    h.writeBigUInt64LE(BigInt(hd.bidNextB), 516);
    h.writeUInt32LE(crc32(h, 8, 8 + 471), 4);
    h.writeUInt32LE(crc32(h, 8, 8 + 516), 524);
    this.write(0, h);
    hd.raw = h;
  }

  // ---------------------------------------------------------------- pages and B-trees
  readPage(ib) {
    const cached = this.pageCache.get(ib);
    if (cached) return cached;
    const buf = this.read(ib, PAGE);
    if (this.pageCache.size > 4096) this.pageCache.clear();
    this.pageCache.set(ib, buf);
    return buf;
  }

  pageType(buf) {
    return buf[this.fmt.pageData];
  }

  /** Parses a BT page (NBT or BBT) into { level, entries }. */
  parseBtPage(buf, isNbt) {
    const f = this.fmt;
    const cEnt = buf[f.btEntries];
    const cbEnt = buf[f.btEntries + 2];
    const cLevel = buf[f.btEntries + 3];
    const ptype = this.pageType(buf);
    if (ptype !== (isNbt ? PTYPE.NBT : PTYPE.BBT)) throw new PstFormatError(`Expected ${isNbt ? 'NBT' : 'BBT'} page, found type 0x${ptype.toString(16)}`);
    const entries = [];
    for (let i = 0; i < cEnt; i++) {
      const o = i * cbEnt;
      if (cLevel > 0) {
        entries.push({ key: readPtr(buf, o, f), bid: readPtr(buf, o + f.ptrSize, f), ib: readPtr(buf, o + 2 * f.ptrSize, f) });
      } else if (isNbt) {
        entries.push({
          nid: buf.readUInt32LE(o),
          bidData: readPtr(buf, o + f.ptrSize, f),
          bidSub: readPtr(buf, o + 2 * f.ptrSize, f),
          nidParent: buf.readUInt32LE(o + 3 * f.ptrSize),
        });
      } else {
        entries.push({ bid: readPtr(buf, o, f), ib: readPtr(buf, o + f.ptrSize, f), cb: buf.readUInt16LE(o + 2 * f.ptrSize), cRef: buf.readUInt16LE(o + 2 * f.ptrSize + 2) });
      }
    }
    return { level: cLevel, entries };
  }

  btSearch(root, key, isNbt) {
    let ref = root;
    for (;;) {
      const page = this.parseBtPage(this.readPage(ref.ib), isNbt);
      if (page.level === 0) {
        return page.entries.find((e) => (isNbt ? e.nid === key : bidKey(e.bid) === key)) || null;
      }
      let next = null;
      for (const e of page.entries) {
        if (e.key <= key) next = e;
        else break;
      }
      if (!next) return null;
      ref = next;
    }
  }

  *btWalk(root, isNbt) {
    const page = this.parseBtPage(this.readPage(root.ib), isNbt);
    if (page.level === 0) yield* page.entries;
    else for (const e of page.entries) yield* this.btWalk(e, isNbt);
  }

  // ---------------------------------------------------------------- nodes and blocks
  getNode(nid) {
    if (this.txn) {
      const pending = this.txn.nodes.get(nid);
      if (pending !== undefined) return pending; // null = deleted in this transaction
    }
    return this.btSearch(this.header.nbt, nid, true);
  }

  *allNodes() {
    if (!this.txn) {
      yield* this.btWalk(this.header.nbt, true);
      return;
    }
    const seen = new Set();
    for (const n of this.btWalk(this.header.nbt, true)) {
      seen.add(n.nid);
      const p = this.txn.nodes.get(n.nid);
      if (p === undefined) yield n;
      else if (p) yield p;
    }
    for (const [nid, n] of this.txn.nodes) if (n && !seen.has(nid)) yield n;
  }

  getBlockRef(bid) {
    if (this.txn) {
      const pending = this.txn.blocks.get(bidKey(bid));
      if (pending) return pending;
    }
    const ref = this.btSearch(this.header.bbt, bidKey(bid), false);
    if (!ref) throw new PstFormatError(`Block 0x${bid.toString(16)} not found`);
    return ref;
  }

  /** Raw (decoded) contents of a single block. */
  readBlock(bid) {
    const ref = this.getBlockRef(bid);
    const data = this.read(ref.ib, ref.cb);
    return isInternalBid(bid) ? data : crypt.decode(data, this.header.bCryptMethod);
  }

  /** Data tree → list of leaf data blocks (HN pages and row-matrix blocks are addressed per block). */
  readDataBlocks(bid) {
    if (!bid) return [];
    if (!isInternalBid(bid)) return [this.readBlock(bid)];
    const x = this.readBlock(bid);
    const btype = x[0];
    const cLevel = x[1];
    if (btype !== 0x01) throw new PstFormatError(`Expected XBLOCK, got btype ${btype}`);
    const cEnt = x.readUInt16LE(2);
    const out = [];
    for (let i = 0; i < cEnt; i++) {
      const child = readPtr(x, 8 + i * this.fmt.ptrSize, this.fmt);
      if (cLevel === 1) out.push(this.readBlock(child));
      else out.push(...this.readDataBlocks(child));
    }
    return out;
  }

  readData(bid) {
    return Buffer.concat(this.readDataBlocks(bid));
  }

  /** BIDs of every block in a data tree, including the XBLOCKs (for reference counting). */
  dataTreeBids(bid) {
    if (!bid) return [];
    if (!isInternalBid(bid)) return [bid];
    const x = this.readBlock(bid);
    const out = [bid];
    const cEnt = x.readUInt16LE(2);
    for (let i = 0; i < cEnt; i++) out.push(...this.dataTreeBids(readPtr(x, 8 + i * this.fmt.ptrSize, this.fmt)));
    return out;
  }

  /** Subnode tree → Map(nid → {nid, bidData, bidSub}). */
  readSubnodes(bidSub) {
    const map = new Map();
    if (!bidSub) return map;
    const f = this.fmt;
    const walk = (bid) => {
      const b = this.readBlock(bid);
      if (b[0] !== 0x02) throw new PstFormatError(`Expected SLBLOCK/SIBLOCK, got btype ${b[0]}`);
      const cLevel = b[1];
      const cEnt = b.readUInt16LE(2);
      for (let i = 0; i < cEnt; i++) {
        if (cLevel === 0) {
          const o = f.sbHeader + i * f.slEnt;
          const nid = b.readUInt32LE(o);
          map.set(nid, { nid, bidData: readPtr(b, o + f.ptrSize, f), bidSub: readPtr(b, o + 2 * f.ptrSize, f) });
        } else {
          const o = f.sbHeader + i * f.siEnt;
          walk(readPtr(b, o + f.ptrSize, f));
        }
      }
    };
    walk(bidSub);
    return map;
  }

  subnodeTreeBids(bidSub) {
    if (!bidSub) return [];
    const f = this.fmt;
    const out = [bidSub];
    const b = this.readBlock(bidSub);
    const cEnt = b.readUInt16LE(2);
    for (let i = 0; i < cEnt; i++) {
      if (b[1] === 0) {
        const o = f.sbHeader + i * f.slEnt;
        out.push(...this.dataTreeBids(readPtr(b, o + f.ptrSize, f)), ...this.subnodeTreeBids(readPtr(b, o + 2 * f.ptrSize, f)));
      } else {
        out.push(...this.subnodeTreeBids(readPtr(b, f.sbHeader + i * f.siEnt + f.ptrSize, f)));
      }
    }
    return out;
  }
}

module.exports = { Ndb, PstFormatError, readPtr, writePtr, isInternalBid, bidKey, PAGE, BLOCK_ALIGN, MAX_BLOCK, INVALID_AMAP, VALID_AMAP2, UNICODE, ANSI, AMAP_FIRST, AMAP_COVERAGE, DLIST_OFFSET, computeSig, crc32 };
