import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPlacementStatus } from '../src/core/seed-status.js';

const fullSeed = {
  address: 'seed@gmail.com',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapUser: 'seed@gmail.com',
  imapPassword: 'app-password',
};

test('no seeds -> warn, placement disabled', () => {
  const s = seedPlacementStatus([]);
  assert.equal(s.enabled, false);
  assert.equal(s.warn, true);
  assert.equal(s.usableCount, 0);
  assert.match(s.message, /inbox\/spam/i);
});

test('one complete seed -> enabled, no warning', () => {
  const s = seedPlacementStatus([fullSeed]);
  assert.equal(s.enabled, true);
  assert.equal(s.warn, false);
  assert.equal(s.usableCount, 1);
});

test('a seed missing IMAP credentials is not usable for placement', () => {
  // An address with no IMAP host/user/password can be sent to, but the app can
  // never read it back — so placement still cannot be verified and we must warn.
  const s = seedPlacementStatus([{ address: 'seed@gmail.com' }]);
  assert.equal(s.enabled, false);
  assert.equal(s.warn, true);
  assert.equal(s.usableCount, 0);
});

test('counts only the usable seeds among a mix', () => {
  const s = seedPlacementStatus([fullSeed, { address: 'x@y.com' }, { ...fullSeed, address: 'two@gmail.com' }]);
  assert.equal(s.enabled, true);
  assert.equal(s.usableCount, 2);
});
