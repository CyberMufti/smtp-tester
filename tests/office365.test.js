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

test('classifyTokenResponse: a token is valid', () => {
  assert.equal(classifyTokenResponse({ ok: true, data: { access_token: 'ey...' } }).status, 'valid');
});

test('classifyTokenResponse: AADSTS50126 is a wrong password -> invalid', () => {
  const r = classifyTokenResponse({ ok: false, data: { error_description: 'AADSTS50126: Error validating credentials.' } });
  assert.equal(r.status, 'invalid');
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

test('parseOffice365Lines: email:pass, email pass, and trailing host:port all yield {user,pass}', () => {
  assert.deepEqual(parseOffice365Lines('a@x.com:secret'), [{ user: 'a@x.com', pass: 'secret' }]);
  assert.deepEqual(parseOffice365Lines('b@x.com password2'), [{ user: 'b@x.com', pass: 'password2' }]);
  assert.deepEqual(parseOffice365Lines('c@x.com:pw3:outlook.office365.com:993'), [{ user: 'c@x.com', pass: 'pw3' }]);
  assert.deepEqual(parseOffice365Lines('# comment\n\nd@x.com:pw4'), [{ user: 'd@x.com', pass: 'pw4' }]);
});
