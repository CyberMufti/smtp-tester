import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyImapLogin,
  classifyTokenResponse,
  verifyOffice365,
  runOffice365Checks,
  parseOffice365Lines,
} from '../src/core/office365.js';

test('classifyImapLogin: clean login is valid, no fallback', () => {
  assert.deepEqual(classifyImapLogin({ ok: true }), { status: 'valid', method: 'imap', fallback: false });
});

test('classifyImapLogin: clear bad credentials -> invalid, no fallback', () => {
  const r = classifyImapLogin({ ok: false, error: 'LOGIN failed: invalid credentials' });
  assert.equal(r.status, 'invalid');
  assert.equal(r.fallback, false);
});

test('classifyImapLogin: basic-auth-disabled -> inconclusive, falls back to OAuth2', () => {
  const r = classifyImapLogin({ ok: false, error: 'Authentication unsuccessful, basic authentication is disabled.' });
  assert.equal(r.fallback, true);
});

test('classifyImapLogin: connection error -> unreachable, falls back', () => {
  const r = classifyImapLogin({ ok: false, error: 'connect ETIMEDOUT' });
  assert.equal(r.status, 'unreachable');
  assert.equal(r.fallback, true);
});

test('classifyImapLogin: "Login is disabled" is auth-disabled, not a wrong password -> falls back', () => {
  // Microsoft returns this with authenticationFailed=true; it must NOT be read as
  // a bad password (which would be a false "invalid").
  const r = classifyImapLogin({ ok: false, error: 'Login is disabled', authFailed: true });
  assert.equal(r.status, 'unknown');
  assert.equal(r.fallback, true);
});

test('classifyImapLogin: authFailed with no "disabled" signal is a real wrong password', () => {
  const r = classifyImapLogin({ ok: false, error: 'LOGIN failed.', authFailed: true });
  assert.equal(r.status, 'invalid');
  assert.equal(r.fallback, false);
});

test('classifyTokenResponse: a token is valid', () => {
  assert.equal(classifyTokenResponse({ ok: true, data: { access_token: 'ey...' } }).status, 'valid');
});

test('classifyTokenResponse: AADSTS50126 (real account, wrong password) -> invalid', () => {
  const r = classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS50126: Error validating credentials.' } });
  assert.equal(r.status, 'invalid');
});

test('classifyTokenResponse: AADSTS50034 (no such mailbox) -> not-o365, NOT invalid', () => {
  // This is the proton.me / gmail case: the address has no Microsoft 365 mailbox,
  // which must never be reported as a wrong password.
  const r = classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS50034: The user account does not exist.' } });
  assert.equal(r.status, 'not-o365');
});

test('classifyTokenResponse: tenant-not-found (AADSTS90002) -> not-o365', () => {
  assert.equal(classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS90002: Tenant not found' } }).status, 'not-o365');
});

test('classifyTokenResponse: MFA/conditional-access codes -> unknown (not a false invalid)', () => {
  for (const code of ['50076', '50079', '50158', '53003', '50055']) {
    const r = classifyTokenResponse({ ok: false, data: { error_description: `AADSTS${code}: more info needed` } });
    assert.equal(r.status, 'unknown', code);
  }
});

test('verifyOffice365: a working IMAP login never calls OAuth2', async () => {
  let tokenCalled = false;
  const r = await verifyOffice365(
    { user: 'a@contoso.com', pass: 'pw' },
    { imapLogin: async () => ({ ok: true }), tokenRequest: async () => { tokenCalled = true; return { ok: false, data: {} }; } },
  );
  assert.equal(r.status, 'valid');
  assert.equal(r.method, 'imap');
  assert.equal(tokenCalled, false);
});

test('verifyOffice365: IMAP basic-auth-disabled falls back to OAuth2 and uses its verdict', async () => {
  const r = await verifyOffice365(
    { user: 'a@contoso.com', pass: 'pw' },
    {
      imapLogin: async () => ({ ok: false, error: 'basic authentication is disabled' }),
      tokenRequest: async () => ({ ok: true, data: { access_token: 'ey...' } }),
    },
  );
  assert.equal(r.status, 'valid');
  assert.equal(r.method, 'oauth');
});

test('verifyOffice365: a clear IMAP bad password is invalid without an OAuth2 call', async () => {
  let tokenCalled = false;
  const r = await verifyOffice365(
    { user: 'a@contoso.com', pass: 'wrong' },
    { imapLogin: async () => ({ ok: false, error: 'invalid credentials' }), tokenRequest: async () => { tokenCalled = true; return {}; } },
  );
  assert.equal(r.status, 'invalid');
  assert.equal(tokenCalled, false);
});

test('verifyOffice365: missing password is invalid', async () => {
  const r = await verifyOffice365({ user: 'a@contoso.com', pass: '' }, {});
  assert.equal(r.status, 'invalid');
});

test('runOffice365Checks: runs the batch in order and reports each result', async () => {
  const seen = [];
  const results = await runOffice365Checks(
    [{ user: 'a@x.com', pass: '1' }, { user: 'b@x.com', pass: '2' }],
    { concurrency: 2, imapLogin: async (u) => ({ ok: u === 'a@x.com' }), tokenRequest: async () => ({ ok: false, data: { error_description: 'AADSTS50126' } }) },
    (r, i) => seen.push([i, r.status]),
  );
  assert.equal(results[0].status, 'valid');
  assert.equal(results[1].status, 'invalid');
  assert.equal(seen.length, 2);
});

test('parseOffice365Lines: email:pass and email pass', () => {
  assert.deepEqual(parseOffice365Lines('a@x.com:secret'), [{ user: 'a@x.com', pass: 'secret' }]);
  assert.deepEqual(parseOffice365Lines('b@x.com password2'), [{ user: 'b@x.com', pass: 'password2' }]);
  assert.deepEqual(parseOffice365Lines('# comment\n\nd@x.com:pw4'), [{ user: 'd@x.com', pass: 'pw4' }]);
});

test('parseOffice365Lines: passwords containing : ; , or spaces are NOT truncated', () => {
  // This was the false-"invalid" bug: a password with a colon was cut short.
  assert.deepEqual(parseOffice365Lines('a@x.com:P@ss:w0rd:99'), [{ user: 'a@x.com', pass: 'P@ss:w0rd:99' }]);
  assert.deepEqual(parseOffice365Lines('b@x.com:two words here'), [{ user: 'b@x.com', pass: 'two words here' }]);
  assert.deepEqual(parseOffice365Lines('c@x.com;semi;colon'), [{ user: 'c@x.com', pass: 'semi;colon' }]);
  // No password at all -> skipped (can't check without one).
  assert.deepEqual(parseOffice365Lines('d@x.com'), []);
});

test('classifyTokenResponse: MFA codes mark the password as valid (not a flat unknown)', () => {
  const r = classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS50076: MFA required' } });
  assert.equal(r.status, 'unknown');
  assert.equal(r.passwordValid, true);
  assert.match(r.detail, /VALID/);
});

test('classifyTokenResponse: throttle/lockout codes are flagged throttled, never invalid', () => {
  const r = classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS50053: account locked' } });
  assert.equal(r.status, 'unknown');
  assert.equal(r.throttled, true);
});

test('classifyTokenResponse: a blocked ROPC client (700016) is unknown, not invalid', () => {
  assert.equal(classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS700016' } }).status, 'unknown');
});

test('classifyImapLogin: throttling is never a wrong password', () => {
  const r = classifyImapLogin({ ok: false, error: 'Request is throttled. Please try again.', authFailed: true });
  assert.equal(r.status, 'unknown');
  assert.equal(r.fallback, true);
});
