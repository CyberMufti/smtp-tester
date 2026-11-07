import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWebmailLogin, verifyWebmail, runWebmailChecks } from '../src/core/webmail.js';

test('a redirect to _task=mail is a valid login', () => {
  const r = classifyWebmailLogin({ statusCode: 302, headers: { location: '/?_task=mail' }, body: '' });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('a redirect to _task=show is a valid login', () => {
  const r = classifyWebmailLogin({ statusCode: 302, headers: { location: '/?_task=show&_uid=1' }, body: '' });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('a 302 to a non-login page is valid', () => {
  const r = classifyWebmailLogin({ statusCode: 302, headers: { location: '/inbox' }, body: '' });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('a redirect back to login is invalid', () => {
  const r = classifyWebmailLogin({ statusCode: 302, headers: { location: '/?_task=login&_err=1' }, body: '' });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('"Login failed" body is invalid', () => {
  const r = classifyWebmailLogin({ statusCode: 200, body: '<html>Login failed</html>', headers: {} });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('"Invalid request" body is invalid', () => {
  const r = classifyWebmailLogin({ statusCode: 200, body: 'Invalid request' });
  assert.equal(r.status, 'invalid');
});

test('"User not found" body is invalid', () => {
  const r = classifyWebmailLogin({ statusCode: 200, body: '<div>User not found</div>' });
  assert.equal(r.status, 'invalid');
});

test('a Roundcube login page we cannot parse is unknown', () => {
  const r = classifyWebmailLogin({ statusCode: 200, body: '<html><title>Roundcube</title></html>' });
  assert.equal(r.reachable, true);
  assert.equal(r.status, 'unknown');
});

test('a non-webmail response is not-webmail', () => {
  const r = classifyWebmailLogin({ statusCode: 200, body: '<html>Apache default</html>' });
  assert.equal(r.status, 'not-webmail');
});

test('a network error is unreachable', () => {
  const r = classifyWebmailLogin({ error: 'ECONNREFUSED' });
  assert.equal(r.reachable, false);
  assert.equal(r.status, 'unreachable');
});

test('verifyWebmail uses https://host/webmail by default', async () => {
  let seenUrl = '';
  await verifyWebmail({ host: 'mail.test', user: 'u@test', pass: 'p' }, {
    request: async (url) => { seenUrl = url; return { statusCode: 200, body: '<html>Login failed</html>' }; },
  });
  assert.equal(seenUrl, 'https://mail.test/webmail');
});

test('verifyWebmail posts form-encoded _user/_pass/_task', async () => {
  let seenBody = '';
  await verifyWebmail({ host: 'mail.test', user: 'u@test', pass: 'p@ss word' }, {
    request: async (_url, { body }) => { seenBody = body; return { statusCode: 200, body: '<html>Login failed</html>' }; },
  });
  assert.match(seenBody, /_user=u%40test/);
  assert.match(seenBody, /_pass=p%40ss%20word/);
  assert.match(seenBody, /_task=login/);
});

test('runWebmailChecks preserves input order', async () => {
  const request = async (_url, { body }) => {
    const ok = body.includes('_pass=good');
    return { statusCode: 302, headers: { location: ok ? '/?_task=mail' : '/?_task=login' }, body: '' };
  };
  const targets = [
    { host: 'a', user: 'u', pass: 'bad' },
    { host: 'b', user: 'u', pass: 'good' },
    { host: 'c', user: 'u', pass: 'bad' },
  ];
  const r = await runWebmailChecks(targets, { request, concurrency: 2 });
  assert.deepEqual(r.map((x) => x.valid), [false, true, false]);
  assert.deepEqual(r.map((x) => x.host), ['a', 'b', 'c']);
});
