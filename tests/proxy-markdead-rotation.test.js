import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool } from '../src/core/proxy_pool.js';

// Build a pool with known SOCKS5 proxies a..e on distinct ports.
function poolOf(ports) {
  const p = new ProxyPool();
  p.valid = ports.map((port) => ({ host: '127.0.0.1', port, type: 5 }));
  p.index = 0;
  return p;
}
const portOf = (url) => Number(url.split(':').pop());

test('removing a proxy BEFORE the rotation cursor does not skip the next live proxy', () => {
  const p = poolOf([1, 2, 3, 4, 5]); // A..E
  // Advance the cursor to point at D (index 3): consume A, B, C.
  p.getNext(); p.getNext(); p.getNext();
  assert.equal(p.index, 3);
  // Kill B (which sits before the cursor).
  p.markDead('socks5://127.0.0.1:2');
  // The very next proxy must still be D — not skipped to E.
  assert.equal(portOf(p.getNext()), 4, 'D must not be skipped when an earlier proxy dies');
});

test('removing the proxy the cursor points at advances to the following live proxy', () => {
  const p = poolOf([1, 2, 3, 4, 5]);
  p.getNext(); p.getNext(); p.getNext(); // cursor at D (index 3)
  p.markDead('socks5://127.0.0.1:4'); // kill D itself
  assert.equal(portOf(p.getNext()), 5, 'with D gone, E is next');
});

test('markDead is idempotent and returns removed count', () => {
  const p = poolOf([1, 2, 3]);
  assert.equal(p.markDead('socks5://127.0.0.1:2'), 1);
  assert.equal(p.markDead('socks5://127.0.0.1:2'), 0);
});
