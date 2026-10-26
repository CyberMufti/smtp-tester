import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, candidatesFor, office365RelayHost } from '../src/core/providers.js';

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

test('candidatesFor: host-less email on an unknown domain guesses smtp./mail. hosts on standard ports', () => {
  const c = candidatesFor({ host: null, port: null, user: 'u@premiumisme.com', pass: 'x' });
  const hp = c.map((x) => `${x.host}:${x.port}`);
  assert.ok(hp.includes('smtp.premiumisme.com:587'));
  assert.ok(hp.includes('mail.premiumisme.com:587'));
  assert.ok(hp.includes('smtp.premiumisme.com:465'));
  assert.ok(c.every((x) => x.source === 'guessed'));
});

test('candidatesFor: MX hosts (when supplied) are tried before the smtp./mail. guesses', () => {
  const c = candidatesFor(
    { host: null, port: null, user: 'u@premiumisme.com', pass: 'x' },
    { mxHosts: ['mx1.premiumisme.com'] },
  );
  const firstGuessIdx = c.findIndex((x) => x.source === 'guessed');
  const mxIdx = c.findIndex((x) => x.host === 'mx1.premiumisme.com');
  assert.ok(mxIdx !== -1 && mxIdx < firstGuessIdx, 'MX candidate should come before guessed ones');
  assert.equal(c[mxIdx].source, 'mx');
});

test('candidatesFor: a known provider ignores guessing/MX (authoritative endpoint only)', () => {
  const c = candidatesFor(
    { host: null, port: null, user: 'u@gmail.com', pass: 'x' },
    { mxHosts: ['aspmx.l.google.com'] },
  );
  assert.ok(c.every((x) => x.host === 'smtp.gmail.com'));
});

test('candidatesFor: a custom domain whose MX is Zoho tries smtp.zoho.com first', () => {
  const c = candidatesFor({ host: null, port: null, user: 'u@biz.com', pass: 'x' }, { mxHosts: ['mx.zoho.com', 'mx2.zoho.com'] });
  assert.equal(c[0].host, 'smtp.zoho.com');
  assert.equal(c[0].source, 'detected');
});

test('candidatesFor: a custom domain on Google Workspace maps to smtp.gmail.com', () => {
  const c = candidatesFor({ host: null, port: null, user: 'u@biz.com', pass: 'x' }, { mxHosts: ['aspmx.l.google.com'] });
  assert.equal(c[0].host, 'smtp.gmail.com');
});

test('candidatesFor: a custom domain on Microsoft 365 maps to smtp.office365.com', () => {
  const c = candidatesFor({ host: null, port: null, user: 'u@biz.com', pass: 'x' }, { mxHosts: ['biz-com.mail.protection.outlook.com'] });
  assert.equal(c[0].host, 'smtp.office365.com');
});

test('candidatesFor: discovered hosts (SRV/autoconfig) are tried before MX and guesses', () => {
  const c = candidatesFor(
    { host: null, port: null, user: 'u@biz.com', pass: 'x' },
    { mxHosts: ['mx.biz.com'], discovered: [{ host: 'submission.biz.com', port: 587, source: 'srv' }] },
  );
  assert.equal(c[0].host, 'submission.biz.com');
  assert.equal(c[0].port, 587);
  const mxIdx = c.findIndex((x) => x.host === 'mx.biz.com');
  const guessIdx = c.findIndex((x) => x.source === 'guessed');
  assert.ok(0 < mxIdx && mxIdx < guessIdx);
});

test('candidatesFor: guesses cover smtp/mail/send/mta on 587, 465 and 2525', () => {
  const c = candidatesFor({ host: null, port: null, user: 'u@biz.com', pass: 'x' });
  const hp = new Set(c.map((x) => `${x.host}:${x.port}`));
  for (const prefix of ['smtp', 'mail', 'send', 'mta']) {
    assert.ok(hp.has(`${prefix}.biz.com:587`), `${prefix}.biz.com:587 missing`);
  }
  assert.ok(hp.has('smtp.biz.com:465'));
  assert.ok(hp.has('smtp.biz.com:2525'));
});

test('candidatesFor: no host and non-email user yields no candidates', () => {
  const c = candidatesFor({ host: null, port: null, user: 'apikey', pass: 'x' });
  assert.equal(c.length, 0);
});

test('office365RelayHost derives the tenant MX endpoint from a domain', () => {
  assert.equal(office365RelayHost('example.com'), 'example-com.mail.protection.outlook.com');
  assert.equal(office365RelayHost('sub.example.co.uk'), 'sub-example-co-uk.mail.protection.outlook.com');
  assert.equal(office365RelayHost(''), null);
});

test('candidatesFor: does not duplicate a candidate already covered by input', () => {
  const c = candidatesFor({ host: 'smtp.gmail.com', port: 587, user: 'me@gmail.com', pass: 'x' });
  const gmail587 = c.filter((cand) => cand.host === 'smtp.gmail.com' && cand.port === 587);
  assert.equal(gmail587.length, 1);
});
