/**
 * Per-key concurrency limiter (a keyed semaphore).
 *
 * Bounds how many tasks run at once FOR EACH KEY, queueing the rest. Used to
 * cap simultaneous IMAP connections to a single seed mailbox: mail providers
 * reject excess connections (Gmail ~15, Outlook ~16) with "too many
 * simultaneous connections", which would otherwise surface as a placement
 * error and misclassify a delivered message. Keying by seed account lets
 * distinct seeds still run in parallel.
 *
 * @param {number} maxPerKey max concurrent tasks per key (>=1)
 */
export function createKeyedLimiter(maxPerKey = 4) {
  const limit = Math.max(1, maxPerKey | 0);
  const state = new Map(); // key -> { active:number, queue: (()=>void)[] }

  function slotFor(key) {
    let s = state.get(key);
    if (!s) { s = { active: 0, queue: [] }; state.set(key, s); }
    return s;
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function run(key, fn) {
    const s = slotFor(key);
    if (s.active >= limit) {
      // Wait for a slot to be HANDED to us (active is not re-incremented on
      // handoff — the releasing task keeps the count constant), which avoids the
      // over-admit race of decrement-then-signal.
      await new Promise((resolve) => s.queue.push(resolve));
    } else {
      s.active += 1;
    }
    try {
      return await fn();
    } finally {
      if (s.queue.length > 0) {
        s.queue.shift()(); // hand our slot to the next waiter; active unchanged
      } else {
        s.active -= 1;
        if (s.active === 0) state.delete(key); // no holders, no waiters -> forget
      }
    }
  }

  return { run };
}
