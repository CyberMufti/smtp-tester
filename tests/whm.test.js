import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWhmLogin, verifyWhm, runWhmChecks } from '../src/core/whm.js';

test('status:1 JSON is a valid WHM login', () => {
  const r = classifyWhmLogin({ statusCode: 200, body: JSON.stringify({ status: 1, security_token: '/cpsess99/' }) });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('status:0 JSON is reachable but invalid', () => {
  const r = classifyWhmLogin({ statusCode: 200, body: JSON.stringify({ status: 0, message: 'login invalid' }) });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('a 302 to a cpsess session is valid', () => {
  const r = classifyWhmLogin({ statusCode: 302, headers: { location: 'https://h:2087/cpsess55/whm/' }, body: '' });
  assert.equal(r.valid, true);
});

test('a non-WHM response is flagged not-whm', () => {
  const r = classifyWhmLogin({ statusCode: 200, body: '<html>nginx welcome</html>' });
  assert.equal(r.status, 'not-whm');
});

test('no response is unreachable', () => {
  const r = classifyWhmLogin({ error: 'ECONNREFUSED' });
  assert.equal(r.reachable, false);
  assert.equal(r.status, 'unreachable');
});

test('verifyWhm posts to login_only on port 2087 and reports the outcome', async () => {
  const calls = [];
  const request = async (url, { body }) => {
    calls.push({ url, body });
    return { statusCode: 200, body: JSON.stringify({ status: 1, security_token: '/cpsessAB/' }) };
  };
  const r = await verifyWhm({ host: 'srv.example.com', user: 'root', pass: 'p:w' }, { request });
  assert.equal(calls[0].url, 'https://srv.example.com:2087/login/?login_only=1');
  assert.match(calls[0].body, /p%3Aw/); // ':' in the password is encoded
  assert.equal(r.port, 2087);
  assert.equal(r.valid, true);
});

test('verifyWhm with no host is unreachable without a request', async () => {
  let called = false;
  const request = async () => ((called = true), {});
  const r = await verifyWhm({ host: '', user: 'root', pass: 'p' }, { request });
  assert.equal(called, false);
  assert.equal(r.status, 'unreachable');
});

test('runWhmChecks returns one result per target and reports progress', async () => {
  const targets = [
    { host: 'a.example.com', user: 'root', pass: '1' },
    { host: 'b.example.com', user: 'root', pass: '2' },
  ];
  const request = async (url) => {
    const ok = url.includes('a.example.com');
    return { statusCode: 200, body: JSON.stringify(ok ? { status: 1, security_token: '/cpsessX/' } : { status: 0 }) };
  };
  const progress = [];
  const results = await runWhmChecks(targets, { request, concurrency: 2 }, (r) => progress.push(r.host));
  assert.equal(results.length, 2);
  assert.equal(progress.length, 2);
  assert.equal(results.find((r) => r.host === 'a.example.com').valid, true);
  assert.equal(results.find((r) => r.host === 'b.example.com').valid, false);
});
