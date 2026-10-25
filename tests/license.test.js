import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { issueLicense, verifyLicense } from '../src/core/license.js';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

test('a license issued for an HWID verifies on that HWID', () => {
  const { pub, priv } = keypair();
  const key = issueLicense('HWID-ABC', priv);
  const r = verifyLicense('HWID-ABC', key, pub);
  assert.equal(r.valid, true);
});

test('a license does not verify on a different HWID', () => {
  const { pub, priv } = keypair();
  const key = issueLicense('HWID-ABC', priv);
  const r = verifyLicense('HWID-XYZ', key, pub);
  assert.equal(r.valid, false);
  assert.match(r.reason, /machine/i);
});

test('a tampered license fails the signature check', () => {
  const { pub, priv } = keypair();
  const key = issueLicense('HWID-ABC', priv);
  const tampered = key.slice(0, -4) + 'AAAA';
  const r = verifyLicense('HWID-ABC', tampered, pub);
  assert.equal(r.valid, false);
  assert.match(r.reason, /signature|invalid/i);
});

test('a license signed by a different key does not verify', () => {
  const a = keypair();
  const b = keypair();
  const key = issueLicense('HWID-ABC', a.priv);
  const r = verifyLicense('HWID-ABC', key, b.pub);
  assert.equal(r.valid, false);
});

test('an expired license is rejected; a not-yet-expired one passes', () => {
  const { pub, priv } = keypair();
  const key = issueLicense('HWID-ABC', priv, { expMs: 1000 });
  assert.equal(verifyLicense('HWID-ABC', key, pub, 500).valid, true);
  const r = verifyLicense('HWID-ABC', key, pub, 2000);
  assert.equal(r.valid, false);
  assert.match(r.reason, /expire/i);
});

test('garbage input is rejected without throwing', () => {
  const { pub } = keypair();
  assert.equal(verifyLicense('HWID-ABC', 'not-a-key', pub).valid, false);
  assert.equal(verifyLicense('HWID-ABC', '', pub).valid, false);
});
