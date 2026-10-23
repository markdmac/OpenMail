'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { backupPst } = require('../src/main/backup');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmail-backup-'));
  const srcDir = path.join(root, 'mail');
  const dest = path.join(root, 'cloud');
  fs.mkdirSync(srcDir);
  fs.mkdirSync(dest);
  const src = path.join(srcDir, 'Mailbox.pst');
  fs.writeFileSync(src, crypto.randomBytes(3 * 1024 * 1024 + 123));
  return { root, src, dest };
}

test('copies the mailbox, reports progress and leaves no partial file', async () => {
  const { src, dest } = setup();
  const seen = [];
  const r = await backupPst(src, dest, { onProgress: (p) => seen.push(p.copied) });
  assert.ok(fs.readFileSync(r.path).equals(fs.readFileSync(src)));
  assert.match(path.basename(r.path), /^Mailbox backup \d{4}-\d{2}-\d{2} \d{6}\.pst$/);
  assert.strictEqual(seen[seen.length - 1], fs.statSync(src).size);
  assert.deepStrictEqual(fs.readdirSync(dest).filter((f) => f.endsWith('.partial')), []);
});

test('keeps only the newest N backups and never touches other files', async () => {
  const { src, dest } = setup();
  fs.writeFileSync(path.join(dest, 'Mailbox backup 2020-01-01 000000.pst'), 'old1');
  fs.writeFileSync(path.join(dest, 'Mailbox backup 2020-01-02 000000.pst'), 'old2');
  fs.writeFileSync(path.join(dest, 'Mailbox backup 2020-01-03 000000.pst'), 'old3');
  fs.writeFileSync(path.join(dest, 'Other.pst'), 'keep me');
  fs.writeFileSync(path.join(dest, 'notes.txt'), 'keep me');
  const r = await backupPst(src, dest, { keep: 2 });
  const left = fs.readdirSync(dest).sort();
  assert.deepStrictEqual(left, ['Mailbox backup 2020-01-03 000000.pst', path.basename(r.path), 'Other.pst', 'notes.txt'].sort());
  assert.deepStrictEqual(r.removed.sort(), ['Mailbox backup 2020-01-01 000000.pst', 'Mailbox backup 2020-01-02 000000.pst']);
});

test('cancelling removes the partial copy', async () => {
  const { src, dest } = setup();
  const ac = new AbortController();
  await assert.rejects(backupPst(src, dest, { signal: ac.signal, onProgress: () => ac.abort() }), (e) => e.cancelled === true);
  assert.deepStrictEqual(fs.readdirSync(dest), []);
});

test('clear errors for a missing folder or the mailbox folder itself', async () => {
  const { src, root } = setup();
  await assert.rejects(backupPst(src, path.join(root, 'nope')), /was not found/);
  await assert.rejects(backupPst(src, path.dirname(src)), /must be different/);
  await assert.rejects(backupPst(src, ''), /No backup folder/);
});
