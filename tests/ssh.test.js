import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySSHResult, verifySSH, runSSHChecks, DEFAULT_SSH_PORT } from '../src/core/ssh.js';

const errWith = (message, extra = {}) => Object.assign(new Error(message), extra);

test('DEFAULT_SSH_PORT is 22', () => {
  assert.equal(DEFAULT_SSH_PORT, 22);
});

test('no error → valid', () => {
  const r = classifySSHResult(null);
  assert.equal(r.reachable, true);
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('"All configured authentication methods failed" → invalid', () => {
  const r = classifySSHResult(errWith('All configured authentication methods failed'));
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('"Permission denied" → invalid', () => {
  const r = classifySSHResult(errWith('Permission denied (password)'));
  assert.equal(r.reachable, true);
  assert.equal(r.status, 'invalid');
});

test('level=client-authentication → invalid', () => {
  const r = classifySSHResult(errWith('whatever', { level: 'client-authentication' }));
  assert.equal(r.status, 'invalid');
});

test('ECONNREFUSED → unreachable', () => {
  const r = classifySSHResult(errWith('connect ECONNREFUSED', { code: 'ECONNREFUSED' }));
  assert.equal(r.reachable, false);
  assert.equal(r.status, 'unreachable');
});

test('ETIMEDOUT → unreachable', () => {
  const r = classifySSHResult(errWith('timed out', { code: 'ETIMEDOUT' }));
  assert.equal(r.status, 'unreachable');
});

test('timeout message → unreachable', () => {
  const r = classifySSHResult(errWith('timeout'));
  assert.equal(r.status, 'unreachable');
});

test('unknown error → unreachable (conservative)', () => {
  const r = classifySSHResult(errWith('something weird'));
  assert.equal(r.status, 'unreachable');
});

test('verifySSH with no host → unreachable without calling connect', async () => {
  let called = false;
  const connect = async () => { called = true; return null; };
  const r = await verifySSH({ host: '', user: 'u', pass: 'p' }, { connect });
  assert.equal(r.status, 'unreachable');
  assert.equal(called, false);
  assert.equal(r.detail, 'no host');
});

test('verifySSH derives username from local part of email', async () => {
  let seen;
  const connect = async (opts) => { seen = opts; return null; };
  await verifySSH({ host: 'h', user: 'alice@example.com', pass: 'p' }, { connect });
  assert.equal(seen.username, 'alice');
});

test('verifySSH respects explicit username override', async () => {
  let seen;
  const connect = async (opts) => { seen = opts; return null; };
  await verifySSH({ host: 'h', user: 'alice@example.com', pass: 'p', username: 'bob' }, { connect });
  assert.equal(seen.username, 'bob');
});

test('verifySSH uses full user when no @ in user', async () => {
  let seen;
  const connect = async (opts) => { seen = opts; return null; };
  await verifySSH({ host: 'h', user: 'root', pass: 'p' }, { connect });
  assert.equal(seen.username, 'root');
});

test('verifySSH passes through proxyUrl to connector', async () => {
  let seen;
  const connect = async (opts) => { seen = opts; return null; };
  await verifySSH({ host: 'h', user: 'u', pass: 'p' }, { connect, proxyUrl: 'socks5://127.0.0.1:1080' });
  assert.equal(seen.proxyUrl, 'socks5://127.0.0.1:1080');
});

test('verifySSH default port is 22', async () => {
  let seen;
  const connect = async (opts) => { seen = opts; return null; };
  await verifySSH({ host: 'h', user: 'u', pass: 'p' }, { connect });
  assert.equal(seen.port, 22);
});

test('runSSHChecks preserves input order', async () => {
  const connect = async (opts) => {
    if (opts.password === 'good') return null;
    return errWith('All configured authentication methods failed', { level: 'client-authentication' });
  };
  const targets = [
    { host: 'a', user: 'u1', pass: 'bad' },
    { host: 'b', user: 'u2', pass: 'good' },
    { host: 'c', user: 'u3', pass: 'bad' },
  ];
  const r = await runSSHChecks(targets, { connect, concurrency: 2 });
  assert.deepEqual(r.map((x) => x.valid), [false, true, false]);
  assert.deepEqual(r.map((x) => x.host), ['a', 'b', 'c']);
});

test('runSSHChecks reports progress via onResult callback', async () => {
  const connect = async () => null;
  const seen = [];
  await runSSHChecks(
    [{ host: 'a', user: 'u', pass: 'p' }, { host: 'b', user: 'u', pass: 'p' }],
    { connect, concurrency: 1 },
    (result, index) => seen.push([index, result.host]),
  );
  assert.deepEqual(seen, [[0, 'a'], [1, 'b']]);
});
