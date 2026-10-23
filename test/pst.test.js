'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PstStore } = require('../src/main/pst/pst-store');
const { checkPst } = require('../src/main/pst/pst-check');
const { PSTFile } = require('pst-extractor');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmail-pst-'));
let n = 0;
const newFile = () => path.join(tmp, `t${++n}.pst`);

function healthy(file) {
  const { problems } = checkPst(file);
  assert.deepStrictEqual(problems, [], `integrity problems in ${file}`);
}

function sampleMessage(i, extra = {}) {
  return {
    subject: `Message ${i} — ünïcödé ✓`,
    from: { name: `Sender ${i % 7}`, address: `sender${i % 7}@example.com` },
    to: [{ name: 'Me', address: 'me@example.com' }],
    cc: i % 3 ? [] : [{ name: '', address: 'cc@example.com' }],
    date: new Date(Date.UTC(2025, 0, 1, 0, i)),
    text: `Body ${i}`,
    html: `<p>Body <b>${i}</b></p>`,
    unread: i % 2 === 0,
    ...extra,
  };
}

/** Reads every folder and message with pst-extractor (independent implementation). */
function readWithPstExtractor(file) {
  const out = {};
  const walk = (f, prefix) => {
    for (const c of f.hasSubfolders ? f.getSubFolders() : []) {
      const p = prefix ? `${prefix}/${c.displayName}` : c.displayName;
      const msgs = [];
      let m = c.getNextChild();
      while (m) {
        const atts = [];
        for (let i = 0; i < m.numberOfAttachments; i++) atts.push(m.getAttachment(i).longFilename);
        msgs.push({ subject: m.subject, sender: m.senderName, atts });
        m = c.getNextChild();
      }
      out[p] = msgs;
      walk(c, p);
    }
  };
  walk(new PSTFile(file).getRootFolder(), '');
  return out;
}

test('create a new PST, add folders and messages, read them back', () => {
  const file = newFile();
  const s = PstStore.create(file, { displayName: 'Test Store' });
  const inbox = s.findFolderByPath('Inbox', true);
  const deep = s.findFolderByPath('Work/Clients/Acme', true);
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push(s.addMessage(inbox, sampleMessage(i)));
  const withAtt = s.addMessage(deep, sampleMessage(99, {
    categories: ['Red Category', 'Project X'],
    flagged: true,
    attachments: [
      { filename: 'small.txt', contentType: 'text/plain', content: Buffer.from('hello') },
      { filename: 'large.bin', contentType: 'application/octet-stream', content: crypto.randomBytes(200000) },
      { filename: 'logo.png', contentType: 'image/png', content: Buffer.alloc(100, 1), contentId: '<logo@x>', inline: true },
    ],
  }));
  s.commit();
  s.close();
  healthy(file);

  const r = PstStore.open(file, { readOnly: true });
  assert.strictEqual(r.displayName, 'Test Store');
  const tree = r.folderTree();
  assert.deepStrictEqual(tree.map((f) => f.name).sort(), ['Deleted Items', 'Inbox', 'Work']);
  assert.strictEqual(r.getFolder(inbox).count, 30);
  assert.strictEqual(r.getFolder(inbox).unread, 15);
  const list = r.listMessages(inbox);
  assert.strictEqual(list.length, 30);
  assert.ok(list.some((m) => m.subject === 'Message 7 — ünïcödé ✓' && m.from === 'Sender 0'));
  const m = r.getMessage(withAtt);
  assert.strictEqual(m.subject, 'Message 99 — ünïcödé ✓');
  assert.strictEqual(m.fromAddress, 'sender1@example.com');
  assert.deepStrictEqual(m.categories, ['Red Category', 'Project X']);
  assert.strictEqual(m.flagged, true);
  assert.strictEqual(m.html, '<p>Body <b>99</b></p>');
  assert.deepStrictEqual(m.recipients.map((x) => [x.type, x.address]), [[1, 'me@example.com'], [2, 'cc@example.com']]);
  assert.deepStrictEqual(m.attachments.map((a) => [a.filename, a.size, a.hidden]), [['small.txt', 5, false], ['large.bin', 200000, false], ['logo.png', 100, true]]);
  assert.strictEqual(r.getAttachmentData(withAtt, m.attachments[0].nid).toString(), 'hello');
  assert.strictEqual(r.getAttachmentData(withAtt, m.attachments[1].nid).length, 200000);
  r.close();

  const px = readWithPstExtractor(file);
  assert.strictEqual(px['Top of Outlook data file/Inbox'].length, 30);
  assert.deepStrictEqual(px['Top of Outlook data file/Work/Clients/Acme'][0].atts, ['small.txt', 'large.bin', 'logo.png']);
});

