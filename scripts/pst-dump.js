'use strict';
// DEVELOPER TOOL: dumps the low-level structure of a PST file.
//   node scripts/pst-dump.js file.pst [--blocks] [--node 0x21]

const { Ndb } = require('../src/main/pst/ndb');

const file = process.argv[2];
const showBlocks = process.argv.includes('--blocks');
const nodeArg = process.argv.indexOf('--node');
const hex = (n) => '0x' + Number(n).toString(16);

const ndb = Ndb.open(file, { readOnly: true });
const h = ndb.header;
console.log(`wVer ${ndb.wVer} unicode=${ndb.fmt.unicode} crypt=${h.bCryptMethod} amapValid=${h.fAMapValid}`);
console.log(`eof ${h.ibFileEof} amapLast ${hex(h.ibAMapLast)} amapFree ${h.cbAMapFree} pmapFree ${h.cbPMapFree}`);
console.log(`bidNextB ${hex(h.bidNextB)} bidNextP ${hex(h.bidNextP)} unique ${h.dwUnique}`);
console.log(`NBT root bid ${hex(h.nbt.bid)} @${hex(h.nbt.ib)}   BBT root bid ${hex(h.bbt.bid)} @${hex(h.bbt.ib)}`);
console.log('rgnid', h.rgnid.map((v, i) => (v !== 0x400 ? `[${hex(i)}]=${hex(v)}` : null)).filter(Boolean).join(' ') || '(all 0x400)');

// Fixed-position map pages.
const pageInfo = (ib) => {
  const b = ndb.read(ib, 512);
  return `type ${hex(b[496])}/${hex(b[497])} sig ${hex(b.readUInt16LE(498))} bid ${hex(Number(b.readBigUInt64LE(504)))}`;
};
console.log(`DList @0x4200: ${pageInfo(0x4200)} cEnt=${ndb.read(0x4200, 8).readUInt32LE(4) & 0xffffff} flags=${ndb.read(0x4200, 1)[0]}`);
for (let ib = 0x4400, i = 0; ib < h.ibFileEof; ib += 253952, i++) {
  const extra = [];
  for (let k = 1; k <= 3; k++) {
    const t = ndb.read(ib + k * 512, 512)[496];
    if ([0x82, 0x83, 0x85].includes(t)) extra.push(`+${k * 512}:${{ 0x82: 'FMap', 0x83: 'PMap', 0x85: 'FPMap' }[t]}`);
  }
  if (i < 3 || extra.length > 1 || i % 64 === 0) console.log(`AMap#${i} @${hex(ib)} ${pageInfo(ib)} ${extra.join(' ')}`);
}

const nodes = [...ndb.btWalk(h.nbt, true)];
console.log(`\n${nodes.length} nodes:`);
for (const n of nodes) {
  const data = n.bidData ? ndb.getBlockRef(n.bidData) : null;
  let desc = '';
  if (n.bidData) {
    const blocks = ndb.readDataBlocks(n.bidData);
    const b0 = blocks[0] || Buffer.alloc(0);
    desc = b0.length >= 4 && b0[2] === 0xec ? `HN(${hex(b0[3])})` : `raw[${b0.length}] ${b0.subarray(0, 16).toString('hex')}`;
    desc += ` blocks=${blocks.length} total=${blocks.reduce((s, b) => s + b.length, 0)}`;
  }
  const subs = n.bidSub ? [...ndb.readSubnodes(n.bidSub).values()].map((s) => hex(s.nid)).join(',') : '';
  console.log(`nid ${hex(n.nid).padEnd(8)} parent ${hex(n.nidParent).padEnd(8)} data ${hex(n.bidData)}${data ? `(cb${data.cb},ref${data.cRef})` : ''} sub ${hex(n.bidSub)} ${desc}${subs ? ' subs[' + subs + ']' : ''}`);
}

if (showBlocks) {
  const blocks = [...ndb.btWalk(h.bbt, false)];
  console.log(`\n${blocks.length} blocks:`);
  for (const b of blocks) console.log(`bid ${hex(b.bid)} @${hex(b.ib)} cb ${b.cb} cRef ${b.cRef}`);
}

if (process.argv.includes('--ltp')) {
  const { readPC, readTC } = require('../src/main/pst/ltp');
  const fmtVal = (v) => (Buffer.isBuffer(v) ? `<${v.length}b ${v.subarray(0, 24).toString('hex')}>` : v instanceof Date ? v.toISOString() : JSON.stringify(v));
  for (const n of nodes) {
    if (!n.bidData) continue;
    const b0 = ndb.readDataBlocks(n.bidData)[0];
    if (!b0 || b0[2] !== 0xec) continue;
    try {
      if (b0[3] === 0xbc) {
        const { props } = readPC(ndb, n);
        console.log(`\nPC ${hex(n.nid)}:`);
        for (const [id, p] of props) console.log(`  ${hex(id).padEnd(7)} t${hex(p.type).padEnd(7)} ${fmtVal(p.value)}`);
      } else if (b0[3] === 0x7c) {
        const t = readTC(ndb, n);
        console.log(`\nTC ${hex(n.nid)}: ${t.columns.length} cols, ${t.rowCount} rows; cols: ${t.columns.map((c) => `${hex(c.id)}:${hex(c.type)}@${c.ib}/${c.cb}b${c.iBit}`).join(' ')}`);
        t.rows.slice(0, 5).forEach((r, i) => console.log(`  row ${hex(t.rowIds[i])}: ${[...r].map(([k, v]) => `${hex(k)}=${fmtVal(v)}`).join(' ')}`));
      } else {
        console.log(`\nHN(${hex(b0[3])}) ${hex(n.nid)}`);
      }
    } catch (e) {
      console.log(`\n${hex(n.nid)}: ERROR ${e.message}`);
    }
  }
}

if (nodeArg > 0) {
  const nid = Number(process.argv[nodeArg + 1]);
  const n = ndb.getNode(nid);
  for (const [i, b] of ndb.readDataBlocks(n.bidData).entries()) {
    console.log(`\nblock ${i} (${b.length} bytes):`);
    for (let o = 0; o < b.length; o += 32) console.log(o.toString(16).padStart(4, '0'), b.subarray(o, o + 32).toString('hex'));
  }
}
ndb.close();
