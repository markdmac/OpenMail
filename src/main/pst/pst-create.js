'use strict';
// Creates a new, empty Unicode PST whose node structure mirrors an empty PST created by Outlook
// (captured in pst-template.json by scripts/gen-pst-template.js).

const fs = require('fs');
const crypto = require('crypto');
const { Ndb } = require('./ndb-writer');
const { readPC, buildPC } = require('./ltp');
const { crc32 } = require('./crc');
const { PTYPE, NID, AMAP_FIRST, DLIST_OFFSET, PT } = require('./constants');
const template = require('./pst-template.json');

function initialHeader() {
  const h = Buffer.alloc(564);
  h.write('!BDN', 0, 'latin1');
  h.writeUInt16LE(0x4d53, 8); // wMagicClient "SM"
  h.writeUInt16LE(23, 10); // wVer: Unicode
  h.writeUInt16LE(template.wVerClient || 19, 12);
  h[14] = 0x01; // bPlatformCreate
  h[15] = 0x01; // bPlatformAccess
  template.rgnid.forEach((v, i) => h.writeUInt32LE(v >>> 0, 44 + i * 4));
  h.fill(0xff, 256, 384); // rgbFM
  h.fill(0xff, 384, 512); // rgbFP
  h[512] = 0x80; // bSentinel
  h[513] = 0x01; // bCryptMethod: NDB_CRYPT_PERMUTE (Outlook's default)
  h.writeBigUInt64LE(4n, 516); // bidNextB
  h.writeBigUInt64LE(1n, 32); // bidNextP
  h.writeUInt32LE(crc32(h, 8, 8 + 471), 4);
  h.writeUInt32LE(crc32(h, 8, 8 + 516), 524);
  return h;
}

function createPstFile(file, displayName) {
  if (fs.existsSync(file)) throw new Error(`File already exists: ${file}`);
  const fd = fs.openSync(file, 'wx+');
  try {
    // Header, empty DList and the first AMap/PMap; everything else is written through the normal commit path.
    const header = initialHeader();
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.writeSync(fd, Buffer.alloc(AMAP_FIRST + 1024 - 564), 0, AMAP_FIRST + 1024 - 564, 564);
  } finally {
    fs.closeSync(fd);
  }

  // Build an Ndb over the skeleton by hand (there are no B-trees to read yet).
  const fd2 = fs.openSync(file, 'r+');
  const ndb = Object.create(Ndb.prototype);
  ndb.fd = fd2;
  ndb.file = file;
  ndb.readOnly = false;
  ndb.pageCache = new Map();
  ndb.fmt = require('./ndb').UNICODE;
  ndb.wVer = 23;
  const raw = initialHeader();
  ndb.header = {
    raw,
    bidNextP: 1,
    dwUnique: 0,
    rgnid: [...template.rgnid],
    ibFileEof: AMAP_FIRST + 1024,
    ibAMapLast: AMAP_FIRST,
    cbAMapFree: 0,
    cbPMapFree: 0,
    nbt: { bid: 0, ib: 0 },
    bbt: { bid: 0, ib: 0 },
    fAMapValid: 2,
    bCryptMethod: 1,
    bidNextB: 4,
  };
  const bits = Buffer.alloc(496);
  bits[0] = 0xff; // AMap page
  bits[1] = 0xff; // PMap page
  ndb.amaps = [{ ib: AMAP_FIRST, bits, free: 496 * 8 - 16, dirty: true, isNew: true }];
  ndb.allocCursor = 0;
  ndb.txn = { nodes: new Map(), blocks: new Map(), refDelta: new Map(), freeAfterCommit: [], trees: {} };
  const emptyTree = (isNbt) => ({ ref: null, level: 0, entries: [], children: new Map(), dirty: true, isNbt });
  ndb.txn.trees.nbt = emptyTree(true);
  ndb.txn.trees.bbt = emptyTree(false);

  // Fresh identity for this store: replace the template's record key everywhere it appears.
  const oldKey = Buffer.from(template.recordKey, 'hex');
  const newKey = crypto.randomBytes(16);
  const patch = (buf) => {
    let i = buf.indexOf(oldKey);
    while (i >= 0) {
      newKey.copy(buf, i);
      i = buf.indexOf(oldKey, i + 16);
    }
    return buf;
  };

  // Shared template blobs keep being shared (one block, several referencing nodes), like Outlook.
  const written = new Map();
  for (const n of template.nodes) {
    let bidData = 0;
    if (n.data !== null) {
      if (written.has(n.data)) {
        bidData = written.get(n.data);
        ndb.addRef(bidData);
      } else {
        const parts = template.blocks[n.data].map((h) => patch(Buffer.from(h, 'hex')));
        bidData = ndb.writeDataTree(parts);
        written.set(n.data, bidData);
      }
    }
    ndb.txn.nodes.set(n.nid >>> 0, { nid: n.nid >>> 0, bidData, bidSub: 0, nidParent: n.parent >>> 0 });
  }

  // Store display name (Outlook shows this as the name of the data file).
  const renamePC = (nid, changes) => {
    const node = ndb.txn.nodes.get(nid);
    const { props } = readPC(ndb, node);
    for (const [id, value] of Object.entries(changes)) props.set(Number(id), { type: props.get(Number(id))?.type ?? PT.UNICODE, value });
    const pages = buildPC([...props].map(([id, p]) => ({ id, type: p.type, value: p.value })), () => {
      throw new Error('unexpected large value in template PC');
    });
    const bidData = ndb.writeDataTree(pages);
    ndb.decRef(node.bidData);
    ndb.txn.nodes.set(nid, { ...node, bidData });
  };
  renamePC(NID.MESSAGE_STORE, { 0x3001: displayName });

  ndb.commit();
  ndb.close();
}

module.exports = { createPstFile };
