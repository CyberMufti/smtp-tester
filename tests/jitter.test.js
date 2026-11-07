import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep, jitter, rateLimiter, backoff, retry } from '../src/core/jitter.js';

test('sleep resolves after roughly the requested delay', async () => {
  const t0 = Date.now();
  await sleep(30);
  const dt = Date.now() - t0;
  assert.ok(dt >= 25, `expected >=25ms, got ${dt}`);
  assert.ok(dt < 200, `expected <200ms, got ${dt}`);
});

test('jitter(0,0) resolves fast and returns 0', async () => {
  const v = await jitter(0, 0);
  assert.equal(v, 0);
});

test('jitter(min, max) returns value within range', async () => {
  for (let i = 0; i < 5; i++) {
    const v = await jitter(5, 15);
    assert.ok(v >= 5 && v <= 15, `out of range: ${v}`);
  }
});

test('jitter with max < min falls back to min', async () => {
  const v = await jitter(10, 5);
  assert.equal(v, 10);
});

test('rateLimiter with maxPerSec=0 does not throttle', async () => {
  const gate = rateLimiter({ maxPerSec: 0 });
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await gate();
  const dt = Date.now() - t0;
  assert.ok(dt < 100, `expected fast, got ${dt}ms`);
});

test('rateLimiter with maxPerSec=20 spaces calls by ~50ms', async () => {
  const gate = rateLimiter({ maxPerSec: 20 });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await gate();
  const dt = Date.now() - t0;
  // 3 waits of 50ms each = ~150ms minimum. Allow generous slack for CI.
  assert.ok(dt >= 100, `expected >=100ms, got ${dt}`);
  assert.ok(dt < 500, `expected <500ms, got ${dt}`);
});

test('backoff grows exponentially', () => {
  const b0 = backoff(0, { baseMs: 1000 });
  const b1 = backoff(1, { baseMs: 1000 });
  const b2 = backoff(2, { baseMs: 1000 });
  assert.ok(b0 >= 800 && b0 <= 1200);
  assert.ok(b1 >= 1600 && b1 <= 2400);
  assert.ok(b2 >= 3200 && b2 <= 4800);
});

test('backoff respects maxMs cap', () => {
  const v = backoff(20, { baseMs: 1000, maxMs: 5000 });
  assert.ok(v <= 6000, `expected <=6000, got ${v}`);
});

test('retry succeeds on first try without retrying', async () => {
  let calls = 0;
  const result = await retry(async () => { calls++; return 'ok'; }, { attempts: 3 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retry retries until success', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls < 3) throw new Error('transient');
    return 'ok';
  }, { attempts: 5, baseMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retry throws after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error('always'); }, { attempts: 3, baseMs: 5 }),
    /always/,
  );
  assert.equal(calls, 3);
});

test('retry stops early when shouldRetry returns false', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error('fatal'); }, {
      attempts: 5,
      baseMs: 5,
      shouldRetry: () => false,
    }),
  );
  assert.equal(calls, 1);
});

test('retry calls onRetry with attempt info', async () => {
  const events = [];
  await retry(async () => { throw new Error('x'); }, {
    attempts: 3,
    baseMs: 5,
    onRetry: (attempt, err, waitMs) => events.push({ attempt, msg: err.message, waitMs }),
  }).catch(() => {});
  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[1].attempt, 2);
});
