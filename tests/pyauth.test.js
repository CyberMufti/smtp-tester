import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidecarAvailable, runAuthSidecar, buildInvocation } from '../src/core/pyauth.js';

test('buildInvocation runs a frozen binary directly', () => {
  const { cmd, argv } = buildInvocation({ binary: '/res/sidecar/authcheck' }, ['--selfcheck']);
  assert.equal(cmd, '/res/sidecar/authcheck');
  assert.deepEqual(argv, ['--selfcheck']);
});

test('buildInvocation runs python with the script prepended when no binary', () => {
  const { cmd, argv } = buildInvocation({ python: '/venv/bin/python3', script: '/app/authcheck.py' }, []);
  assert.equal(cmd, '/venv/bin/python3');
  assert.deepEqual(argv, ['/app/authcheck.py']);
});

test('sidecarAvailable parses a successful selfcheck', async () => {
  const exec = async (args) => {
    assert.deepEqual(args, ['--selfcheck']);
    return { code: 0, stdout: JSON.stringify({ available: true, partial: true, missing: [] }), stderr: '' };
  };
  const r = await sidecarAvailable({ exec });
  assert.equal(r.available, true);
  assert.equal(r.partial, true);
  assert.deepEqual(r.missing, []);
});

test('sidecarAvailable reports unavailable when python cannot run (nonzero exit)', async () => {
  const exec = async () => ({ code: -1, stdout: '', stderr: 'python3: command not found' });
  const r = await sidecarAvailable({ exec });
  assert.equal(r.available, false);
  assert.deepEqual(r.missing, ['python']);
});

test('sidecarAvailable reports a partial install with its missing list', async () => {
  const exec = async () => ({ code: 0, stdout: JSON.stringify({ available: false, partial: true, missing: ['dkimpy'] }), stderr: '' });
  const r = await sidecarAvailable({ exec });
  assert.equal(r.available, false);
  assert.equal(r.partial, true);
  assert.deepEqual(r.missing, ['dkimpy']);
});

test('runAuthSidecar sends the request as JSON on stdin and returns the parsed result', async () => {
  let sentStdin = null;
  const exec = async (args, stdin) => {
    sentStdin = stdin;
    return { code: 0, stdout: JSON.stringify({ ok: true, engine: 'python', spf: { result: 'pass' } }), stderr: '' };
  };
  const res = await runAuthSidecar({ domain: 'example.com', ip: '203.0.113.4' }, { exec });
  assert.deepEqual(JSON.parse(sentStdin), { domain: 'example.com', ip: '203.0.113.4' });
  assert.equal(res.ok, true);
  assert.equal(res.spf.result, 'pass');
});

test('runAuthSidecar surfaces a nonzero exit as an error result', async () => {
  const exec = async () => ({ code: 2, stdout: '', stderr: 'invalid request' });
  const res = await runAuthSidecar({}, { exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid request/);
});

test('runAuthSidecar handles unparseable stdout', async () => {
  const exec = async () => ({ code: 0, stdout: 'not json at all', stderr: '' });
  const res = await runAuthSidecar({ domain: 'x' }, { exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /unparseable/);
});
