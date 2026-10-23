'use strict';
// DEVELOPER TOOL: captures the node structure of an empty Unicode PST created by Outlook
// (see make-reference-psts.js) into src/main/pst/pst-template.json. OpenMail creates new PST files
// from this template so they match what Outlook itself would produce.
//
//   node scripts/gen-pst-template.js .test-output/ref-unicode/empty.pst

const fs = require('fs');
const path = require('path');
const { Ndb } = require('../src/main/pst/ndb');
const { readPC } = require('../src/main/pst/ltp');

const src = process.argv[2];
if (!src) throw new Error('usage: gen-pst-template.js <empty.pst>');
const ndb = Ndb.open(src, { readOnly: true });
if (!ndb.fmt.unicode) throw new Error('Template source must be a Unicode PST');

const recordKey = readPC(ndb, ndb.getNode(0x21)).props.get(0x0ff9).value;
const blockIds = new Map(); // bidData → shared data index
const blocks = [];
const nodes = [];
for (const n of ndb.btWalk(ndb.header.nbt, true)) {
  if (n.bidSub) throw new Error(`Template node 0x${n.nid.toString(16)} has subnodes; regenerate from an empty PST`);
  let data = null;
  if (n.bidData) {
    if (!blockIds.has(n.bidData)) {
      const parts = ndb.readDataBlocks(n.bidData).map((b) => b.toString('hex'));
      blockIds.set(n.bidData, blocks.length);
      blocks.push(parts);
    }
    data = blockIds.get(n.bidData);
  }
  nodes.push({ nid: n.nid, parent: n.nidParent, data });
}

const out = {
  generatedFrom: `Outlook ${ndb.header.raw.readUInt16LE(12)} empty Unicode PST`,
  recordKey: recordKey.toString('hex'),
  rgnid: ndb.header.rgnid,
  wVerClient: ndb.header.raw.readUInt16LE(12),
  nodes,
  blocks,
};
const dest = path.join(__dirname, '..', 'src', 'main', 'pst', 'pst-template.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`${nodes.length} nodes, ${blocks.length} data blobs → ${dest}`);
