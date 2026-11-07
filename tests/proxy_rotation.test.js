import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool, proxyEntryToUrl } from '../src/core/proxy_pool.js';
import { runBatch } from '../src/core/tester.js';
import { runSSHChecks } from '../src/core/ssh.js';

test('ProxyPool.markDead removes matching proxy', () => {
  const pool = new ProxyPool();
  pool.valid = [
    { host: '1.1.1.1', port: 1080, type: 5 },
    { host: '2.2.2.2', port: 1080, type: 5 },
    { host: '3.3.3.3', port: 1080, type: 5 },
  ];
  const removed = pool.markDead(proxyEntryToUrl(pool.valid[1]));
  assert.equal(removed, 1);
  assert.equal(pool.valid.length, 2);
});

test('ProxyPool.markDead on unknown url returns 0', () => {
  const pool = new ProxyPool();
  pool.valid = [{ host: '1.1.1.1', port: 1080, type: 5 }];
  assert.equal(pool.markDead('socks5://9.9.9.9:1080'), 0);
  assert.equal(pool.valid.length, 1);
});

test('runBatch: proxyProvider called once per credential', async () => {
  const used = []; let counter = 0;
  const mockSmtp = {
    verify: async (_c, o) => { used.push(o.proxy); return { connected: true, authenticated: true }; },
    send: async () => ({ accepted: [], messageId: 'x' }),
  };
  await runBatch(
    [{ user: 'a@t.com', pass: 'p', host: 'h', port: 587 },
     { user: 'b@t.com', pass: 'p', host: 'h', port: 587 },
     { user: 'c@t.com', pass: 'p', host: 'h', port: 587 }],
    [],
    { concurrency: 1, proxyProvider: () => `socks5://p${counter++}`, deps: { smtp: mockSmtp } },
  );
  assert.deepEqual(used, ['socks5://p0', 'socks5://p1', 'socks5://p2']);
});

test('runBatch: dead proxy retries direct, marks proxyFallback', async () => {
  const proxiedCalls = [];
  const directCalls = [];
  const mockSmtp = {
    verify: async (_c, o) => {
      if (o.proxy) {
        proxiedCalls.push(o.proxy);
        return { connected: false, authenticated: false, error: 'connect ETIMEDOUT' };
      }
      directCalls.push('direct');
      return { connected: true, authenticated: true };
    },
    send: async () => ({ accepted: [], messageId: 'x' }),
  };
  const failures = [];
  const results = await runBatch(
    [{ user: 'a@t.com', pass: 'p', host: 'h', port: 587 }],
    [],
    { concurrency: 1, proxyProvider: () => 'socks5://dead:1080',
      onProxyFailure: (p) => failures.push(p), deps: { smtp: mockSmtp } },
  );
  assert.ok(proxiedCalls.length >= 1, 'at least one proxied attempt');
  assert.ok(directCalls.length >= 1, 'at least one direct attempt');
  assert.ok(proxiedCalls.every((p) => p === 'socks5://dead:1080'), 'all proxied attempts used the dead proxy');
  assert.equal(results[0].proxyFallback, true);
  assert.equal(results[0].proxyThatDied, 'socks5://dead:1080');
  assert.deepEqual(failures, ['socks5://dead:1080']);
});

test('runBatch: no proxyProvider uses opts.proxy unchanged', async () => {
  const used = [];
  const mockSmtp = {
    verify: async (_c, o) => { used.push(o.proxy); return { connected: true, authenticated: true }; },
    send: async () => ({ accepted: [], messageId: 'x' }),
  };
  const results = await runBatch(
    [{ user: 'a@t.com', pass: 'p', host: 'h', port: 587 }], [],
    { concurrency: 1, proxy: 'socks5://manual:1080', deps: { smtp: mockSmtp } },
  );
  assert.deepEqual(used, ['socks5://manual:1080']);
  assert.equal(results[0].proxyFallback, undefined);
});

test('runSSHChecks: proxyProvider called once per target', async () => {
  const used = []; let counter = 0;
  const connect = async (o) => { used.push(o.proxyUrl); return null; };
  await runSSHChecks(
    [{ host: 'a', user: 'u', pass: 'p' }, { host: 'b', user: 'u', pass: 'p' }],
    { concurrency: 1, connect, proxyProvider: () => `socks5://sp${counter++}` },
  );
  assert.deepEqual(used, ['socks5://sp0', 'socks5://sp1']);
});

test('runSSHChecks: dead proxy retries direct, marks proxyFallback', async () => {
  let calls = 0;
  const connect = async (o) => {
    calls++;
    if (o.proxyUrl) {
      const err = new Error('connect ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      return err;
    }
    return null;
  };
  const failures = [];
  const results = await runSSHChecks(
    [{ host: 'a', user: 'u', pass: 'p' }],
    { concurrency: 1, connect, proxyProvider: () => 'socks5://dead:1080',
      onProxyFailure: (p) => failures.push(p) },
  );
  assert.equal(calls, 2);
  assert.equal(results[0].proxyFallback, true);
  assert.equal(results[0].proxyThatDied, 'socks5://dead:1080');
  assert.deepEqual(failures, ['socks5://dead:1080']);
});

test('runSSHChecks: no proxyProvider uses opts.proxyUrl unchanged', async () => {
  const used = [];
  const connect = async (o) => { used.push(o.proxyUrl); return null; };
  const results = await runSSHChecks(
    [{ host: 'a', user: 'u', pass: 'p' }],
    { concurrency: 1, connect, proxyUrl: 'socks5://manual:1080' },
  );
  assert.deepEqual(used, ['socks5://manual:1080']);
  assert.equal(results[0].proxyFallback, undefined);
});
