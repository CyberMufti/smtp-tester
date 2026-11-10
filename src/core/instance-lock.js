/**
 * Allocate a per-instance "slot" so multiple copies of the app don't share one
 * set of data files (run log, proxy pool, settings, result folder). Each slot
 * owns an exclusive lock file; slot 1 keeps the default paths (so existing
 * users are unaffected) and later slots get isolated directories.
 *
 * The lock files auto-outlive a clean exit, so a crashed instance leaves a
 * stale lock — detected by checking whether the recorded pid is still alive and
 * reclaimed if not.
 */

import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Decide which slot this instance should use.
 *
 * @param {{ acquire(slot:number): {ok:true}|{ok:false,pid:number|null},
 *           reclaim(slot:number): void,
 *           isAlive(pid:number): boolean }} store
 * @param {{ maxSlots?: number }} [opts]
 * @returns {number} the acquired slot (1-based)
 */
export function pickInstanceSlot(store, { maxSlots = 16 } = {}) {
  for (let slot = 1; slot <= maxSlots; slot++) {
    const first = store.acquire(slot);
    if (first.ok) return slot;
    // Occupied. If the holder is gone (crash) or unidentifiable, reclaim it.
    const holderAlive = first.pid != null && store.isAlive(first.pid);
    if (!holderAlive) {
      store.reclaim(slot);
      const second = store.acquire(slot);
      if (second.ok) return slot;
    }
    // A live holder — try the next slot.
  }
  throw new Error(`no free instance slot within ${maxSlots} slots`);
}

/** True if a process with `pid` is currently running (cross-platform). */
export function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: exists but we can't signal it → alive.
    return err.code === 'EPERM';
  }
}

/**
 * A lock store backed by real lock files under `lockDir`. Keeps the fd of any
 * acquired lock in `heldFds` so the handle lives for the process lifetime (the
 * OS releases it on exit, even on crash).
 *
 * @param {string} lockDir directory to hold `instance-N.lock` files
 * @param {number} pid this process's pid
 */
export function createFileLockStore(lockDir, pid = process.pid) {
  mkdirSync(lockDir, { recursive: true });
  const heldFds = [];
  const lockPath = (slot) => join(lockDir, `instance-${slot}.lock`);
  return {
    heldFds,
    acquire(slot) {
      try {
        // 'wx' creates exclusively and fails with EEXIST if it already exists —
        // an atomic test-and-set that settles races between simultaneous starts.
        const fd = openSync(lockPath(slot), 'wx');
        writeFileSync(fd, String(pid));
        heldFds.push(fd); // intentionally never closed; freed by the OS on exit
        return { ok: true };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let holder = null;
        try { holder = parseInt(readFileSync(lockPath(slot), 'utf8').trim(), 10) || null; } catch { holder = null; }
        return { ok: false, pid: holder };
      }
    },
    reclaim(slot) {
      try { unlinkSync(lockPath(slot)); } catch { /* already gone */ }
    },
    isAlive: pidAlive,
  };
}

// Re-exported so the main process can release handles on a clean quit if it wants.
export function releaseFds(fds) {
  for (const fd of fds) { try { closeSync(fd); } catch { /* noop */ } }
}
