'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RecipientBook, parseAddresses, isLikelyAutomated } = require('../src/main/recipients');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openmail-rcpt-')), 'recipients.json');

test('parses names, bare addresses, semicolons and duplicates', () => {
  assert.deepStrictEqual(parseAddresses('Bob Smith <Bob@Example.com>; carol@example.com, "Dave, Jr." <dave@x.org>, bob@example.com'), [
    { name: 'Bob Smith', address: 'bob@example.com' },
    { name: '', address: 'carol@example.com' },
    { name: 'Dave, Jr.', address: 'dave@x.org' },
  ]);
  assert.deepStrictEqual(parseAddresses(''), []);
  assert.deepStrictEqual(parseAddresses('not an address'), []);
});

test('remembers sent-to addresses, ranks frequent and recent ones first, and persists', () => {
  const file = tmpFile();
  const book = new RecipientBook(file);
  const old = new Date(Date.now() - 400 * 86400000);
  book.addFromFields(['Old Friend <old@example.com>'], old);
  book.addFromFields(['Bob <bob@example.com>', 'carol@example.com'], new Date());
  book.addFromFields(['bob@example.com'], new Date());
  const list = book.list();
  assert.strictEqual(list[0].address, 'bob@example.com');
  assert.strictEqual(list[0].count, 2);
  assert.strictEqual(list[0].name, 'Bob', 'keeps the known display name when a later send has none');
  assert.strictEqual(list[list.length - 1].address, 'old@example.com');

  const reloaded = new RecipientBook(file);
  assert.deepStrictEqual(reloaded.list().map((e) => e.address), list.map((e) => e.address));
});

test('forget removes an address from suggestions', () => {
  const book = new RecipientBook(tmpFile());
  book.addFromFields(['a@example.com, b@example.com']);
  book.forget('A@example.com');
  assert.deepStrictEqual(book.list().map((e) => e.address), ['b@example.com']);
});

test('recognises automated addresses that should not be learned from Sent Items', () => {
  for (const a of ['unsubscribe@em6623.email.example.com', 'no-reply@x.com', 'noreply+abc@x.com', 'do-not-reply@x.com', 'bounces+123@x.com', 'list-unsubscribe-42@x.com']) {
    assert.ok(isLikelyAutomated(a), a);
  }
  for (const a of ['mark@example.com', 'bounty@example.com', 'noreen@example.com', 'support@company.com']) {
    assert.ok(!isLikelyAutomated(a), a);
  }
});
