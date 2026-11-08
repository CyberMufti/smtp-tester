import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockoutRegistry, detectLockout } from '../src/core/lockout.js';

test('detectLockout matches common server signals', () => {
  assert.ok(detectLockout('Too many failed login attempts'));
  assert.ok(detectLockout('Account is temporarily locked'));
  assert.ok(detectLockout('Please wait 15 minutes before retrying'));
  assert.ok(detectLockout('cPHulk: IP blocked'));
  assert.ok(detectLockout('Too many authentication failures'));
  assert.ok(detectLockout('Rate limit exceeded'));
});

test('detectLockout returns null for normal errors', () => {
  assert.equal(detectLockout('Invalid login'), null);
  assert.equal(detectLockout('Authentication failed'), null);
  assert.equal(detectLockout(''), null);
  assert.equal(detectLockout(null), null);
});

test('recordFailure increments counter but does not lock before threshold', () => {
  const reg = new LockoutRegistry({ maxFailures: 3 });
  reg.recordFailure('a@b.com', 'smtp');
  reg.recordFailure('a@b.com', 'smtp');
  assert.equal(reg.isLocked('a@b.com', 'smtp'), false);
  assert.equal(reg.get('a@b.com', 'smtp').failures, 2);
});

test('isLocked true after maxFailures reached, within cooldown window', () => {
  const reg = new LockoutRegistry({ maxFailures: 3, lockoutMs: 60000 });
  reg.recordFailure('a@b.com', 'smtp');
  reg.recordFailure('a@b.com', 'smtp');
  reg.recordFailure('a@b.com', 'smtp');
  assert.equal(reg.isLocked('a@b.com', 'smtp'), true);
  assert.equal(reg.get('a@b.com', 'smtp').reason, 'cooldown after 3 failures');
});

test('cooldown expires after lockoutMs — new attempts allowed', () => {
  const reg = new LockoutRegistry({ maxFailures: 3, lockoutMs: 1000 });
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) reg.recordFailure('a@b.com', 'smtp', now);
  assert.equal(reg.isLocked('a@b.com', 'smtp', now + 500), true);
  assert.equal(reg.isLocked('a@b.com', 'smtp', now + 1500), false);
  // Counter reset after expiry
  assert.equal(reg.get('a@b.com', 'smtp').failures, 0);
});

test('hard lockout at hardLockFailures — never expires', () => {
  const reg = new LockoutRegistry({ maxFailures: 3, hardLockFailures: 5, lockoutMs: 100 });
  for (let i = 0; i < 5; i++) reg.recordFailure('a@b.com', 'smtp', 0);
  assert.equal(reg.isLocked('a@b.com', 'smtp', 0), true);
  assert.equal(reg.isLocked('a@b.com', 'smtp', 999999999), true);
});

test('recordSuccess clears the entry', () => {
  const reg = new LockoutRegistry();
  reg.recordFailure('a@b.com', 'smtp');
  reg.recordFailure('a@b.com', 'smtp');
  reg.recordSuccess('a@b.com', 'smtp');
  assert.equal(reg.isLocked('a@b.com', 'smtp'), false);
  assert.equal(reg.get('a@b.com', 'smtp'), null);
});

test('markLocked sets state immediately with custom reason', () => {
  const reg = new LockoutRegistry({ lockoutMs: 5000 });
  reg.markLocked('x@y.com', 'cpanel', 'server: too many attempts');
  assert.equal(reg.isLocked('x@y.com', 'cpanel'), true);
  assert.equal(reg.get('x@y.com', 'cpanel').reason, 'server: too many attempts');
});

test('per-protocol isolation: locking smtp does not lock cpanel', () => {
  const reg = new LockoutRegistry();
  reg.markLocked('a@b.com', 'smtp', 'test');
  assert.equal(reg.isLocked('a@b.com', 'smtp'), true);
  assert.equal(reg.isLocked('a@b.com', 'cpanel'), false);
});

test('email case-insensitive', () => {
  const reg = new LockoutRegistry();
  reg.markLocked('A@B.com', 'smtp', 'test');
  assert.equal(reg.isLocked('a@b.com', 'smtp'), true);
});

test('stats returns counts', () => {
  const reg = new LockoutRegistry({ maxFailures: 2, hardLockFailures: 5, lockoutMs: 60000 });
  reg.recordFailure('a@b.com', 'smtp');
  reg.recordFailure('a@b.com', 'smtp');
  reg.markLocked('c@d.com', 'cpanel', 'server', Infinity);
  const s = reg.stats();
  assert.equal(s.tracked, 2);
  assert.ok(s.cooldown >= 1);
  assert.ok(s.hard >= 1);
});
