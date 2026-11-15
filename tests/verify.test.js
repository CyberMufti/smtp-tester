import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDisposable, isRoleBased, verificationStatus, verifyEmail } from '../src/core/verify.js';

test('isDisposable flags known throwaway domains', () => {
  assert.equal(isDisposable('mailinator.com'), true);
  assert.equal(isDisposable('x.temp-mail.org'), true); // subdomain
  assert.equal(isDisposable('gmail.com'), false);
});

test('isRoleBased flags role local-parts', () => {
  assert.equal(isRoleBased('info@acme.com'), true);
  assert.equal(isRoleBased('admin@acme.com'), true);
  assert.equal(isRoleBased('john.doe@acme.com'), false);
});

test('verificationStatus maps signals to a verdict', () => {
  assert.equal(verificationStatus({ syntaxValid: false }), 'invalid-syntax');
  assert.equal(verificationStatus({ syntaxValid: true, hasMx: false }), 'no-mx');
  assert.equal(verificationStatus({ syntaxValid: true, hasMx: true, catchAll: true }), 'catch-all');
  assert.equal(verificationStatus({ syntaxValid: true, hasMx: true, exists: 'yes' }), 'valid');
  assert.equal(verificationStatus({ syntaxValid: true, hasMx: true, exists: 'no' }), 'invalid');
  assert.equal(verificationStatus({ syntaxValid: true, hasMx: true, exists: 'unknown' }), 'unknown');
});

const DEPS = {
  resolveMx: async (d) => ({ 'acme.com': ['mx.acme.com'], 'catchall.com': ['mx.catchall.com'], 'nomx.com': [] }[d] ?? ['mx.' + d]),
  // RCPT prober: acme has only john; catchall accepts anything
  enumerate: async (email, _opts) => {
    const [local, domain] = email.split('@');
    if (domain === 'catchall.com') return { exists: true };
    if (domain === 'acme.com') return { exists: local === 'john' };
    return { exists: 'unknown' };
  },
  msRealm: async () => ({ nameSpaceType: 'Unknown', ifExists: 'unknown' }),
  geoResolver: async () => 'US',
};

test('verifyEmail: existing mailbox -> valid', async () => {
  const r = await verifyEmail('john@acme.com', DEPS);
  assert.equal(r.status, 'valid');
  assert.equal(r.exists, 'yes');
  assert.equal(r.catchAll, false);
});

test('verifyEmail: non-existent mailbox -> invalid', async () => {
  const r = await verifyEmail('ghost@acme.com', DEPS);
  assert.equal(r.status, 'invalid');
  assert.equal(r.exists, 'no');
});

test('verifyEmail: catch-all domain -> catch-all (existence unverifiable)', async () => {
  const r = await verifyEmail('anyone@catchall.com', DEPS);
  assert.equal(r.status, 'catch-all');
  assert.equal(r.catchAll, true);
});

test('verifyEmail: bad syntax and no-MX are caught before probing', async () => {
  assert.equal((await verifyEmail('not-an-email', DEPS)).status, 'invalid-syntax');
  assert.equal((await verifyEmail('a@nomx.com', DEPS)).status, 'no-mx');
});

test('verifyEmail: M365 existence comes from the realm probe, no RCPT', async () => {
  let rcptCalled = false;
  const deps = {
    ...DEPS,
    resolveMx: async () => ['acme-com.mail.protection.outlook.com'],
    enumerate: async () => { rcptCalled = true; return { exists: 'unknown' }; },
    msRealm: async () => ({ nameSpaceType: 'Managed', ifExists: 'yes' }),
  };
  const r = await verifyEmail('ceo@acme.com', deps);
  assert.equal(r.status, 'valid');
  assert.equal(r.provider, 'Microsoft 365');
  assert.equal(rcptCalled, false, 'M365 must not RCPT-probe');
});

test('verifyEmail: consumer Outlook/Hotmail does NOT use the realm check (unreliable for consumer) and is not falsely invalid', async () => {
  let realmCalled = false;
  const deps = {
    ...DEPS,
    // Microsoft's endpoint returns "no" for every consumer address — must be ignored.
    msRealm: async () => { realmCalled = true; return { nameSpaceType: 'Federated', ifExists: 'no' }; },
    enumerate: async (email) => (email.startsWith('__probe') ? { exists: 'unknown' } : { exists: false }),
  };
  const r = await verifyEmail('someone@hotmail.com', deps);
  assert.equal(r.provider, 'Outlook/Hotmail');
  assert.equal(realmCalled, false, 'consumer Outlook/Hotmail must not be judged by the Azure-AD realm check');
  assert.equal(r.exists, 'unknown');
  assert.equal(r.status, 'unknown', 'consumer Outlook/Hotmail RCPT is untrusted — never a false "invalid"');
});

test('verifyEmail: a 550 from an anti-harvesting provider (Yahoo) is reported unknown, not a false invalid', async () => {
  const deps = {
    ...DEPS,
    // Yahoo returns the same rejection for real and fake mailboxes.
    enumerate: async (email) => (email.startsWith('__probe') ? { exists: 'unknown' } : { exists: false }),
  };
  const r = await verifyEmail('realuser@yahoo.com', deps);
  assert.equal(r.provider, 'Yahoo/AOL');
  assert.equal(r.exists, 'unknown');
  assert.equal(r.status, 'unknown', 'an untrusted RCPT verdict must not be surfaced as "invalid"');
});

test('verifyEmail: RCPT verdicts are still trusted for ordinary custom domains', async () => {
  assert.equal((await verifyEmail('john@acme.com', DEPS)).status, 'valid');
  assert.equal((await verifyEmail('ghost@acme.com', DEPS)).status, 'invalid');
});
