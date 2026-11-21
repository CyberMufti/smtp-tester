import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smtpLoginCheck, verifyCombo, runComboChecks } from '../src/core/combo.js';
import { candidatesFor } from '../src/core/providers.js';

test('candidatesFor: excludePort25 removes every port-25 candidate', () => {
  const all = candidatesFor({ user: 'a@acme.com' }, { mxHosts: ['mx.acme.com'] });
  const no25 = candidatesFor({ user: 'a@acme.com' }, { mxHosts: ['mx.acme.com'], excludePort25: true });
  assert.ok(all.some((c) => c.port === 25), 'baseline should include 25');
  assert.equal(no25.some((c) => c.port === 25), false, 'excludePort25 must drop all 25s');
});

test('smtpLoginCheck: authenticates on a submission port -> valid (never port 25)', async () => {
  const ports = [];
  const smtp = await smtpLoginCheck({ user: 'a@gmail.com', pass: 'app-pw' }, {
    smtpVerify: async (cred) => { ports.push(cred.port); return { connected: true, authenticated: cred.port === 587 }; },
  });
  assert.equal(smtp.status, 'valid');
  assert.equal(smtp.port, 587);
  assert.equal(ports.includes(25), false, 'must never try port 25');
});

test('smtpLoginCheck: reachable server refuses the login -> invalid', async () => {
  const smtp = await smtpLoginCheck({ user: 'a@gmail.com', pass: 'wrong' }, {
    smtpVerify: async () => ({ connected: true, authenticated: false, error: 'EAUTH 535' }),
  });
  assert.equal(smtp.status, 'invalid');
});

test('smtpLoginCheck: nothing reachable -> unknown (not a false invalid)', async () => {
  const smtp = await smtpLoginCheck({ user: 'a@gmail.com', pass: 'x' }, {
    smtpVerify: async () => ({ connected: false, error: 'ETIMEDOUT' }),
  });
  assert.equal(smtp.status, 'unknown');
});

test('smtpLoginCheck: missing password is invalid without any network call', async () => {
  let called = false;
  const smtp = await smtpLoginCheck({ user: 'a@gmail.com', pass: '' }, { smtpVerify: async () => { called = true; return {}; } });
  assert.equal(smtp.status, 'invalid');
  assert.equal(called, false);
});

test('verifyCombo: runs both checks and returns both verdicts', async () => {
  const r = await verifyCombo({ user: 'a@contoso.com', pass: 'p' }, {
    smtpVerify: async () => ({ connected: true, authenticated: true }),
    verifyOffice365: async (t) => ({ user: t.user, pass: t.pass, status: 'valid', method: 'oauth', detail: 'token' }),
  });
  assert.equal(r.smtp.status, 'valid');
  assert.equal(r.o365.status, 'valid');
  assert.equal(r.user, 'a@contoso.com');
});

test('verifyCombo: a throw in one side becomes unknown, never crashes the pair', async () => {
  const r = await verifyCombo({ user: 'a@x.com', pass: 'p' }, {
    smtpVerify: async () => { throw new Error('socket boom'); },
    verifyOffice365: async () => { throw new Error('oauth boom'); },
  });
  assert.equal(r.smtp.status, 'unknown');
  assert.equal(r.o365.status, 'unknown');
});

test('runComboChecks: processes a batch and reports each result', async () => {
  const seen = [];
  const res = await runComboChecks(
    [{ user: 'a@x.com', pass: '1' }, { user: 'b@x.com', pass: '2' }],
    {
      concurrency: 2,
      smtpVerify: async (cred) => ({ connected: true, authenticated: cred.user === 'a@x.com' }),
      verifyOffice365: async (t) => ({ user: t.user, pass: t.pass, status: 'not-o365', method: 'oauth', detail: 'AADSTS50034' }),
    },
    (r, i) => seen.push([i, r.smtp.status]),
  );
  assert.equal(res[0].smtp.status, 'valid');
  assert.equal(res[1].smtp.status, 'invalid');
  assert.equal(seen.length, 2);
});
