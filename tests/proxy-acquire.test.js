import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool } from '../src/core/proxy_pool.js';

function pool(hosts) {
  const p = new ProxyPool();
  p.valid = hosts.map((h) => ({ type: 5, host: h, port: 1080 }));
  p.index = 0;
  return p;
}

test('acquireLive validates a stale proxy and returns it when live', async () => {
  const p = pool(['1.1.1.1']);
  let calls = 0;
  const url = await p.acquireLive({ ttlMs: 15000, now: () => 1000, checkFn: async () => { calls++; return true; } });
  assert.equal(url, 'socks5://1.1.1.1:1080');
  assert.equal(calls, 1);
});

test('acquireLive discards a dead proxy and returns the next live one (dead removed)', async () => {
  const p = pool(['dead', 'live']);
  const url = await p.acquireLive({ ttlMs: 15000, now: () => 1000, checkFn: async (u) => !u.includes('dead') });
  assert.equal(url, 'socks5://live:1080');
  assert.equal(p.size().valid, 1);
  assert.ok(!p.valid.some((e) => e.host === 'dead'), 'dead proxy discarded from the pool');
});

test('a freshly-checked proxy is reused within the TTL without re-validating', async () => {
  const p = pool(['1.1.1.1']);
  let calls = 0, t = 1000;
  const checkFn = async () => { calls++; return true; };
  await p.acquireLive({ ttlMs: 15000, now: () => t, checkFn });   // validate once, stamp @1000
  t = 5000;                                                        // 4s later, within TTL
  const url = await p.acquireLive({ ttlMs: 15000, now: () => t, checkFn });
  assert.equal(url, 'socks5://1.1.1.1:1080');
  assert.equal(calls, 1, 'not re-validated within the TTL');
});

test('a proxy past the TTL is re-validated before use', async () => {
  const p = pool(['1.1.1.1']);
  let calls = 0, t = 1000;
  const checkFn = async () => { calls++; return true; };
  await p.acquireLive({ ttlMs: 15000, now: () => t, checkFn });   // calls=1 @1000
  t = 20000;                                                       // 19s later, past TTL
  await p.acquireLive({ ttlMs: 15000, now: () => t, checkFn });   // calls=2
  assert.equal(calls, 2);
});

test('all-dead pool: acquireLive returns null and empties the pool', async () => {
  const p = pool(['a', 'b', 'c']);
  const url = await p.acquireLive({ ttlMs: 15000, now: () => 1000, checkFn: async () => false });
  assert.equal(url, null);
  assert.equal(p.size().valid, 0);
});

test('empty pool: acquireLive returns null without checking', async () => {
  const p = pool([]);
  let calls = 0;
  const url = await p.acquireLive({ checkFn: async () => { calls++; return true; } });
  assert.equal(url, null);
  assert.equal(calls, 0);
});
