import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, candidatesFor } from '../src/core/providers.js';

test('detects Gmail from an email address', () => {
  const p = detectProvider('someone@gmail.com');
  assert.equal(p.host, 'smtp.gmail.com');
  assert.ok(p.ports.includes(587));
});

test('detects Outlook/Hotmail aliases', () => {
  assert.equal(detectProvider('a@outlook.com').host, 'smtp-mail.outlook.com');
  assert.equal(detectProvider('a@hotmail.com').host, 'smtp-mail.outlook.com');
});

test('returns null for an unknown domain or a non-email', () => {
  assert.equal(detectProvider('a@madeup-domain-xyz.com'), null);
  assert.equal(detectProvider('apikey'), null);
});

test('candidatesFor: input host+port comes first, detected host follows', () => {
  const c = candidatesFor({ host: 'mail.custom.com', port: 2525, user: 'me@gmail.com', pass: 'x' });
  assert.equal(c[0].host, 'mail.custom.com');
  assert.equal(c[0].port, 2525);
  assert.equal(c[0].source, 'input');
  // Gmail fallback appears after the input candidate.
  assert.ok(c.some((cand) => cand.host === 'smtp.gmail.com' && cand.source === 'detected'));
});

test('candidatesFor: no host but detectable user yields detected candidates only', () => {
  const c = candidatesFor({ host: null, port: null, user: 'me@gmail.com', pass: 'x' });
  assert.ok(c.length > 0);
  assert.ok(c.every((cand) => cand.source === 'detected'));
  assert.equal(c[0].host, 'smtp.gmail.com');
});

test('candidatesFor: host present but invalid port tries standard ports on that host', () => {
  const c = candidatesFor({ host: 'mail.custom.com', port: null, user: 'u@custom.com', pass: 'x' });
  const ports = c.filter((cand) => cand.host === 'mail.custom.com').map((cand) => cand.port);
  assert.deepEqual(ports, [587, 465]);
});

test('candidatesFor: a valid-but-wrong port on a custom host still gets standard-port fallbacks', () => {
  const c = candidatesFor({ host: 'smtp.customrelay.com', port: 25, user: 'apikey', pass: 'x' });
  const ports = c.filter((cand) => cand.host === 'smtp.customrelay.com').map((cand) => cand.port);
  assert.ok(ports.includes(25), 'the user-supplied port is tried first');
  assert.ok(ports.includes(587) && ports.includes(465), 'standard ports are appended as fallback');
  assert.equal(ports[0], 25);
});

test('candidatesFor: no host and undetectable user yields no candidates', () => {
  const c = candidatesFor({ host: null, port: null, user: 'apikey', pass: 'x' });
  assert.equal(c.length, 0);
});

test('candidatesFor: does not duplicate a candidate already covered by input', () => {
  const c = candidatesFor({ host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: 'x' });
  const gmail587 = c.filter((cand) => cand.host === 'smtp.gmail.com' && cand.port === 587);
  assert.equal(gmail587.length, 1);
});
