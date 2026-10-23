'use strict';
// End-to-end check against the installed Outlook, without touching Gmail:
// builds a realistic MIME message, converts it to .msg, imports it into a throwaway PST,
// reads it back, then detaches the PST from the Outlook profile.
//
//   npm run test:outlook

const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');
const { parseRaw } = require('../src/main/msg/from-mime');
const { buildMsg } = require('../src/main/msg/msg-writer');
const { OutlookBridge } = require('../src/main/outlook/outlook-bridge');

const OUT = path.join(__dirname, '..', '.test-output');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pst = path.join(OUT, `smoke-${Date.now()}.pst`);

  const raw = await new Promise((resolve, reject) =>
    new MailComposer({
      from: '"Alice Example" <alice@example.com>',
      to: '"Bob Builder" <bob@example.com>, carol@example.com',
      cc: 'dave@example.com',
      subject: 'Smoke test — ünïcödé ✓',
      date: new Date('2024-06-01T14:30:00Z'),
      text: 'Plain text body',
      html: '<h2>Hello from OpenMail</h2><p>Inline image: <img src="cid:logo@openmail"></p>',
      attachments: [
        { filename: 'notes.txt', content: 'attachment content' },
        { filename: 'logo.png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), cid: 'logo@openmail' },
      ],
    }).compile().build((e, m) => (e ? reject(e) : resolve(m)))
  );

  const parsed = await parseRaw(raw, { internalDate: String(Date.parse('2024-06-01T14:31:00Z')) });
  const msgPath = path.join(OUT, 'smoke.msg');
  fs.writeFileSync(msgPath, buildMsg({ ...parsed, unread: true }));
  console.log(`MSG written: ${msgPath} (${fs.statSync(msgPath).size} bytes)`);

  const bridge = new OutlookBridge();
  bridge.on('log', (l) => console.log(l));
  try {
    const info = await bridge.init(pst, 'OpenMail Smoke Test');
    console.log('PST opened:', info);
    const { entryId } = await bridge.call('importMsg', { msgPath, folderPath: 'Test/Nested', unread: true, categories: ['Smoke'] });
    console.log('Imported entryId:', entryId.slice(0, 24) + '…');
    const list = await bridge.call('listItems', { folderPath: 'Test/Nested', limit: 10 });
    console.log('List:', JSON.stringify(list.items[0], null, 2));
    const item = await bridge.call('getItem', { entryId });
    const checks = {
      subject: item.subject === 'Smoke test — ünïcödé ✓',
      from: item.from === 'Alice Example' && /alice@example.com/i.test(item.fromAddress),
      to: /Bob Builder/.test(item.to) && /carol@example.com/.test(item.to),
      cc: /dave@example.com/.test(item.cc),
      receivedTime: item.date && new Date(item.date).toISOString() === '2024-06-01T14:31:00.000Z',
      html: /Hello from OpenMail/.test(item.html),
      attachment: item.attachments.some((a) => a.name === 'notes.txt'),
      inlineImage: Object.keys(item.inlineImages).length === 1,
      unread: item.unread === true,
      categories: item.categories === 'Smoke',
    };
    console.log('Read back:', { ...item, html: `${item.html.length} chars`, inlineImages: Object.keys(item.inlineImages) });
    console.table(checks);
    const tree = await bridge.call('listFolders');
    console.log('Folders:', JSON.stringify(tree.children.map((f) => f.path)));
    await bridge.call('closePst');
    if (Object.values(checks).includes(false)) {
      process.exitCode = 1;
      console.error('SMOKE TEST FAILED');
    } else console.log('SMOKE TEST PASSED');
  } finally {
    bridge.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
