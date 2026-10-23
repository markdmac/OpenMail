'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluate, ruleMatches, toGmailQuery, newRule } = require('../src/main/rules');

const ctx = {
  from: 'Amazon <shipment-tracking@amazon.com>',
  fromAddress: 'shipment-tracking@amazon.com',
  to: 'Me <me@gmail.com>',
  cc: '',
  subject: 'Your order has shipped',
  body: 'Track your package',
  labels: ['INBOX', 'Receipts'],
  hasAttachment: false,
  isNewsletter: true,
  unread: true,
  date: new Date(Date.now() - 40 * 86400000),
  sizeKB: 30,
};

test('conditions: contains / domain / boolean / age', () => {
  assert.ok(ruleMatches(newRule({ conditions: [{ field: 'from', op: 'contains', value: 'amazon' }] }), ctx));
  assert.ok(ruleMatches(newRule({ conditions: [{ field: 'fromDomain', op: 'equals', value: 'amazon.com' }] }), ctx));
  assert.ok(ruleMatches(newRule({ conditions: [{ field: 'isNewsletter', value: 'true' }] }), ctx));
  assert.ok(ruleMatches(newRule({ conditions: [{ field: 'olderThanDays', value: '30' }] }), ctx));
  assert.ok(!ruleMatches(newRule({ conditions: [{ field: 'olderThanDays', value: '60' }] }), ctx));
  assert.ok(!ruleMatches(newRule({ conditions: [{ field: 'subject', op: 'notContains', value: 'shipped' }] }), ctx));
  assert.ok(ruleMatches(newRule({ conditions: [{ field: 'subject', op: 'matches', value: 'order.*ship' }] }), ctx));
});

test('match any vs all', () => {
  const conds = [
    { field: 'from', op: 'contains', value: 'ebay' },
    { field: 'subject', op: 'contains', value: 'shipped' },
  ];
  assert.ok(!ruleMatches(newRule({ match: 'all', conditions: conds }), ctx));
  assert.ok(ruleMatches(newRule({ match: 'any', conditions: conds }), ctx));
});

test('evaluate merges actions and honours stopProcessing', () => {
  const rules = [
    newRule({ name: 'disabled', enabled: false, conditions: [{ field: 'from', op: 'contains', value: 'amazon' }], actions: [{ type: 'skip' }] }),
    newRule({ name: 'cat', stopProcessing: false, conditions: [{ field: 'from', op: 'contains', value: 'amazon' }], actions: [{ type: 'addCategory', value: 'Shopping' }] }),
    newRule({ name: 'file', conditions: [{ field: 'subject', op: 'contains', value: 'order' }], actions: [{ type: 'moveToFolder', value: 'Receipts/Amazon' }, { type: 'keepInGmail' }] }),
    newRule({ name: 'never', conditions: [{ field: 'from', op: 'contains', value: 'amazon' }], actions: [{ type: 'deleteWithoutArchive' }] }),
  ];
  const plan = evaluate(rules, ctx);
  assert.deepStrictEqual(plan.matched, ['cat', 'file']);
  assert.strictEqual(plan.folder, 'Receipts/Amazon');
  assert.deepStrictEqual(plan.categories, ['Shopping']);
  assert.strictEqual(plan.gmail, 'keep');
  assert.strictEqual(plan.deleteOnly, false);
});

test('gmail query compilation', () => {
  assert.strictEqual(
    toGmailQuery(newRule({ conditions: [{ field: 'from', op: 'contains', value: 'amazon.com' }, { field: 'olderThanDays', value: '30' }] })),
    'from:amazon.com older_than:30d'
  );
  assert.strictEqual(
    toGmailQuery(newRule({ match: 'any', conditions: [{ field: 'subject', op: 'contains', value: 'big sale' }, { field: 'hasAttachment', value: 'true' }] })),
    '{subject:"big sale" has:attachment}'
  );
  assert.strictEqual(toGmailQuery(newRule({ match: 'any', conditions: [{ field: 'subject', op: 'matches', value: 'x' }, { field: 'from', op: 'contains', value: 'a' }] })), null);
});