test('read state, flags, categories, moves and deletes keep folder counts right', () => {
  const file = newFile();
  const s = PstStore.create(file);
  const a = s.findFolderByPath('A', true);
  const b = s.findFolderByPath('B', true);
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(s.addMessage(a, sampleMessage(i, { unread: true })));
  s.commit();
  s.setRead(ids[0], true);
  s.setRead(ids[1], true);
  s.setFlag(ids[2], true);
  s.setCategories(ids[3], ['Green Category']);
  s.moveMessage(ids[4], b);
  s.moveMessage(ids[5], b);
  s.deleteMessage(ids[6]);
  s.commit();
  s.renameFolder(b, 'B renamed');
  s.commit();
  s.close();
  healthy(file);

  const r = PstStore.open(file, { readOnly: true });
  assert.deepStrictEqual([r.getFolder(a).count, r.getFolder(a).unread], [7, 5]);
  assert.deepStrictEqual([r.getFolder(b).count, r.getFolder(b).unread, r.getFolder(b).name], [2, 2, 'B renamed']);
  assert.strictEqual(r.getMessage(ids[0]).unread, false);
  assert.strictEqual(r.getMessage(ids[2]).flagged, true);
  assert.deepStrictEqual(r.getMessage(ids[3]).categories, ['Green Category']);
  assert.strictEqual(r.getMessage(ids[4]).folder, b);
  assert.throws(() => r.getMessage(ids[6]));
  assert.deepStrictEqual(r.listMessages(a).map((m) => m.nid).sort(), [ids[0], ids[1], ids[2], ids[3], ids[7], ids[8], ids[9]].sort());
  r.close();
});

test('folder delete and move', () => {
  const file = newFile();
  const s = PstStore.create(file);
  const x = s.findFolderByPath('X/Y/Z', true);
  s.addMessage(x, sampleMessage(1));
  const other = s.findFolderByPath('Other', true);
  s.commit();
  s.moveFolder(s.findFolderByPath('X/Y'), other);
  s.commit();
  assert.ok(s.findFolderByPath('Other/Y/Z'));
  assert.strictEqual(s.findFolderByPath('X/Y'), null);
  s.deleteFolder(s.findFolderByPath('Other/Y'));
  s.commit();
  assert.strictEqual(s.findFolderByPath('Other/Y'), null);
  s.close();
  healthy(file);
});

test('randomized stress: thousands of inserts, updates and deletes stay consistent', () => {
  const file = newFile();
  const s = PstStore.create(file);
  const folders = ['F1', 'F2', 'F3'].map((p) => s.findFolderByPath(p, true));
  const live = new Map(); // nid → folder
  let seed = 12345;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k);
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 150; i++) {
      const op = rnd(10);
      const nids = [...live.keys()];
      if (op < 6 || nids.length < 20) {
        const f = folders[rnd(3)];
        live.set(s.addMessage(f, sampleMessage(round * 1000 + i, { attachments: rnd(5) === 0 ? [{ filename: 'a.bin', content: crypto.randomBytes(rnd(20000)) }] : [] })), f);
      } else if (op < 8) {
        const nid = nids[rnd(nids.length)];
        s.deleteMessage(nid);
        live.delete(nid);
      } else if (op < 9) {
        const nid = nids[rnd(nids.length)];
        const f = folders[rnd(3)];
        s.moveMessage(nid, f);
        live.set(nid, f);
      } else {
        s.setRead(nids[rnd(nids.length)], rnd(2) === 0);
      }
    }
    s.commit();
  }
  for (const f of folders) {
    const expected = [...live].filter(([, fo]) => fo === f).map(([nid]) => nid).sort();
    assert.deepStrictEqual(s.listMessages(f).map((m) => m.nid).sort(), expected);
    assert.strictEqual(s.getFolder(f).count, expected.length);
    assert.strictEqual(s.getFolder(f).unread, s.listMessages(f).filter((m) => m.unread).length);
  }
  s.close();
  healthy(file);
  const px = readWithPstExtractor(file);
  assert.strictEqual(px['Top of Outlook data file/F1'].length + px['Top of Outlook data file/F2'].length + px['Top of Outlook data file/F3'].length, live.size);
});

test('large folder table (rows in a subnode, multi-page heap) survives rewrites', () => {
  const file = newFile();
  const s = PstStore.create(file);
  const f = s.findFolderByPath('Big', true);
  const ids = [];
  for (let i = 0; i < 1500; i++) ids.push(s.addMessage(f, sampleMessage(i)));
  s.commit();
  for (let i = 0; i < 1500; i += 3) s.deleteMessage(ids[i]);
  s.commit();
  s.close();
  healthy(file);
  const r = PstStore.open(file, { readOnly: true });
  assert.strictEqual(r.listMessages(f).length, 1000);
  assert.strictEqual(r.getFolder(f).count, 1000);
  r.close();
});

test('strings are cut at the first NUL and Windows-1252 punctuation is repaired', () => {
  const { cleanString, decodeValue } = require('../src/main/pst/ltp');
  const { PT } = require('../src/main/pst/constants');
  assert.strictEqual(cleanString('A little surprise for you\u0000~\u0005\u0000\u00ff\u00b9t'), 'A little surprise for you');
  assert.strictEqual(cleanString('\u0093Quoted\u0094 \u0096 costs \u0080 5'), '\u201cQuoted\u201d \u2013 costs \u20ac 5');
  assert.strictEqual(cleanString('Emoji \u{1F381} and caf\u00e9 stay'), 'Emoji \u{1F381} and caf\u00e9 stay');
  // ANSI strings are Windows-1252, with junk after the terminator ignored.
  assert.strictEqual(decodeValue(PT.STRING8, Buffer.from([0x93, 0x48, 0x69, 0x94, 0x00, 0xff, 0xb9])), '\u201cHi\u201d');
});
