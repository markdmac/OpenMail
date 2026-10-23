'use strict';
// Write support for the NDB layer (Unicode PST only): transactions, block/page allocation through the
// AMaps, copy-on-write B-tree updates, reference counting and crash-safe commits.
//
// Commit order: new blocks → new B-tree pages → header with fAMapValid=INVALID → AMaps → header with
// fAMapValid=VALID. If we crash part-way, the next open sees invalid AMaps and rebuilds them, exactly
// like Outlook does.

const { Ndb, PstFormatError, isInternalBid, bidKey, PAGE, BLOCK_ALIGN, INVALID_AMAP, VALID_AMAP2, AMAP_FIRST, AMAP_COVERAGE, DLIST_OFFSET } = require('./ndb');
const { crc32, computeSig } = require('./crc');
const crypt = require('./crypt');
const { PTYPE } = require('./constants');

const F = {
  pageData: 496,
  btEntries: 488,
  maxBlockData: 8176,
  maxXbEntries: Math.floor((8176 - 8) / 8),
  maxSlEntries: Math.floor((8176 - 8) / 24),
  maxSiEntries: Math.floor((8176 - 8) / 16),
};
const BT = {
  nbt: { cbEnt: 32, max: Math.floor(488 / 32), leafType: PTYPE.NBT },
  bbt: { cbEnt: 24, max: Math.floor(488 / 24), leafType: PTYPE.BBT },
  inner: { cbEnt: 24, max: Math.floor(488 / 24) },
};
const AMAP_BYTES = 496;
const AMAP_UNITS = AMAP_BYTES * 8;
// FMap pages cover 496 AMaps each, starting after the 128 AMaps covered by the header's rgbFM;
// FPMap pages hold one bit per PMap: the header's rgbFP covers the first 128*8 PMaps (8192 AMaps, 2 GB)
// and each FPMap page covers 496*8 PMaps after that. (Verified against Outlook that there is no FPMap
// at AMap #1024; the 2 GB position follows the same pattern as the FMap but has not been checked
// against an Outlook-made file that large.)
const isPmapIndex = (i) => i % 8 === 0;
const isFmapIndex = (i) => i >= 128 && (i - 128) % 496 === 0;
const isFpmapIndex = (i) => i >= 8192 && (i - 8192) % (496 * 8 * 8) === 0;

const align = (n, a) => Math.ceil(n / a) * a;
const blockSize = (cb) => align(cb + 16, BLOCK_ALIGN);

