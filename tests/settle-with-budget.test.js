import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithBudget } from '../src/core/settle-with-budget.js';

// A controllable fake timer so the budget deadline is deterministic.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    set: (fn, _ms) => { const id = ++seq; pending.set(id, fn); return id; },
    clear: (id) => { pending.delete(id); },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount: () => pending.size,
  };
}

test('returns results in input order when all settle before the budget', async () => {
  const timers = fakeTimers();
  const out = await settleWithBudget(
    [
      { label: 'a', run: () => Promise.resolve('A') },
      { label: 'b', run: () => Promise.resolve('B') },
      { label: 'c', run: () => Promise.resolve('C') },
    ],
    1000,
    { setTimer: timers.set, clearTimer: timers.clear },
  );
  assert.deepEqual(out, ['A', 'B', 'C']);
});

test('clears the deadline timer once everything settles early', async () => {
  const timers = fakeTimers();
  await settleWithBudget(
    [{ label: 'a', run: () => Promise.resolve('A') }],
    1000,
    { setTimer: timers.set, clearTimer: timers.clear },
  );
  assert.equal(timers.pendingCount(), 0, 'no dangling timer after early completion');
});

test('a task that never settles is filled with the timeout marker', async () => {
  const timers = fakeTimers();
  const promise = settleWithBudget(
    [
      { label: 'fast', run: () => Promise.resolve('ok') },
      { label: 'stuck', run: () => new Promise(() => {}) }, // never resolves
    ],
    1000,
    { setTimer: timers.set, clearTimer: timers.clear },
  );
  // Let the fast task's full microtask chain drain (a real macrotask flushes
  // it), then trip the budget deadline on the still-pending task.
  await new Promise((r) => setTimeout(r, 0));
  timers.fire();
  const out = await promise;
  assert.equal(out[0], 'ok');
  assert.deepEqual(out[1], { timeout: true, label: 'stuck' });
});

test('a rejecting task becomes an error marker, not a timeout', async () => {
  const timers = fakeTimers();
  const out = await settleWithBudget(
    [{ label: 'boom', run: () => Promise.reject(new Error('nope')) }],
    1000,
    { setTimer: timers.set, clearTimer: timers.clear },
  );
  assert.equal(out[0].error, 'nope');
  assert.ok(!out[0].timeout, 'a rejection is not reported as a timeout');
});

test('empty task list resolves to an empty array without arming a timer', async () => {
  const timers = fakeTimers();
  const out = await settleWithBudget([], 1000, { setTimer: timers.set, clearTimer: timers.clear });
  assert.deepEqual(out, []);
  assert.equal(timers.pendingCount(), 0);
});
