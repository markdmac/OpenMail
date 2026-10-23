'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SyncEngine } = require('../src/main/sync-engine');
const { newRule } = require('../src/main/rules');

function rawMessage(subject) {
  return Buffer.from(`From: Shop <shop@example.com>\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: Mon, 6 Jan 2025 10:00:00 +0000\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.com>\r\n\r\nHello\r\n`);
}

/** Fake Gmail: labels per message can change between download and trash (user stars it meanwhile). */
function fakeGmail(messages) {
  const trashed = [];
  return {
    trashed,
    async request(method, path) {
      const id = path.split('/')[2];
      return { id, labelIds: messages[id].labelsNow || messages[id].labels };
    },
    async getRaw(id) {
      return { id, labelIds: messages[id].labels, internalDate: String(Date.parse('2025-01-06T10:00:00Z')), raw: rawMessage(messages[id].subject) };
    },
    async trash(id) {
      trashed.push(id);
    },
    async labels() {
      return [];
    },
  };
}

function fakeStore(syncSettings = {}, rules = []) {
  return {
    settings: { sync: { trashingEnabled: true, trashNewMail: true, newMailUnreadOnly: true, keepEmlBackup: false, excludeSpam: true, archiveSent: true, keepStarredInGmail: true, ...syncSettings } },
    state: { totals: {} },
    rules,
    processed: new Map(),
    record(id, status, entryId, folder) {
      this.processed.set(id, { status, entryId, folder });
    },
    saveState(p) {
      Object.assign(this.state, p);
    },
  };
}

function fakeMailbox() {
  let next = 100;
  const added = [];
  return {
    added,
    commits: 0,
    async call(cmd, args) {
      if (cmd === 'addMessage') {
        added.push(args);
        return { id: next++ };
      }
      if (cmd === 'commit') this.commits++;
      return true;
    },
  };
}

async function run({ messages, settings, rules, mode = 'new' }) {
  const gmail = fakeGmail(messages);
  const store = fakeStore(settings, rules);
  const mailbox = fakeMailbox();
  const engine = new SyncEngine({ store, gmail, mailbox });
  for (const id of Object.keys(messages)) await engine.processMessage(id, mode);
  await engine.flushTrash();
  return { gmail, store, mailbox };
}

test('starred messages are copied but never trashed; others are trashed after commit', async () => {
  const { gmail, mailbox, store } = await run({
    messages: {
      a: { subject: 'Starred', labels: ['INBOX', 'UNREAD', 'STARRED'] },
      b: { subject: 'Plain', labels: ['INBOX', 'UNREAD'] },
    },
  });
  assert.deepStrictEqual(mailbox.added.map((m) => m.message.subject), ['Starred', 'Plain']);
  assert.strictEqual(mailbox.added[0].message.flagged, true, 'starred → flagged in the mailbox');
  assert.deepStrictEqual(gmail.trashed, ['b']);
  assert.ok(mailbox.commits >= 1, 'committed before trashing');
  assert.strictEqual(store.processed.get('a').status, 'archived');
});

test('rules cannot trash a starred message (trash rule and delete-without-archive rule)', async () => {
  const rules = [newRule({ conditions: [{ field: 'from', op: 'contains', value: 'shop' }], actions: [{ type: 'trashInGmail' }] })];
  const r1 = await run({ messages: { a: { subject: 'S1', labels: ['INBOX', 'STARRED'] } }, rules, mode: 'initial' });
  assert.deepStrictEqual(r1.gmail.trashed, []);
  assert.strictEqual(r1.mailbox.added.length, 1);

  const del = [newRule({ conditions: [{ field: 'from', op: 'contains', value: 'shop' }], actions: [{ type: 'deleteWithoutArchive' }] })];
  const r2 = await run({ messages: { a: { subject: 'S2', labels: ['INBOX', 'UNREAD', 'STARRED'] }, b: { subject: 'N2', labels: ['INBOX', 'UNREAD'] } }, rules: del });
  assert.deepStrictEqual(r2.gmail.trashed, ['b'], 'only the unstarred message is deleted');
  assert.deepStrictEqual(r2.mailbox.added.map((m) => m.message.subject), ['S2'], 'starred one is archived instead of deleted');
});

test('a message starred after download (before the trash batch runs) is kept', async () => {
  const { gmail, mailbox } = await run({ messages: { a: { subject: 'Late star', labels: ['INBOX', 'UNREAD'], labelsNow: ['INBOX', 'UNREAD', 'STARRED'] } } });
  assert.strictEqual(mailbox.added.length, 1);
  assert.deepStrictEqual(gmail.trashed, []);
});

test('with the option off, starred messages are trashed like any other', async () => {
  const { gmail } = await run({ messages: { a: { subject: 'Starred', labels: ['INBOX', 'UNREAD', 'STARRED'] } }, settings: { keepStarredInGmail: false } });
  assert.deepStrictEqual(gmail.trashed, ['a']);
});