Object.assign(Ndb.prototype, {
  // ============================================================ space allocation (AMaps)
  loadAMaps() {
    if (this.amaps) return;
    this.amaps = [];
    const count = Math.max(1, Math.floor((this.header.ibAMapLast - AMAP_FIRST) / AMAP_COVERAGE) + 1);
    for (let i = 0; i < count; i++) {
      const ib = AMAP_FIRST + i * AMAP_COVERAGE;
      const page = this.read(ib, PAGE);
      if (page[F.pageData] !== PTYPE.AMAP) throw new PstFormatError(`Missing AMap page at 0x${ib.toString(16)}`);
      const bits = Buffer.from(page.subarray(0, AMAP_BYTES));
      this.amaps.push({ ib, bits, free: countFree(bits), dirty: false });
    }
    if (this.header.fAMapValid === INVALID_AMAP) this.rebuildAMaps();
    this.allocCursor = 0;
  },

  /** Recomputes every AMap from the B-trees (used after an interrupted commit). */
  rebuildAMaps() {
    for (const a of this.amaps) {
      a.bits.fill(0);
      this.reserveFixedPages(a, this.amaps.indexOf(a));
    }
    const mark = (ib, size) => this.markAllocated(ib, size, true);
    const walkPages = (ref, isNbt) => {
      mark(ref.ib, PAGE);
      const page = this.parseBtPage(this.readPage(ref.ib), isNbt);
      if (page.level > 0) for (const e of page.entries) walkPages(e, isNbt);
    };
    walkPages(this.header.nbt, true);
    walkPages(this.header.bbt, false);
    for (const b of this.btWalk(this.header.bbt, false)) mark(b.ib, blockSize(b.cb));
    for (const a of this.amaps) {
      a.free = countFree(a.bits);
      a.dirty = true;
    }
    this.header.fAMapValid = VALID_AMAP2;
    this.amapsRebuilt = true;
  },

  reserveFixedPages(amap, index) {
    amap.bits[0] = 0xff; // the AMap page itself
    let slot = 1;
    if (isPmapIndex(index)) amap.bits[slot++] = 0xff;
    if (isFmapIndex(index)) amap.bits[slot++] = 0xff;
    if (isFpmapIndex(index)) amap.bits[slot++] = 0xff;
    return slot;
  },

  markAllocated(ib, size, allocated) {
    const start = (ib - AMAP_FIRST) / BLOCK_ALIGN;
    const units = size / BLOCK_ALIGN;
    for (let u = start; u < start + units; u++) {
      const a = this.amaps[Math.floor(u / AMAP_UNITS)];
      if (!a) throw new PstFormatError(`Offset 0x${ib.toString(16)} is outside the AMap range`);
      const bit = u % AMAP_UNITS;
      const mask = 0x80 >> (bit & 7);
      const was = (a.bits[bit >> 3] & mask) !== 0;
      if (was === allocated) continue;
      if (allocated) a.bits[bit >> 3] |= mask;
      else a.bits[bit >> 3] &= ~mask;
      a.free += allocated ? -1 : 1;
      a.dirty = true;
    }
  },

  /** Allocates `size` bytes (multiple of 64; pages need 512-byte alignment). Returns the file offset. */
  allocate(size, isPage) {
    this.loadAMaps();
    const units = size / BLOCK_ALIGN;
    const n = this.amaps.length;
    for (let k = 0; k < n; k++) {
      const i = (this.allocCursor + k) % n;
      const a = this.amaps[i];
      if (a.free < units) continue;
      const bit = findRun(a.bits, units, isPage ? 8 : 1);
      if (bit >= 0) {
        this.allocCursor = i;
        const ib = a.ib + bit * BLOCK_ALIGN;
        this.markAllocated(ib, size, true);
        this.header.ibFileEof = Math.max(this.header.ibFileEof, ib + size);
        return ib;
      }
    }
    this.addAMap();
    return this.allocate(size, isPage);
  },

  release(ib, size) {
    this.txn.freeAfterCommit.push([ib, size]);
  },

  addAMap() {
    const index = this.amaps.length;
    const ib = AMAP_FIRST + index * AMAP_COVERAGE;
    const a = { ib, bits: Buffer.alloc(AMAP_BYTES), free: 0, dirty: true, isNew: true };
    const used = this.reserveFixedPages(a, index);
    a.free = countFree(a.bits);
    this.amaps.push(a);
    this.header.ibAMapLast = ib;
    this.header.ibFileEof = Math.max(this.header.ibFileEof, ib + used * PAGE);
    this.allocCursor = index;
  },

  writeMapPages() {
    let free = 0;
    this.amaps.forEach((a, index) => {
      free += a.free * BLOCK_ALIGN;
      if (!a.dirty) return;
      const page = Buffer.alloc(PAGE);
      a.bits.copy(page, 0);
      this.writePage(a.ib, page, PTYPE.AMAP, a.ib, false);
      if (a.isNew) {
        // Deprecated PMap/FMap/FPMap pages still have to exist at their fixed positions.
        let slot = 1;
        if (isPmapIndex(index)) this.writePage(a.ib + PAGE * slot++, Buffer.alloc(PAGE, 0xff), PTYPE.PMAP, a.ib + PAGE * (slot - 1), false);
        if (isFmapIndex(index)) this.writePage(a.ib + PAGE * slot++, Buffer.alloc(PAGE, 0xff), PTYPE.FMAP, a.ib + PAGE * (slot - 1), false);
        if (isFpmapIndex(index)) this.writePage(a.ib + PAGE * slot++, Buffer.alloc(PAGE, 0xff), PTYPE.FPMAP, a.ib + PAGE * (slot - 1), false);
        a.isNew = false;
      }
      a.dirty = false;
    });
    this.header.cbAMapFree = free;
    this.writeDList();
  },

  /**
   * Density list ([MS-PST] 2.2.2.7.4): AMap pages with the most free slots first. Outlook uses it to
   * pick where to allocate and to drive background compaction.
   */
  writeDList() {
    const page = Buffer.alloc(PAGE);
    const ents = this.amaps
      .map((a, i) => ({ i, free: a.free }))
      .filter((e) => e.free > 0)
      .sort((a, b) => b.free - a.free || a.i - b.i)
      .slice(0, 119);
    page[0] = 0x01; // DFL_BACKFILL_COMPLETE
    page[1] = ents.length;
    page.writeUInt32LE(this.allocCursor || 0, 4);
    ents.forEach((e, j) => page.writeUInt32LE(((Math.min(e.free, 0xfff) << 20) | (e.i & 0xfffff)) >>> 0, 8 + j * 4));
    this.writePage(DLIST_OFFSET, page, PTYPE.DL, this.header.bidNextP, true);
  },

  /** Writes a 512-byte page with its trailer. Map pages use the page offset as their BID and no signature. */
  writePage(ib, page, ptype, bid, withSig) {
    page[F.pageData] = ptype;
    page[F.pageData + 1] = ptype;
    page.writeUInt16LE(withSig ? computeSig(ib, bid) : 0, F.pageData + 2);
    page.writeUInt32LE(crc32(page, 0, F.pageData), F.pageData + 4);
    page.writeBigUInt64LE(BigInt(bid), F.pageData + 8);
    this.write(ib, page);
    this.pageCache.set(ib, page);
  },

  // ============================================================ transactions
  begin() {
    if (this.readOnly) throw new PstFormatError('PST is open read-only');
    if (this.txn) return this.txn;
    this.loadAMaps();
    this.txn = { nodes: new Map(), blocks: new Map(), refDelta: new Map(), freeAfterCommit: [], trees: { nbt: null, bbt: null } };
    return this.txn;
  },

  nextBid(internal) {
    const bid = this.header.bidNextB;
    this.header.bidNextB += 4;
    return internal ? bid | 2 : bid;
  },

  nextPageBid() {
    const bid = this.header.bidNextP;
    this.header.bidNextP += 1;
    return bid;
  },

  /** Writes one block and returns its BID. */
  writeBlock(data, internal = false) {
    this.begin();
    if (data.length > F.maxBlockData) throw new Error(`Block too large: ${data.length}`);
    const bid = this.nextBid(internal);
    const stored = internal ? data : crypt.encode(data, this.header.bCryptMethod);
    const size = blockSize(stored.length);
    const ib = this.allocate(size, false);
    const buf = Buffer.alloc(size);
    stored.copy(buf, 0);
    const t = size - 16;
    buf.writeUInt16LE(stored.length, t);
    buf.writeUInt16LE(computeSig(ib, bid), t + 2);
    buf.writeUInt32LE(crc32(stored), t + 4);
    buf.writeBigUInt64LE(BigInt(bid), t + 8);
    this.write(ib, buf);
    this.txn.blocks.set(bid, { bid, ib, cb: stored.length, cRef: 2, isNew: true });
    return bid;
  },

  /** Writes a data tree. `data` is a Buffer (split into 8176-byte blocks) or an array of block Buffers. */
  writeDataTree(data) {
    const blocks = Buffer.isBuffer(data) ? splitBlocks(data) : data;
    if (!blocks.length) return 0;
    const leaf = (b) => (Buffer.isBuffer(b) ? { bid: this.writeBlock(b), size: b.length } : { bid: b.reuseBid, size: b.size });
    if (blocks.length === 1) return leaf(blocks[0]).bid;
    let level = 1;
    let items = blocks.map(leaf);
    while (items.length > 1 || level === 1) {
      const next = [];
      for (let i = 0; i < items.length; i += F.maxXbEntries) {
        const chunk = items.slice(i, i + F.maxXbEntries);
        const x = Buffer.alloc(8 + 8 * chunk.length);
        x[0] = 0x01;
        x[1] = level;
        x.writeUInt16LE(chunk.length, 2);
        const total = chunk.reduce((s, c) => s + c.size, 0);
        x.writeUInt32LE(total, 4);
        chunk.forEach((c, j) => x.writeBigUInt64LE(BigInt(c.bid), 8 + j * 8));
        next.push({ bid: this.writeBlock(x, true), size: total });
      }
      items = next;
      level++;
      if (level > 3) throw new Error('Data tree too large');
    }
    return items[0].bid;
  },

  /** Writes a subnode tree from entries [{nid, bidData, bidSub}]. Returns the root BID (0 if empty). */
  writeSubnodeTree(entries) {
    if (!entries.length) return 0;
    const sorted = [...entries].sort((a, b) => (a.nid >>> 0) - (b.nid >>> 0));
    const leaves = [];
    for (let i = 0; i < sorted.length; i += F.maxSlEntries) {
      const chunk = sorted.slice(i, i + F.maxSlEntries);
      const b = Buffer.alloc(8 + 24 * chunk.length);
      b[0] = 0x02;
      b[1] = 0;
      b.writeUInt16LE(chunk.length, 2);
      chunk.forEach((e, j) => {
        const o = 8 + j * 24;
        b.writeBigUInt64LE(BigInt(e.nid >>> 0), o);
        b.writeBigUInt64LE(BigInt(e.bidData || 0), o + 8);
        b.writeBigUInt64LE(BigInt(e.bidSub || 0), o + 16);
      });
      leaves.push({ nid: chunk[0].nid, bid: this.writeBlock(b, true) });
    }
    if (leaves.length === 1) return leaves[0].bid;
    if (leaves.length > F.maxSiEntries) throw new Error('Too many subnodes');
    const b = Buffer.alloc(8 + 16 * leaves.length);
    b[0] = 0x02;
    b[1] = 1;
    b.writeUInt16LE(leaves.length, 2);
    leaves.forEach((l, j) => {
      b.writeBigUInt64LE(BigInt(l.nid >>> 0), 8 + j * 16);
      b.writeBigUInt64LE(BigInt(l.bid), 8 + j * 16 + 8);
    });
    return this.writeBlock(b, true);
  },

  /** Creates or replaces a node. Blocks no longer referenced by the old version are released. */
  putNode(entry) {
    this.begin();
    const old = this.getNode(entry.nid);
    const e = { nid: entry.nid >>> 0, bidData: entry.bidData || 0, bidSub: entry.bidSub || 0, nidParent: (entry.nidParent ?? old?.nidParent ?? 0) >>> 0 };
    this.txn.nodes.set(e.nid, e);
    if (old) this.releaseNodeBlocks(old, e);
    return e;
  },

  deleteNode(nid) {
    this.begin();
    const old = this.getNode(nid);
    if (!old) return;
    this.txn.nodes.set(nid >>> 0, null);
    this.releaseNodeBlocks(old, null);
  },

  /** Releases blocks reachable from `old` that the replacement no longer references. */
  releaseNodeBlocks(old, replacement) {
    const oldBids = [...this.dataTreeBids(old.bidData), ...this.subnodeTreeBids(old.bidSub)];
    if (!oldBids.length) return;
    const still = new Set();
    if (replacement) {
      for (const b of this.dataTreeBids(replacement.bidData)) still.add(bidKey(b));
      for (const b of this.subnodeTreeBids(replacement.bidSub)) still.add(bidKey(b));
    }
    for (const b of oldBids) if (!still.has(bidKey(b))) this.decRef(b);
  },

  /** Adds a reference to every block of a data tree (used when nodes share template data). */
  addRef(bidData) {
    for (const b of this.dataTreeBids(bidData)) {
      const k = bidKey(b);
      this.txn.refDelta.set(k, (this.txn.refDelta.get(k) || 0) + 1);
    }
  },

  /**
   * Like writeDataTree, but reuses blocks of the previous version whose contents are unchanged,
   * so rewriting a large table only writes the blocks that actually changed.
   */
  writeDataTreeReuse(data, oldBidData) {
    const blocks = Buffer.isBuffer(data) ? splitBlocks(data) : data;
    if (!oldBidData || !blocks.length) return this.writeDataTree(blocks);
    let oldLeaves;
    try {
      oldLeaves = this.dataLeafBids(oldBidData);
    } catch {
      return this.writeDataTree(blocks);
    }
    const reuse = blocks.map((b, i) => {
      const bid = oldLeaves[i];
      if (!bid) return 0;
      const ref = this.getBlockRef(bid);
      if (ref.cb !== b.length || ref.cRef > 2) return 0; // shared blocks are never reused in place
      return this.readBlock(bid).equals(b) ? bid : 0;
    });
    if (blocks.length === 1) return reuse[0] || this.writeBlock(blocks[0]);
    return this.writeDataTree(blocks.map((b, i) => (reuse[i] ? { reuseBid: reuse[i], size: b.length } : b)));
  },

  dataLeafBids(bid) {
    if (!bid) return [];
    if (!isInternalBid(bid)) return [bid];
    const x = this.readBlock(bid);
    const cEnt = x.readUInt16LE(2);
    const out = [];
    for (let i = 0; i < cEnt; i++) out.push(...this.dataLeafBids(Number(x.readBigUInt64LE(8 + i * 8))));
    return out;
  },

  /** Decrements a block's reference count; blocks reaching the "owned once" baseline minus one are freed. */
  decRef(bid) {
    const k = bidKey(bid);
    this.txn.refDelta.set(k, (this.txn.refDelta.get(k) || 0) - 1);
  },

  // ============================================================ B-tree editing (copy-on-write)
  tree(which) {
    const t = this.txn.trees;
    if (!t[which]) t[which] = this.loadTreeNode(this.header[which], which === 'nbt');
    return t[which];
  },

  loadTreeNode(ref, isNbt) {
    const page = this.parseBtPage(this.readPage(ref.ib), isNbt);
    return { ref: { bid: ref.bid, ib: ref.ib }, level: page.level, entries: page.entries, children: new Map(), dirty: false, isNbt };
  },

  child(node, i) {
    let c = node.children.get(i);
    if (!c) {
      c = this.loadTreeNode(node.entries[i], node.isNbt);
      node.children.set(i, c);
    }
    return c;
  },

  keyOf(entry, isNbt, level) {
    if (level > 0) return entry.key;
    return isNbt ? entry.nid >>> 0 : bidKey(entry.bid);
  },

  /** Insert, replace (same key) or delete (value null) one leaf entry. */
  treeSet(which, key, value) {
    const root = this.tree(which);
    const isNbt = which === 'nbt';
    const split = this.treeSetRec(root, key, value, isNbt);
    if (split) {
      // Root split: grow the tree by one level.
      const newRoot = { ref: null, level: root.level + 1, entries: [], children: new Map(), dirty: true, isNbt };
      [root, split].forEach((n, i) => {
        newRoot.entries.push({ key: this.firstKey(n), bid: 0, ib: 0 });
        newRoot.children.set(i, n);
      });
      this.txn.trees[which] = newRoot;
    }
    // Shrink the tree when the root is left with one child (or none).
    let r = this.txn.trees[which];
    while (r.level > 0 && r.entries.length <= 1) {
      if (r.ref) this.release(r.ref.ib, PAGE);
      r = r.entries.length ? this.child(r, 0) : { ref: null, level: 0, entries: [], children: new Map(), dirty: true, isNbt };
      r.dirty = true;
      this.txn.trees[which] = r;
    }
  },

  firstKey(node) {
    return node.entries.length ? this.keyOf(node.entries[0], node.isNbt, node.level) : 0;
  },

  treeSetRec(node, key, value, isNbt) {
    if (node.level === 0) {
      const idx = node.entries.findIndex((e) => this.keyOf(e, isNbt, 0) >= key);
      const exact = idx >= 0 && this.keyOf(node.entries[idx], isNbt, 0) === key;
      if (value === null) {
        if (exact) {
          node.entries.splice(idx, 1);
          node.dirty = true;
        }
        return null;
      }
      if (exact) node.entries[idx] = value;
      else if (idx < 0) node.entries.push(value);
      else node.entries.splice(idx, 0, value);
      node.dirty = true;
      return this.maybeSplit(node, isNbt ? BT.nbt.max : BT.bbt.max);
    }
    // Choose the child whose key range contains `key`.
    let i = 0;
    while (i + 1 < node.entries.length && node.entries[i + 1].key <= key) i++;
    const c = this.child(node, i);
    const split = this.treeSetRec(c, key, value, isNbt);
    node.dirty = node.dirty || c.dirty;
    if (c.entries.length === 0) {
      // Drop empty children at every level (an empty subtree would otherwise carry a bogus key of 0
      // and misroute later lookups). This node may itself become empty; its parent removes it.
      if (c.ref) this.release(c.ref.ib, PAGE);
      node.entries.splice(i, 1);
      const kids = new Map();
      for (const [j, n] of node.children) if (j !== i) kids.set(j > i ? j - 1 : j, n);
      node.children = kids;
      node.dirty = true;
    } else {
      node.entries[i].key = this.firstKey(c);
    }
    if (split) {
      node.entries.splice(i + 1, 0, { key: this.firstKey(split), bid: 0, ib: 0 });
      const kids = new Map();
      for (const [j, n] of node.children) kids.set(j > i ? j + 1 : j, n);
      kids.set(i + 1, split);
      node.children = kids;
      node.dirty = true;
      return this.maybeSplit(node, BT.inner.max);
    }
    return null;
  },

  maybeSplit(node, max) {
    if (node.entries.length <= max) return null;
    const half = Math.ceil(node.entries.length / 2);
    const right = { ref: null, level: node.level, entries: node.entries.slice(half), children: new Map(), dirty: true, isNbt: node.isNbt };
    for (const [j, n] of node.children) if (j >= half) right.children.set(j - half, n);
    node.entries = node.entries.slice(0, half);
    for (const j of [...node.children.keys()]) if (j >= half) node.children.delete(j);
    node.dirty = true;
    return right;
  },

  /** Writes dirty B-tree pages bottom-up to new locations; returns the root BREF. */
  flushTree(node) {
    if (!node.dirty) return node.ref;
    if (node.level > 0) {
      for (const [i, c] of node.children) {
        const ref = this.flushTree(c);
        node.entries[i].bid = ref.bid;
        node.entries[i].ib = ref.ib;
        node.entries[i].key = this.firstKey(c);
      }
    }
    const page = Buffer.alloc(PAGE);
    const isLeaf = node.level === 0;
    const spec = isLeaf ? (node.isNbt ? BT.nbt : BT.bbt) : BT.inner;
    node.entries.forEach((e, j) => {
      const o = j * spec.cbEnt;
      if (!isLeaf) {
        page.writeBigUInt64LE(BigInt(e.key), o);
        page.writeBigUInt64LE(BigInt(e.bid), o + 8);
        page.writeBigUInt64LE(BigInt(e.ib), o + 16);
      } else if (node.isNbt) {
        page.writeBigUInt64LE(BigInt(e.nid >>> 0), o);
        page.writeBigUInt64LE(BigInt(e.bidData), o + 8);
        page.writeBigUInt64LE(BigInt(e.bidSub), o + 16);
        page.writeUInt32LE(e.nidParent >>> 0, o + 24);
      } else {
        page.writeBigUInt64LE(BigInt(e.bid), o);
        page.writeBigUInt64LE(BigInt(e.ib), o + 8);
        page.writeUInt16LE(e.cb, o + 16);
        page.writeUInt16LE(e.cRef, o + 18);
      }
    });
    page[F.btEntries] = node.entries.length;
    page[F.btEntries + 1] = spec.max;
    page[F.btEntries + 2] = spec.cbEnt;
    page[F.btEntries + 3] = node.level;
    if (node.ref) this.release(node.ref.ib, PAGE);
    const ib = this.allocate(PAGE, true);
    const bid = this.nextPageBid();
    this.writePage(ib, page, node.isNbt ? PTYPE.NBT : PTYPE.BBT, bid, true);
    node.ref = { bid, ib };
    node.dirty = false;
    return node.ref;
  },

  // ============================================================ commit
  commit() {
    const txn = this.txn;
    if (!txn) return;
    // Node changes.
    for (const [nid, e] of txn.nodes) this.treeSet('nbt', nid >>> 0, e);
    // Block reference changes: new blocks in, released blocks out.
    for (const [k, b] of txn.blocks) {
      const delta = txn.refDelta.get(k) || 0;
      txn.refDelta.delete(k);
      if (b.cRef + delta < 2) this.release(b.ib, blockSize(b.cb)); // written and released in the same txn
      else this.treeSet('bbt', k, { bid: b.bid, ib: b.ib, cb: b.cb, cRef: b.cRef + delta });
    }
    for (const [k, delta] of txn.refDelta) {
      if (!delta) continue;
      const b = this.btSearch(this.header.bbt, k, false);
      if (!b) continue;
      const cRef = b.cRef + delta;
      if (cRef < 2) {
        this.treeSet('bbt', k, null);
        this.release(b.ib, blockSize(b.cb));
      } else {
        this.treeSet('bbt', k, { ...b, cRef });
      }
    }
    if (txn.trees.nbt) this.header.nbt = this.flushTree(txn.trees.nbt);
    if (txn.trees.bbt) this.header.bbt = this.flushTree(txn.trees.bbt);

    // Phase 1: point the header at the new trees, marking AMaps as being updated.
    this.header.fAMapValid = INVALID_AMAP;
    this.header.dwUnique = (this.header.dwUnique + 1) >>> 0;
    this.writeHeader();
    // Phase 2: free superseded space and write the maps, then mark them valid.
    for (const [ib, size] of txn.freeAfterCommit) {
      this.markAllocated(ib, size, false);
      for (let p = ib; p < ib + size; p += PAGE) this.pageCache.delete(p);
    }
    this.writeMapPages();
    this.header.fAMapValid = VALID_AMAP2;
    this.writeHeader();
    this.txn = null;
    this.pageCache.clear();
  },

  rollback() {
    // Space allocated in this transaction is still marked used in memory; reload maps from disk.
    this.txn = null;
    this.amaps = null;
    this.pageCache.clear();
    this.readHeader();
  },
});

function splitBlocks(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += F.maxBlockData) out.push(buf.subarray(i, i + F.maxBlockData));
  return out;
}

function countFree(bits) {
  let free = 0;
  for (let i = 0; i < bits.length; i++) {
    let b = ~bits[i] & 0xff;
    while (b) {
      free += b & 1;
      b >>= 1;
    }
  }
  return free;
}

/** First run of `units` zero bits starting on a multiple of `alignBits`; -1 if none. */
function findRun(bits, units, alignBits) {
  const total = bits.length * 8;
  let start = 0;
  while (start + units <= total) {
    if (alignBits === 8 && units === 8) {
      // Fast path for pages: a whole zero byte.
      const idx = bits.indexOf(0, start >> 3);
      if (idx < 0) return -1;
      return idx * 8;
    }
    let ok = true;
    for (let u = start; u < start + units; u++) {
      if (bits[u >> 3] & (0x80 >> (u & 7))) {
        ok = false;
        start = alignBits === 1 ? u + 1 : align(u + 1, alignBits);
        break;
      }
    }
    if (ok) return start;
  }
  return -1;
}

module.exports = { Ndb, blockSize, F, isPmapIndex, isFmapIndex, isFpmapIndex };
