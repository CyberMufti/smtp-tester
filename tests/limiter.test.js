import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedLimiter } from '../src/core/limiter.js';

// A deferred promise whose resolution we control, to pin down ordering.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('runs a task under the limit and returns its value', async () => {
  const limiter = createKeyedLimiter(2);
  const out = await limiter.run('seed', () => Promise.resolve(42));
  assert.equal(out, 42);
});

test('never exceeds maxPerKey concurrent tasks for one key', async () => {
  const limiter = createKeyedLimiter(2);
  let active = 0;
  let peak = 0;
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const task = (i) => limiter.run('seed', async () => {
    active++; peak = Math.max(peak, active);
    await gates[i].promise;
    active--;
  });
  const runs = gates.map((_, i) => task(i));
  // Let the limiter admit as many as it will, then release them one at a time.
  await Promise.resolve();
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded limit 2`);
  gates.forEach((g) => g.resolve());
  await Promise.all(runs);
  assert.equal(peak, 2, 'should actually reach the limit, not under-run it');
});

test('different keys do not block each other', async () => {
  const limiter = createKeyedLimiter(1);
  const gateA = deferred();
  let bRan = false;
  const a = limiter.run('A', async () => { await gateA.promise; });
  const b = limiter.run('B', async () => { bRan = true; });
  await b; // B must complete even though A (different key) is still holding its slot
  assert.equal(bRan, true);
  gateA.resolve();
  await a;
});

test('queues tasks beyond the limit and runs them as slots free', async () => {
  const limiter = createKeyedLimiter(1);
  const order = [];
  const g1 = deferred();
  const r1 = limiter.run('k', async () => { order.push('start1'); await g1.promise; order.push('end1'); });
  const r2 = limiter.run('k', async () => { order.push('start2'); });
  await Promise.resolve();
  assert.deepEqual(order, ['start1'], 'second task must wait for the slot');
  g1.resolve();
  await Promise.all([r1, r2]);
  assert.deepEqual(order, ['start1', 'end1', 'start2']);
});

test('a throwing task releases its slot for the next waiter', async () => {
  const limiter = createKeyedLimiter(1);
  await assert.rejects(limiter.run('k', () => Promise.reject(new Error('boom'))), /boom/);
  // The slot must be freed despite the rejection.
  const out = await limiter.run('k', () => Promise.resolve('ok'));
  assert.equal(out, 'ok');
});
