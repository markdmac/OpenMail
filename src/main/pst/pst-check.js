'use strict';
// Structural integrity checker for PST files (a small "scanpst"): verifies B-tree pages, block trailers,
// reference counts, allocation maps and heap structures. Returns a list of problems (empty = healthy).

const { Ndb, isInternalBid, bidKey, PAGE, BLOCK_ALIGN, AMAP_FIRST, AMAP_COVERAGE } = require('./ndb');
const { crc32, computeSig } = require('./crc');
const { HeapReader } = require('./ltp');

function checkPst(file, { deep = true, log = () => {} } = {}) {
  const ndb = Ndb.open(file, { readOnly: true });
  const problems = [];
  const bad = (msg) => problems.push(msg);
  const f = ndb.fmt;
  if (!f.unicode) {
    ndb.close();
    return { problems: [], note: 'ANSI file: structural check limited' };
  }
  try {
    const used = []; // [ib, size, what]
    // ---- B-tree pages
    const walkPages = (ref, isNbt, lo, path) => {
      const page = ndb.read(ref.ib, PAGE);
      const t = page[496];
      if (t !== (isNbt ? 0x81 : 0x80) || page[497] !== t) bad(`${path}: page @0x${ref.ib.toString(16)} has type 0x${t.toString(16)}`);
      if (page.readUInt32LE(500) !== crc32(page, 0, 496)) bad(`${path}: page @0x${ref.ib.toString(16)} CRC mismatch`);
      if (page.readUInt16LE(498) !== computeSig(ref.ib, ref.bid)) bad(`${path}: page @0x${ref.ib.toString(16)} signature mismatch`);
      if (Number(page.readBigUInt64LE(504)) !== ref.bid) bad(`${path}: page @0x${ref.ib.toString(16)} BID mismatch`);
      used.push([ref.ib, PAGE, `${path} page`]);
      const p = ndb.parseBtPage(page, isNbt);
      const keys = p.entries.map((e) => (p.level > 0 ? e.key : isNbt ? e.nid : bidKey(e.bid)));
      for (let i = 1; i < keys.length; i++) if (keys[i] <= keys[i - 1]) bad(`${path}: keys out of order at level ${p.level}`);
      if (keys.length && keys[0] < lo) bad(`${path}: first key below parent key`);
      if (p.level > 0) p.entries.forEach((e, i) => walkPages(e, isNbt, e.key, `${path}/${i}`));
    };
    walkPages(ndb.header.nbt, true, 0, 'NBT');
    walkPages(ndb.header.bbt, false, 0, 'BBT');

    // ---- blocks
    const bbt = new Map();
    for (const b of ndb.btWalk(ndb.header.bbt, false)) bbt.set(bidKey(b.bid), b);
    const refs = new Map();
    const ref = (bid, who) => {
      const k = bidKey(bid);
      if (!bbt.has(k)) {
        bad(`${who}: block 0x${bid.toString(16)} missing from BBT`);
        return false;
      }
      refs.set(k, (refs.get(k) || 0) + 1);
      return true;
    };
    const walkData = (bid, who) => {
      if (!bid) return;
      if (!ref(bid, who)) return;
      if (isInternalBid(bid)) {
        const x = ndb.readBlock(bid);
        if (x[0] !== 0x01) return bad(`${who}: expected XBLOCK at 0x${bid.toString(16)}`);
        const cEnt = x.readUInt16LE(2);
        let total = 0;
        for (let i = 0; i < cEnt; i++) {
          const child = Number(x.readBigUInt64LE(8 + i * 8));
          walkData(child, who);
          try {
            total += x[1] === 1 ? ndb.getBlockRef(child).cb : ndb.readBlock(child).readUInt32LE(4);
          } catch {
            /* reported above */
          }
        }
        if (total !== x.readUInt32LE(4)) bad(`${who}: XBLOCK 0x${bid.toString(16)} lcbTotal ${x.readUInt32LE(4)} != ${total}`);
      }
    };
    const walkSub = (bid, who) => {
      if (!bid) return;
      if (!ref(bid, who)) return;
      const b = ndb.readBlock(bid);
      if (b[0] !== 0x02) return bad(`${who}: expected SLBLOCK/SIBLOCK at 0x${bid.toString(16)}`);
      const cEnt = b.readUInt16LE(2);
      let prev = -1;
      for (let i = 0; i < cEnt; i++) {
        if (b[1] === 0) {
          const o = 8 + i * 24;
          const nid = b.readUInt32LE(o);
          if (nid <= prev) bad(`${who}: subnodes out of order`);
          prev = nid;
          walkData(Number(b.readBigUInt64LE(o + 8)), `${who}>0x${nid.toString(16)}`);
          walkSub(Number(b.readBigUInt64LE(o + 16)), `${who}>0x${nid.toString(16)}`);
        } else {
          walkSub(Number(b.readBigUInt64LE(8 + i * 16 + 8)), who);
        }
      }
    };
    let nodeCount = 0;
    let leaks = 0;
    for (const n of ndb.btWalk(ndb.header.nbt, true)) {
      nodeCount++;
      const who = `node 0x${n.nid.toString(16)}`;
      walkData(n.bidData, who);
      walkSub(n.bidSub, who);
      if (deep && n.bidData) {
        try {
          const pages = ndb.readDataBlocks(n.bidData);
          if (pages[0] && pages[0][2] === 0xec) checkHeap(pages, who, bad);
        } catch (e) {
          bad(`${who}: ${e.message}`);
        }
      }
    }
    for (const [k, b] of bbt) {
      const n = refs.get(k) || 0;
      if (n === 0) leaks++; // Outlook leaves these too; harmless
      else if (b.cRef !== n + 1) bad(`block 0x${b.bid.toString(16)} cRef ${b.cRef}, expected ${n + 1}`);
      used.push([b.ib, Math.ceil((b.cb + 16) / BLOCK_ALIGN) * BLOCK_ALIGN, `block 0x${b.bid.toString(16)}`]);
      if (deep) {
        const size = Math.ceil((b.cb + 16) / BLOCK_ALIGN) * BLOCK_ALIGN;
        const raw = ndb.read(b.ib, size);
        const t = size - 16;
        if (raw.readUInt16LE(t) !== b.cb) bad(`block 0x${b.bid.toString(16)} trailer cb mismatch`);
        if (raw.readUInt16LE(t + 2) !== computeSig(b.ib, b.bid)) bad(`block 0x${b.bid.toString(16)} signature mismatch`);
        if (raw.readUInt32LE(t + 4) !== crc32(raw, 0, b.cb)) bad(`block 0x${b.bid.toString(16)} CRC mismatch`);
        if (Number(raw.readBigUInt64LE(t + 8)) !== b.bid) bad(`block 0x${b.bid.toString(16)} trailer BID mismatch`);
      }
    }

    // ---- allocation maps: allocated bits must equal exactly the space in use
    const amapCount = Math.floor((ndb.header.ibAMapLast - AMAP_FIRST) / AMAP_COVERAGE) + 1;
    const expect = new Map(); // unit index → what
    const markUse = (ib, size, what) => {
      for (let u = (ib - AMAP_FIRST) / 64; u < (ib - AMAP_FIRST + size) / 64; u++) {
        if (expect.has(u)) bad(`overlap at 0x${(AMAP_FIRST + u * 64).toString(16)}: ${expect.get(u)} and ${what}`);
        expect.set(u, what);
      }
    };
    for (let i = 0; i < amapCount; i++) {
      const ib = AMAP_FIRST + i * AMAP_COVERAGE;
      markUse(ib, PAGE, 'AMap');
      let slot = 1;
      if (i % 8 === 0) markUse(ib + PAGE * slot++, PAGE, 'PMap');
      if (i >= 128 && (i - 128) % 496 === 0) markUse(ib + PAGE * slot++, PAGE, 'FMap');
      if (i >= 8192 && (i - 8192) % (496 * 8 * 8) === 0) markUse(ib + PAGE * slot++, PAGE, 'FPMap');
    }
    for (const [ib, size, what] of used) markUse(ib, size, what);
    let free = 0;
    for (let i = 0; i < amapCount; i++) {
      const ib = AMAP_FIRST + i * AMAP_COVERAGE;
      const page = ndb.read(ib, PAGE);
      if (page[496] !== 0x84) bad(`AMap #${i} missing`);
      if (page.readUInt32LE(500) !== crc32(page, 0, 496)) bad(`AMap #${i} CRC mismatch`);
      for (let bit = 0; bit < 496 * 8; bit++) {
        const u = i * 496 * 8 + bit;
        const set = (page[bit >> 3] & (0x80 >> (bit & 7))) !== 0;
        if (!set) free++;
        if (set && !expect.has(u)) bad(`AMap #${i}: 0x${(AMAP_FIRST + u * 64).toString(16)} marked used but nothing is there`);
        if (!set && expect.has(u)) bad(`AMap #${i}: 0x${(AMAP_FIRST + u * 64).toString(16)} (${expect.get(u)}) not marked used`);
      }
    }
    if (free * 64 !== ndb.header.cbAMapFree) bad(`header cbAMapFree ${ndb.header.cbAMapFree} != ${free * 64}`);
    const maxEnd = Math.max(...used.map(([ib, size]) => ib + size));
    if (maxEnd > ndb.header.ibFileEof) bad(`data beyond ibFileEof`);
    log(`${nodeCount} nodes, ${bbt.size} blocks checked${leaks ? `, ${leaks} unreferenced blocks (harmless)` : ''}`);
  } finally {
    ndb.close();
  }
  return { problems: [...new Set(problems)] };
}

