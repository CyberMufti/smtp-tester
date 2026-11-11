import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, detectBlocked } from '../src/core/classify.js';

const authFail = (authError, userExists) => classify({
  connected: true, authenticated: false, sent: false, seeds: [], authError, userExists,
});

test('detectBlocked matches throttle/block/temporary language, not a plain bad password', () => {
  for (const t of [
    'Too many login attempts, please try again later',
    '454 4.7.0 Temporary authentication failure',
    'Account temporarily locked due to suspicious activity',
    'unusual sign-in activity detected',
    '421 4.7.0 try again later',
    'Your IP address has been temporarily blocked',
    'rate limit exceeded, slow down',
  ]) assert.equal(detectBlocked(t), true, t);

  for (const t of [
    '535 5.7.8 Authentication failed',
    'Invalid login: 535 incorrect username or password',
    '535 5.7.8 Error: authentication failed',
    undefined, '',
  ]) assert.equal(detectBlocked(t), false, String(t));
});

test('a throttled/blocked login is NOT a confirmed dead credential', () => {
  const r = authFail('Too many failed login attempts - try again later', true);
  assert.notEqual(r.status, 'dead');
  assert.equal(r.blocked, true);
  assert.match(r.reason, /throttl|block/i);
  // Existence is NOT asserted for a blocked login (the server never evaluated it).
  assert.notEqual(r.userExists, true);
});

test('a genuine bad-password 535 stays dead (unchanged)', () => {
  const r = authFail('535 5.7.8 Authentication failed', true);
  assert.equal(r.status, 'dead');
  assert.notEqual(r.blocked, true);
});

test('a throttled CONNECT failure is also treated as blocked, not a confirmed dead', () => {
  const r = classify({ connected: false, authenticated: false, sent: false, seeds: [], connectError: '421 too many connections, slow down' });
  assert.notEqual(r.status, 'dead');
  assert.equal(r.blocked, true);
});

test('a normal connection failure stays dead', () => {
  const r = classify({ connected: false, authenticated: false, sent: false, seeds: [], connectError: 'ECONNREFUSED 1.2.3.4:587' });
  assert.equal(r.status, 'dead');
  assert.notEqual(r.blocked, true);
});

import { inferUserExists } from '../src/core/smtp.js';

test('inferUserExists: explicit non-existence signals -> false; generic refusals -> true', () => {
  for (const m of [
    '550 5.1.1 user unknown', 'No such user here', 'mailbox unavailable',
    '5.1.1 recipient address rejected: user not found', 'invalid mailbox', 'account does not exist',
  ]) assert.equal(inferUserExists(m), false, m);

  for (const m of [
    '535 5.7.8 authentication failed', 'incorrect password', 'Invalid login',
    'error ticket 15500', '', undefined,
  ]) assert.equal(inferUserExists(m), true, String(m));
});
