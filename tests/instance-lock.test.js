import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInstanceSlot } from '../src/core/instance-lock.js';

// A fake lock store: `locks` maps slot -> holder pid (a lock file on disk);
// `live` is the set of pids whose process is still running; `me` is our pid.
function fakeStore({ locks = new Map(), live = new Set(), me = 999 } = {}) {
  return {
    acquired: null,
    acquire(slot) {
      if (locks.has(slot)) return { ok: false, pid: locks.get(slot) };
      locks.set(slot, me);
      this.acquired = slot;
      return { ok: true };
    },
    reclaim(slot) { locks.delete(slot); },
    isAlive(pid) { return live.has(pid); },
    _locks: locks,
  };
}

test('first instance takes slot 1', () => {
  const store = fakeStore();
  assert.equal(pickInstanceSlot(store), 1);
  assert.equal(store.acquired, 1);
});

test('a second instance skips a live slot 1 and takes slot 2', () => {
  const store = fakeStore({ locks: new Map([[1, 100]]), live: new Set([100]) });
  assert.equal(pickInstanceSlot(store), 2);
});

test('a third instance skips two live slots and takes slot 3', () => {
  const store = fakeStore({ locks: new Map([[1, 100], [2, 101]]), live: new Set([100, 101]) });
  assert.equal(pickInstanceSlot(store), 3);
});

test('a stale lock from a crashed instance (dead pid) is reclaimed', () => {
  const store = fakeStore({ locks: new Map([[1, 100]]), live: new Set() /* 100 is dead */ });
  assert.equal(pickInstanceSlot(store), 1, 'dead holder should be reclaimed, not skipped');
});

test('an unreadable lock (no recorded pid) is treated as a LIVE holder, not reclaimed', () => {
  // A lock file that exists but has no readable pid may be a sibling instance
  // mid-initialization (it created the file but has not yet written its pid).
  // Reclaiming it would let two instances share one slot, so we conservatively
  // skip to the next slot instead.
  const store = fakeStore({ locks: new Map([[1, null]]), live: new Set() });
  assert.equal(pickInstanceSlot(store), 2);
});

test('throws when every slot is held by a live instance', () => {
  const locks = new Map();
  const live = new Set();
  for (let s = 1; s <= 4; s++) { locks.set(s, 200 + s); live.add(200 + s); }
  const store = fakeStore({ locks, live });
  assert.throws(() => pickInstanceSlot(store, { maxSlots: 4 }), /no free instance slot/);
});
