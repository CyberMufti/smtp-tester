import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHygiene, passwordWeaknesses, sha1Hex } from '../src/core/hygiene.js';

test('passwordWeaknesses flags short, common, digits-only, and same-as-username', () => {
  assert.deepEqual(passwordWeaknesses('a@x.com', 'password'), ['common password', 'lowercase letters only']);
  assert.ok(passwordWeaknesses('a@x.com', 'abc').includes('shorter than 8 characters'));
  assert.ok(passwordWeaknesses('a@x.com', '12345678').includes('digits only'));
  assert.ok(passwordWeaknesses('bob@x.com', 'bob').includes('same as username'));
  assert.ok(passwordWeaknesses('a@x.com', 'qwertyui').includes('keyboard/sequence pattern'));
});

test('a strong unique password has no weaknesses', () => {
  assert.deepEqual(passwordWeaknesses('a@x.com', 'Tr0ub4dour&3xplod'), []);
});

test('analyzeHygiene detects reuse across accounts', () => {
  const records = [
    { user: 'a@x.com', pass: 'Zx9!qLmvProd' },
    { user: 'b@x.com', pass: 'Zx9!qLmvProd' }, // same as a
    { user: 'c@x.com', pass: 'Different#One7' },
  ];
  const { summary, sample } = analyzeHygiene(records);
  assert.equal(summary.total, 3);
  assert.equal(summary.reused, 2, 'both accounts sharing the password are flagged');
  const flaggedUsers = sample.map((s) => s.user).sort();
  assert.deepEqual(flaggedUsers, ['a@x.com', 'b@x.com']);
  assert.ok(sample.every((s) => s.reasons.includes('reused across accounts')));
});

test('analyzeHygiene flags passwords present in a breach corpus', () => {
  const breached = new Set([sha1Hex('Different#One7')]);
  const records = [
    { user: 'a@x.com', pass: 'Different#One7' }, // breached, otherwise strong
    { user: 'b@x.com', pass: 'Un1que&Safe!99' },
  ];
  const { summary, sample } = analyzeHygiene(records, { breachedHashes: breached });
  assert.equal(summary.breached, 1);
  assert.equal(summary.flagged, 1);
  assert.equal(sample[0].user, 'a@x.com');
  assert.ok(sample[0].reasons.includes('found in breach corpus'));
});

test('summary counts totals and leaves clean accounts unflagged', () => {
  const records = [
    { user: 'ok@x.com', pass: 'Un1que&Safe!99' },
    { user: 'weak@x.com', pass: '123456' },
  ];
  const { summary } = analyzeHygiene(records);
  assert.equal(summary.total, 2);
  assert.equal(summary.flagged, 1);
  assert.equal(summary.weak, 1);
});
