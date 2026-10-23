'use strict';
// Minimal Compound File Binary (MS-CFB, version 3) writer.
// Enough to produce Outlook .msg files: storages, streams, mini stream, DIFAT.

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

class Storage {
  constructor(name) {
    this.name = name;
    this.type = TYPE_STORAGE;
    this.children = new Map();
  }
  storage(name) {
    let s = this.children.get(name);
    if (!s) {
      s = new Storage(name);
      this.children.set(name, s);
    } else if (s.type !== TYPE_STORAGE) {
      throw new Error(`"${name}" is a stream, not a storage`);
    }
    return s;
  }
  stream(name, data) {
    if (name.length > 31) throw new Error(`CFB name too long: ${name}`);
    this.children.set(name, { name, type: TYPE_STREAM, data: Buffer.from(data) });
    return this;
  }
}

// CFB sibling ordering: shorter names first, then case-insensitive compare.
function compareNames(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

class CompoundFile {
  constructor() {
    this.root = new Storage('Root Entry');
    this.root.type = TYPE_ROOT;
  }

  toBuffer() {
    // 1. Flatten directory entries (DFS so ids are stable).
    const entries = [];
    const visit = (node) => {
      const entry = { node, id: entries.length, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, color: 1, start: ENDOFCHAIN, size: 0 };
      entries.push(entry);
      node._entry = entry;
      if (node.type !== TYPE_STREAM) {
        const kids = [...node.children.values()].sort((a, b) => compareNames(a.name, b.name));
        kids.forEach(visit);
        entry.child = buildTree(kids.map((k) => k._entry));
      }
    };
    visit(this.root);

    // 2. Split streams between the mini stream and regular sectors.
    const miniChunks = [];
    const miniFat = [];
    const bigStreams = [];
    for (const e of entries) {
      if (e.node.type !== TYPE_STREAM) continue;
      const data = e.node.data;
      e.size = data.length;
      if (data.length === 0) continue;
      if (data.length < MINI_CUTOFF) {
        const count = Math.ceil(data.length / MINI_SECTOR);
        e.start = miniFat.length;
        for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? ENDOFCHAIN : miniFat.length + 1);
        miniChunks.push(pad(data, MINI_SECTOR));
      } else {
        bigStreams.push(e);
      }
    }
    const miniStream = Buffer.concat(miniChunks);

    // 3. Lay out regular sectors: big streams, mini stream, mini FAT, directory, FAT, DIFAT.
    const chains = []; // [startSector, sectorCount]
    const contents = [];
    let next = 0;
    const place = (buf) => {
      const count = Math.ceil(buf.length / SECTOR);
      const start = count ? next : ENDOFCHAIN;
      if (count) {
        chains.push([start, count]);
        contents.push(pad(buf, SECTOR));
        next += count;
      }
      return start;
    };

    for (const e of bigStreams) e.start = place(e.node.data);
    const rootEntry = entries[0];
    rootEntry.start = place(miniStream);
    rootEntry.size = miniStream.length;

    const miniFatBuf = Buffer.alloc(miniFat.length * 4);
    miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, i * 4));
    const miniFatStart = place(miniFatBuf);
    const miniFatSectors = Math.ceil(miniFatBuf.length / SECTOR);

    const dirBuf = Buffer.alloc(Math.ceil(entries.length / 4) * SECTOR);
    // Directory is written after we know every start sector; reserve space now.
    const dirStart = next;
    chains.push([dirStart, dirBuf.length / SECTOR]);
    next += dirBuf.length / SECTOR;

    const contentSectors = next;
    let fatSectors = 1;
    let difatSectors = 0;
    for (;;) {
      difatSectors = fatSectors > 109 ? Math.ceil((fatSectors - 109) / 127) : 0;
      const needed = Math.ceil((contentSectors + fatSectors + difatSectors) / 128);
      if (needed <= fatSectors) break;
      fatSectors = needed;
    }

    const fat = new Uint32Array(fatSectors * 128).fill(FREESECT);
    for (const [start, count] of chains) {
      for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? ENDOFCHAIN : start + i + 1;
    }
    const fatStart = contentSectors;
    for (let i = 0; i < fatSectors; i++) fat[fatStart + i] = FATSECT;
    const difatStart = fatStart + fatSectors;
    for (let i = 0; i < difatSectors; i++) fat[difatStart + i] = DIFSECT;

    // 4. Directory entries.
    entries.forEach((e, i) => writeDirEntry(dirBuf, i * 128, e));
    for (let i = entries.length; i < dirBuf.length / 128; i++) writeEmptyDirEntry(dirBuf, i * 128);

    // 5. Header.
    const header = Buffer.alloc(SECTOR);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
    header.writeUInt16LE(0x003e, 24);
    header.writeUInt16LE(0x0003, 26);
    header.writeUInt16LE(0xfffe, 28);
    header.writeUInt16LE(9, 30);
    header.writeUInt16LE(6, 32);
    header.writeUInt32LE(0, 40);
    header.writeUInt32LE(fatSectors, 44);
    header.writeUInt32LE(dirStart, 48);
    header.writeUInt32LE(0, 52);
    header.writeUInt32LE(MINI_CUTOFF, 56);
    header.writeUInt32LE(miniFatSectors ? miniFatStart : ENDOFCHAIN, 60);
    header.writeUInt32LE(miniFatSectors, 64);
    header.writeUInt32LE(difatSectors ? difatStart : ENDOFCHAIN, 68);
    header.writeUInt32LE(difatSectors, 72);
    for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? fatStart + i : FREESECT, 76 + i * 4);

    const fatBuf = Buffer.from(fat.buffer, fat.byteOffset, fat.byteLength);
    // Buffer.from on a Uint32Array uses platform endianness; Node on x86/ARM is little-endian as CFB requires.

    const difatBuf = Buffer.alloc(difatSectors * SECTOR);
    for (let d = 0; d < difatSectors; d++) {
      const base = d * SECTOR;
      for (let j = 0; j < 127; j++) {
        const idx = 109 + d * 127 + j;
        difatBuf.writeUInt32LE(idx < fatSectors ? fatStart + idx : FREESECT, base + j * 4);
      }
      difatBuf.writeUInt32LE(d === difatSectors - 1 ? ENDOFCHAIN : difatStart + d + 1, base + 508);
    }

    return Buffer.concat([header, ...contents, dirBuf, fatBuf, difatBuf]);
  }
}