function checkHeap(pages, who, bad) {
  pages.forEach((p, i) => {
    const ib = p.readUInt16LE(0);
    if (ib >= p.length || ib % 2) return bad(`${who}: heap page ${i} bad ibHnpm ${ib}`);
    const cAlloc = p.readUInt16LE(ib);
    const end = ib + 4 + 2 * (cAlloc + 1);
    if (end > p.length) bad(`${who}: heap page ${i} page map overruns the block`);
    if (i < pages.length - 1 && p.length !== 8176) bad(`${who}: heap page ${i} is ${p.length} bytes; non-final heap pages must be 8176`);
    let prev = 0;
    for (let k = 0; k <= cAlloc; k++) {
      const o = p.readUInt16LE(ib + 4 + k * 2);
      if (o < prev || o > ib) bad(`${who}: heap page ${i} allocation offsets invalid`);
      prev = o;
    }
  });
  try {
    const h = new HeapReader(pages, new Map(), null);
    if (h.clientSig === 0xbc || h.clientSig === 0x7c) {
      const first = h.get(0x20);
      if (first[0] !== 0xb5) bad(`${who}: first heap allocation is not a BTH header`);
    }
  } catch (e) {
    bad(`${who}: ${e.message}`);
  }
}

module.exports = { checkPst };

if (require.main === module) {
  const r = checkPst(process.argv[2], { log: console.log });
  console.log(r.problems.length ? r.problems.slice(0, 50).join('\n') : 'OK: no problems found');
  if (r.problems.length > 50) console.log(`… and ${r.problems.length - 50} more`);
}
