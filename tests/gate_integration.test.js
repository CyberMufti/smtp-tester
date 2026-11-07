import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCpanelChecks } from '../src/core/cpanel.js';
import { runWebmailChecks } from '../src/core/webmail.js';
import { runWhmChecks } from '../src/core/whm.js';
import { runSSHChecks } from '../src/core/ssh.js';

test('cPanel: opts.gate is awaited before every target', async () => {
  let calls = 0;
  const gate = async () => { calls++; };
  const request = async () => ({ statusCode: 200, body: JSON.stringify({ status: 1 }) });
  const targets = [
    { host: 'a', user: 'u', pass: 'p' },
    { host: 'b', user: 'u', pass: 'p' },
    { host: 'c', user: 'u', pass: 'p' },
  ];
  await runCpanelChecks(targets, { request, gate, concurrency: 1 });
  assert.equal(calls, targets.length);
});

test('Webmail: opts.gate is awaited before every target', async () => {
  let calls = 0;
  const gate = async () => { calls++; };
  const request = async () => ({ statusCode: 200, body: '<html>Login failed</html>' });
  const targets = [{ host: 'a', user: 'u', pass: 'p' }, { host: 'b', user: 'u', pass: 'p' }];
  await runWebmailChecks(targets, { request, gate, concurrency: 1 });
  assert.equal(calls, targets.length);
});

test('WHM: opts.gate is awaited before every target', async () => {
  let calls = 0;
  const gate = async () => { calls++; };
  const request = async () => ({ statusCode: 200, body: JSON.stringify({ status: 1 }) });
  const targets = [{ host: 'a', user: 'u', pass: 'p' }, { host: 'b', user: 'u', pass: 'p' }];
  await runWhmChecks(targets, { request, gate, concurrency: 1 });
  assert.equal(calls, targets.length);
});

test('SSH: opts.gate is awaited before every target', async () => {
  let calls = 0;
  const gate = async () => { calls++; };
  const connect = async () => null;
  const targets = [{ host: 'a', user: 'u', pass: 'p' }, { host: 'b', user: 'u', pass: 'p' }];
  await runSSHChecks(targets, { connect, gate, concurrency: 1 });
  assert.equal(calls, targets.length);
});