// Build a balanced binary tree from sorted siblings and colour it as a valid red-black tree:
// every node is black except those on the deepest level, which are red.
function buildTree(sorted) {
  if (!sorted.length) return NOSTREAM;
  const depthOf = new Map();
  let maxDepth = 0;
  const build = (lo, hi, depth) => {
    if (lo > hi) return NOSTREAM;
    const mid = (lo + hi) >> 1;
    const e = sorted[mid];
    depthOf.set(e, depth);
    if (depth > maxDepth) maxDepth = depth;
    e.left = build(lo, mid - 1, depth + 1);
    e.right = build(mid + 1, hi, depth + 1);
    return e.id;
  };
  const rootId = build(0, sorted.length - 1, 0);
  for (const [e, d] of depthOf) e.color = maxDepth > 0 && d === maxDepth ? 0 : 1;
  return rootId;
}

function writeDirEntry(buf, off, e) {
  const name = e.node.name;
  buf.write(name, off, 'utf16le');
  buf.writeUInt16LE((name.length + 1) * 2, off + 64);
  buf.writeUInt8(e.node.type, off + 66);
  buf.writeUInt8(e.color, off + 67);
  buf.writeUInt32LE(e.left, off + 68);
  buf.writeUInt32LE(e.right, off + 72);
  buf.writeUInt32LE(e.child, off + 76);
  // CLSID, state bits and timestamps stay zero.
  const isStorage = e.node.type === TYPE_STORAGE;
  buf.writeUInt32LE(isStorage ? 0 : e.start, off + 116);
  buf.writeUInt32LE(isStorage ? 0 : e.size, off + 120);
  buf.writeUInt32LE(0, off + 124);
}

function writeEmptyDirEntry(buf, off) {
  buf.writeUInt32LE(NOSTREAM, off + 68);
  buf.writeUInt32LE(NOSTREAM, off + 72);
  buf.writeUInt32LE(NOSTREAM, off + 76);
}

function pad(buf, size) {
  const rem = buf.length % size;
  return rem ? Buffer.concat([buf, Buffer.alloc(size - rem)]) : buf;
}

module.exports = { CompoundFile, Storage };
