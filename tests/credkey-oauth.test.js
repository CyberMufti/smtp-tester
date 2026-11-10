import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credKey } from '../src/core/parser.js';

test('two OAuth2 creds for the same user/host/port but different tokens are distinct', () => {
  const a = { host: 'smtp.x.com', port: 587, user: 'u@x.com', oauth: { refreshToken: 'TOKEN_A', clientId: 'c', clientSecret: 's' } };
  const b = { host: 'smtp.x.com', port: 587, user: 'u@x.com', oauth: { refreshToken: 'TOKEN_B', clientId: 'c', clientSecret: 's' } };
  assert.notEqual(credKey(a), credKey(b), 'different refresh tokens must not collapse to one dedupe key');
});

test('OAuth2 access-token mode also distinguishes by token', () => {
  const a = { host: 'smtp.x.com', port: 587, user: 'u@x.com', oauth: { accessToken: 'AAA' } };
  const b = { host: 'smtp.x.com', port: 587, user: 'u@x.com', oauth: { accessToken: 'BBB' } };
  assert.notEqual(credKey(a), credKey(b));
});

test('password creds are unchanged — key still distinguishes by password', () => {
  const a = { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p1' };
  const b = { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p2' };
  assert.notEqual(credKey(a), credKey(b));
  // Identical password creds still collapse (dedupe still works).
  assert.equal(credKey(a), credKey({ ...a }));
});
