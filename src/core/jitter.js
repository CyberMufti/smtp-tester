/**
 * Rate-limit, jitter, and backoff helpers for credential testing.
 *
 * These are pure timing utilities with no dependencies — safe to import
 * anywhere. Use them to:
 *   - add randomized delay between attempts (avoid fixed-interval detection)
 *   - enforce a max attempts-per-second rate
 *   - back off exponentially when a server pushes back (421/450/451)
 *   - retry transient failures with escalating waits
 *
 *   import { sleep, jitter, rateLimiter, backoff, retry } from './jitter.js';
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve after a random delay between minMs and maxMs (inclusive).
 * If maxMs <= minMs, uses minMs.
 */
export async function jitter(minMs = 500, maxMs = 2000) {
  const lo = Math.max(0, minMs);
  const hi = Math.max(lo, maxMs);
  const delay = lo + Math.floor(Math.random() * (hi - lo + 1));
  await sleep(delay);
  return delay;
}

/**
 * Enforce a minimum spacing between successive calls.
 * Example: rateLimiter({ maxPerSec: 2 }) → at most 2 calls per second.
 *
 * @param {{ maxPerSec: number }} opts
 * @returns {() => Promise<void>} an async gate — await it before each attempt
 */
export function rateLimiter({ maxPerSec }) {
  const intervalMs = maxPerSec > 0 ? Math.floor(1000 / maxPerSec) : 0;
  let nextAvailable = 0;
  return async function gate() {
    if (intervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAvailable - now);
    nextAvailable = Math.max(now, nextAvailable) + intervalMs;
    if (wait > 0) await sleep(wait);
  };
}

/**
 * Exponential backoff delay for the Nth retry (attempt index starting at 0).
 * Caps at maxMs. Adds ±20% jitter to avoid thundering herd.
 *
 * backoff(0, { baseMs: 1000 }) → ~1000ms
 * backoff(1, { baseMs: 1000 }) → ~2000ms
 * backoff(2, { baseMs: 1000 }) → ~4000ms
 * backoff(10, { baseMs: 1000, maxMs: 30000 }) → ~30000ms
 *
 * @param {number} attempt
 * @param {{ baseMs?: number, maxMs?: number }} [opts]
 * @returns {number} milliseconds to wait (does NOT sleep)
 */
export function backoff(attempt, opts = {}) {
  const base = opts.baseMs ?? 1000;
  const cap = opts.maxMs ?? 60000;
  const raw = base * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(cap, raw);
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.floor(capped * jitterFactor);
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param {() => Promise<any>} fn
 * @param {{
 *   attempts?: number,
 *   baseMs?: number,
 *   maxMs?: number,
 *   shouldRetry?: (err: any) => boolean,
 *   onRetry?: (attempt: number, err: any, waitMs: number) => void,
 * }} [opts]
 * @returns {Promise<any>} the first successful result, or throws the last error
 */
export async function retry(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      if (!shouldRetry(err)) break;
      const waitMs = backoff(i, { baseMs: opts.baseMs, maxMs: opts.maxMs });
      try { opts.onRetry?.(i + 1, err, waitMs); } catch { /* ignore */ }
      await sleep(waitMs);
    }
  }
  throw lastErr;
}
