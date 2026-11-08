/**
 * Per-(email, protocol) failure tracking to prevent account lockouts.
 *
 * Real servers lock accounts after N failed attempts (3-10 typically). Without
 * this registry, running 50 passwords for one email in parallel guarantees
 * lockout — the good password never gets tested because the account is already
 * frozen by the time it's reached.
 *
 * In-memory per session. Restart = fresh state (that's intentional).
 *
 * @typedef {{failures:number, lockedUntil:number|null, lastAttempt:number, reason:string}} Entry
 */

export const LOCKOUT_PATTERNS = [
  /too many (failed )?attempts?/i,
  /too many (failed )?logins?/i,
  /account (is )?locked/i,
  /account (is )?temporarily (blocked|locked)/i,
  /temporarily blocked/i,
  /rate limit/i,
  /try again (later|in \d+)/i,
  /please wait \d+ (minute|second)/i,
  /(exceeded|max(imum)?) (the )?login attempts?/i,
  /captcha/i,
  /brute.?force protection/i,
  /cphulk/i,
  /ip (address )?(is )?blocked/i,
  /authentication (failures|denied).{0,30}(too many|exceeded)/i,
  /(too many|exceeded).{0,40}authentication/i,
];

/** Return the matched lockout phrase, or null. */
export function detectLockout(text) {
  if (!text) return null;
  const s = String(text);
  for (const re of LOCKOUT_PATTERNS) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

export class LockoutRegistry {
  constructor(opts = {}) {
    this.maxFailures = opts.maxFailures ?? 3;
    this.lockoutMs = opts.lockoutMs ?? 60000;
    this.hardLockFailures = opts.hardLockFailures ?? 10;
    this.entries = new Map();
  }

  _key(email, protocol) {
    return protocol + ':' + String(email || '').toLowerCase();
  }

  isLocked(email, protocol, now = Date.now()) {
    const e = this.entries.get(this._key(email, protocol));
    if (!e) return false;
    if (e.lockedUntil === null) return false;
    if (e.lockedUntil === Infinity) return true;
    if (now < e.lockedUntil) return true;
    // Cooldown expired — reset for a fresh try.
    e.lockedUntil = null;
    e.failures = 0;
    return false;
  }

  recordFailure(email, protocol, now = Date.now()) {
    const k = this._key(email, protocol);
    const e = this.entries.get(k) || { failures: 0, lockedUntil: null, lastAttempt: now, reason: '' };
    e.failures += 1;
    e.lastAttempt = now;
    if (e.failures >= this.hardLockFailures) {
      e.lockedUntil = Infinity;
      e.reason = 'hard lockout (' + e.failures + ' failures)';
    } else if (e.failures >= this.maxFailures) {
      e.lockedUntil = now + this.lockoutMs;
      e.reason = 'cooldown after ' + e.failures + ' failures';
    }
    this.entries.set(k, e);
    return e;
  }

  recordSuccess(email, protocol) {
    this.entries.delete(this._key(email, protocol));
  }

  markLocked(email, protocol, reason, ttlMs) {
    const k = this._key(email, protocol);
    const now = Date.now();
    const e = this.entries.get(k) || { failures: 0, lockedUntil: null, lastAttempt: now, reason: '' };
    e.lockedUntil = ttlMs === Infinity ? Infinity : now + (ttlMs || this.lockoutMs);
    e.lastAttempt = now;
    e.reason = reason || 'server lockout signal';
    this.entries.set(k, e);
    return e;
  }

  /** Return the current entry (or null) — for reading .reason when displaying skips. */
  get(email, protocol) {
    return this.entries.get(this._key(email, protocol)) || null;
  }

  stats() {
    let cooldown = 0, hard = 0;
    const now = Date.now();
    for (const e of this.entries.values()) {
      if (e.lockedUntil === Infinity) hard++;
      else if (e.lockedUntil && e.lockedUntil > now) cooldown++;
    }
    return { tracked: this.entries.size, cooldown, hard };
  }

  clear() { this.entries.clear(); }
}
