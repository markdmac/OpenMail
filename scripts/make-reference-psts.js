'use strict';
// DEVELOPER TOOL (needs Outlook installed): asks Outlook to generate reference PST files that the
// native PST engine is tested against. Output goes to .test-output/ref/ and is not committed.
//
//   node scripts/make-reference-psts.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildMsg } = require('./lib/legacy-msg/msg-writer');
const { OutlookBridge } = require('./lib/legacy-outlook/outlook-bridge');

const OUT = process.env.REF_OUT || path.join(__dirname, '..', '.test-output', 'ref-unicode');

function message(i, extra = {}) {
  return {
    subject: `Reference message ${i} — ünïcödé ✓`,
    from: { name: `Sender ${i}`, address: `sender${i}@example.com` },
    to: [{ name: 'Recipient One', address: 'one@example.com' }, { name: '', address: 'two@example.com' }],
    cc: i % 2 ? [{ name: 'Cc Person', address: 'cc@example.com' }] : [],
    date: new Date(Date.UTC(2024, 0, 1 + i, 12, 0, 0)),
    receivedDate: new Date(Date.UTC(2024, 0, 1 + i, 12, 5, 0)),
    text: `Plain body for message ${i}\r\n`.repeat(3),
    html: `<html><body><p>HTML body for message <b>${i}</b></p></body></html>`,
    unread: i % 3 === 0,
    attachments: [],
    ...extra,
  };
}

async function build(bridge, file, displayName, items) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  await bridge.init(file, displayName);
  for (const { folder, msg } of items) {
    const tmp = path.join(OUT, 'tmp.msg');
    fs.writeFileSync(tmp, buildMsg(msg));
    await bridge.call('importMsg', { msgPath: tmp, folderPath: folder, unread: msg.unread, categories: msg.categories || [] });
    fs.unlinkSync(tmp);
  }
  await bridge.call('closePst');
  console.log(`${file}: ${fs.statSync(file).size} bytes`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const bridge = new OutlookBridge();
  bridge.on('log', (l) => console.log(l));
  try {
    await build(bridge, path.join(OUT, 'empty.pst'), 'Reference Empty', []);

    // Small PST: nested folders, recipients, attachments, categories, read/unread mix.
    const small = [];
    for (let i = 0; i < 6; i++) small.push({ folder: 'Inbox', msg: message(i) });
    small.push({ folder: 'Work/Clients', msg: message(10, { categories: ['Red Category'], attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('attachment text') }] }) });
    small.push({ folder: 'Work/Clients', msg: message(11, { attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', content: crypto.randomBytes(20000) }] }) });
    small.push({ folder: 'Work', msg: message(12) });
    await build(bridge, path.join(OUT, 'sample.pst'), 'Reference Sample', small);

    // Large PST (> 33 MB) so the file contains FMap pages and many AMap/PMap pages.
    const large = [];
    for (let i = 0; i < 12; i++) {
      large.push({ folder: 'Bulk', msg: message(100 + i, { attachments: [{ filename: `blob${i}.bin`, contentType: 'application/octet-stream', content: crypto.randomBytes(3 * 1024 * 1024) }] }) });
    }
    for (let i = 0; i < 300; i++) large.push({ folder: 'Many', msg: message(1000 + i) });
    await build(bridge, path.join(OUT, 'large.pst'), 'Reference Large', large);
  } finally {
    bridge.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
