import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCpanelLogin, verifyCpanel, runCpanelChecks } from '../src/core/cpanel.js';

test('a login_only JSON status:1 is a valid login (panel up)', () => {
  const r = classifyCpanelLogin({ statusCode: 200, body: JSON.stringify({ status: 1, security_token: '/cpsess1234567890/' }) });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('a login_only JSON status:0 is reachable but invalid credentials', () => {
  const r = classifyCpanelLogin({ statusCode: 200, body: JSON.stringify({ status: 0, message: 'The login is invalid.' }) });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
  assert.match(r.detail, /invalid/i);
});

test('a 302 redirect to a cpsess session counts as a valid login', () => {
  const r = classifyCpanelLogin({ statusCode: 302, headers: { location: 'https://host:2083/cpsess9988/frontend/' }, body: '' });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('an HTTP 401 is reachable but invalid', () => {
  const r = classifyCpanelLogin({ statusCode: 401, body: 'Access denied' });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('a cPanel-looking page we cannot parse is reachable-but-unknown', () => {
  const r = classifyCpanelLogin({ statusCode: 200, body: '<html><title>cPanel Login</title> login_only</html>' });
  assert.equal(r.reachable, true);
  assert.equal(r.status, 'unknown');
});

test('a non-cPanel response is flagged not-cpanel', () => {
  const r = classifyCpanelLogin({ statusCode: 200, body: '<html>Apache default page</html>' });
  assert.equal(r.reachable, true);
  assert.equal(r.status, 'not-cpanel');
});

test('no response (refused/timeout/TLS error) is unreachable (site down)', () => {
  const r = classifyCpanelLogin({ error: 'ECONNREFUSED' });
  assert.equal(r.reachable, false);
  assert.equal(r.status, 'unreachable');
  assert.match(r.detail, /ECONNREFUSED/);
});

test('verifyCpanel posts to the login_only endpoint with url-encoded creds and reports the outcome', async () => {
  const calls = [];
  const request = async (url, { headers, body }) => {
    calls.push({ url, headers, body });
    return { statusCode: 200, body: JSON.stringify({ status: 1, security_token: '/cpsessABC/' }) };
  };
  const r = await verifyCpanel({ host: 'server.example.com', user: 'acct', pass: 'p@ss:word', port: 2083 }, { request });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://server.example.com:2083/login/?login_only=1');
  assert.match(calls[0].body, /^user=acct&pass=/);
  assert.match(calls[0].body, /p%40ss%3Aword/); // ':' and '@' in the password are percent-encoded
  assert.equal(r.host, 'server.example.com');
  assert.equal(r.port, 2083);
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('verifyCpanel defaults the port to 2083 and surfaces a transport error as unreachable', async () => {
  const request = async () => ({ error: 'getaddrinfo ENOTFOUND' });
  const r = await verifyCpanel({ host: 'down.example.com', user: 'u', pass: 'p' }, { request });
  assert.equal(r.port, 2083);
  assert.equal(r.status, 'unreachable');
  assert.equal(r.valid, false);
});

test('verifyCpanel with no host is unreachable without making a request', async () => {
  let called = false;
  const request = async () => {
    called = true;
    return {};
  };
  const r = await verifyCpanel({ host: '', user: 'u', pass: 'p' }, { request });
  assert.equal(called, false);
  assert.equal(r.status, 'unreachable');
});

test('runCpanelChecks returns one result per target and reports progress', async () => {
  const targets = [
    { host: 'a.example.com', user: 'a', pass: '1' },
    { host: 'b.example.com', user: 'b', pass: '2' },
    { host: 'c.example.com', user: 'c', pass: '3' },
  ];
  const request = async (url) => {
    const ok = url.includes('b.example.com');
    return { statusCode: 200, body: JSON.stringify({ status: ok ? 1 : 0, security_token: ok ? '/cpsessX/' : '' }) };
  };
  const progress = [];
  const results = await runCpanelChecks(targets, { request, concurrency: 2 }, (r) => progress.push(r.host));

  assert.equal(results.length, 3);
  assert.equal(progress.length, 3);
  assert.deepEqual(results.map((r) => r.host), ['a.example.com', 'b.example.com', 'c.example.com']);
  assert.equal(results.find((r) => r.host === 'b.example.com').valid, true);
  assert.equal(results.find((r) => r.host === 'a.example.com').valid, false);
});

test('runCpanelChecks stops dispatching once aborted', async () => {
  const targets = Array.from({ length: 20 }, (_, i) => ({ host: `h${i}.example.com`, user: 'u', pass: 'p' }));
  const controller = new AbortController();
  let seen = 0;
  const request = async () => {
    seen++;
    if (seen === 2) controller.abort();
    return { statusCode: 200, body: JSON.stringify({ status: 0 }) };
  };
  const results = await runCpanelChecks(targets, { request, concurrency: 1, signal: controller.signal });
  const completed = results.filter(Boolean).length;
  assert.ok(completed >= 2 && completed < targets.length, `expected a partial run, got ${completed}`);
});
