import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressBatcher } from '../src/core/progress-batcher.js';

// A controllable fake timer so time-based flushing is deterministic.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    set: (fn, _ms) => { const id = ++seq; pending.set(id, fn); return id; },
    clear: (id) => { pending.delete(id); },
    // Fire every scheduled-but-not-cleared callback, as the event loop would.
    tick() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount: () => pending.size,
  };
}

test('buffers items below the batch size without flushing', () => {
  const flushes = [];
  const timers = fakeTimers();
  const b = createProgressBatcher({
    maxBatch: 3,
    flush: (batch) => flushes.push(batch),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  b.push('a');
  b.push('b');

  assert.equal(flushes.length, 0, 'should not flush before reaching maxBatch');
  assert.equal(b.size(), 2);
});

test('flushes automatically once the batch size is reached', () => {
  const flushes = [];
  const timers = fakeTimers();
  const b = createProgressBatcher({
    maxBatch: 3,
    flush: (batch) => flushes.push(batch),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  b.push('a');
  b.push('b');
  b.push('c');

  assert.equal(flushes.length, 1, 'reaching maxBatch flushes exactly once');
  assert.deepEqual(flushes[0], ['a', 'b', 'c']);
  assert.equal(b.size(), 0, 'buffer is empty after a size flush');
});

test('a time tick flushes a partial batch', () => {
  const flushes = [];
  const timers = fakeTimers();
  const b = createProgressBatcher({
    maxBatch: 100,
    flush: (batch) => flushes.push(batch),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  b.push('a');
  b.push('b');
  assert.equal(flushes.length, 0);

  timers.tick();

  assert.deepEqual(flushes, [['a', 'b']], 'the pending timer flushes buffered items');
});

test('close() flushes whatever remains', () => {
  const flushes = [];
  const timers = fakeTimers();
  const b = createProgressBatcher({
    maxBatch: 100,
    flush: (batch) => flushes.push(batch),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  b.push('a');
  b.close();

  assert.deepEqual(flushes, [['a']]);
});

test('never fires an empty flush', () => {
  const flushes = [];
  const timers = fakeTimers();
  const b = createProgressBatcher({
    maxBatch: 3,
    flush: (batch) => flushes.push(batch),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  b.close();      // nothing buffered
  timers.tick();  // no timer should be pending

  assert.equal(flushes.length, 0);
});

test('a size flush clears the pending timer so the next batch starts fresh', () => {
  const flushes = [];
  const timers = fakeTimers();
  const b = createProgressBatcher({
    maxBatch: 2,
    flush: (batch) => flushes.push(batch),
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  b.push('a');                       // arms a timer
  b.push('b');                       // hits maxBatch -> size flush, should cancel timer
  assert.equal(timers.pendingCount(), 0, 'size flush cancels the armed timer');

  timers.tick();                     // stale timer must not double-flush
  assert.equal(flushes.length, 1, 'no phantom flush from a cancelled timer');

  b.push('c');                       // starts a brand-new batch + timer
  timers.tick();
  assert.deepEqual(flushes[1], ['c']);
});
