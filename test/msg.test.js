'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { CompoundFile } = require('../src/main/msg/cfb-writer');
const { buildMsg } = require('../src/main/msg/msg-writer');
const { readCfb } = require('./cfb-reader');

function readProps(stream, headerSize) {
  const props = {};
  for (let off = headerSize; off < stream.length; off += 16) {
    const tag = stream.readUInt32LE(off).toString(16).toUpperCase().padStart(8, '0');
    props[tag] = stream.subarray(off + 8, off + 16);
  }
  return props;
}

const str = (tree, tag) => tree[`__substg1.0_${tag}`].toString('utf16le').replace(/\0$/, '');

test('CFB round-trips small, large and empty streams', () => {
  const cf = new CompoundFile();
  const small = crypto.randomBytes(100);
  const big = crypto.randomBytes(9 * 1024 * 1024); // forces DIFAT (>109 FAT sectors)
  cf.root.stream('small', small).stream('empty', Buffer.alloc(0));
  const sub = cf.root.storage('sub');
  sub.stream('big', big);
  for (let i = 0; i < 40; i++) sub.stream(`s${i}`, Buffer.from(`value ${i}`));
  const { tree } = readCfb(cf.toBuffer());
  assert.deepStrictEqual(tree.small, small);
  assert.strictEqual(tree.empty.length, 0);
  assert.ok(tree.sub.big.equals(big));
  for (let i = 0; i < 40; i++) assert.strictEqual(tree.sub[`s${i}`].toString(), `value ${i}`);
});

test('CFB sibling trees are valid red-black trees', () => {
  const cf = new CompoundFile();
  for (let i = 0; i < 37; i++) cf.root.stream(`stream_${i}`, Buffer.from([i]));
  const { entries } = readCfb(cf.toBuffer());
  const blackHeight = (id) => {
    if (id === 0xffffffff) return 1;
    const e = entries[id];
    const l = blackHeight(e.left);
    const r = blackHeight(e.right);
    assert.strictEqual(l, r, 'black heights differ');
    if (e.color === 0) {
      for (const c of [e.left, e.right]) if (c !== 0xffffffff) assert.strictEqual(entries[c].color, 1, 'red node with red child');
    }
    return l + (e.color === 1 ? 1 : 0);
  };
  blackHeight(entries[0].child);
});

test('MSG contains expected properties, recipients and attachments', () => {
  const date = new Date('2025-03-04T05:06:07Z');
  const buf = buildMsg({
    subject: 'RE: Héllo wörld ✓',
    from: { name: 'Alice Example', address: 'alice@example.com' },
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    cc: [{ name: '', address: 'carol@example.com' }],
    date,
    receivedDate: date,
    text: 'plain body',
    html: '<p>html body <img src="cid:img1"></p>',
    unread: true,
    attachments: [
      { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') },
      { filename: 'logo.png', contentType: 'image/png', content: Buffer.alloc(5000, 1), contentId: '<img1>', inline: true },
    ],
  });
  const { tree } = readCfb(buf);
  const top = readProps(tree['__properties_version1.0'], 32);
  assert.strictEqual(tree['__properties_version1.0'].readUInt32LE(16), 2, 'recipient count');
  assert.strictEqual(tree['__properties_version1.0'].readUInt32LE(20), 2, 'attachment count');
  assert.strictEqual(str(tree, '001A001F'), 'IPM.Note');
  assert.strictEqual(str(tree, '0037001F'), 'RE: Héllo wörld ✓');
  assert.strictEqual(str(tree, '0E1D001F'), 'Héllo wörld ✓');
  assert.strictEqual(str(tree, '0C1F001F'), 'alice@example.com');
  assert.strictEqual(tree['__substg1.0_10130102'].toString('utf8'), '<p>html body <img src="cid:img1"></p>');
  assert.strictEqual(top['0E070003'].readUInt32LE(0) & 1, 0, 'unread message has no READ flag');
  const ft = top['0E060040'].readBigUInt64LE(0);
  assert.strictEqual(Number(ft / 10000n - 11644473600000n), date.getTime());
  assert.ok(tree['__nameid_version1.0']);

  const r1 = tree['__recip_version1.0_#00000001'];
  assert.strictEqual(str(r1, '39FE001F'), 'carol@example.com');
  assert.strictEqual(readProps(r1['__properties_version1.0'], 8)['0C150003'].readUInt32LE(0), 2);

  const a1 = tree['__attach_version1.0_#00000001'];
  assert.strictEqual(str(a1, '3707001F'), 'logo.png');
  assert.strictEqual(str(a1, '3712001F'), 'img1');
  assert.strictEqual(a1['__substg1.0_37010102'].length, 5000);
});
