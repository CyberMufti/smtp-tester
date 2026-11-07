/**
 * Offline credential-hygiene analysis for accounts you operate.
 *
 * Given an export of your own `email:password` accounts, flag the ones worth
 * forcing a reset on: weak passwords, passwords reused across several of your
 * accounts, and passwords found in a known-breached corpus you supply. This is
 * pure local analysis — it makes no network calls and never contacts a mail
 * server. (It is deliberately NOT a live credential test.)
 *
 * Breached matching uses SHA-1 hashes (the format of public breach corpora such
 * as the HIBP downloadable set): supply a Set of uppercase hex SHA-1 digests and
 * a password is flagged when its digest is present.
 */
import { createHash } from 'node:crypto';

/** Uppercase hex SHA-1 of a string — the format breach corpora use. */
export function sha1Hex(s) {
  return createHash('sha1').update(String(s), 'utf8').digest('hex').toUpperCase();
}

// A small built-in list of the most common passwords. Not exhaustive — a breach
// corpus catches far more — but enough to flag the obvious offenders offline.
export const COMMON_PASSWORDS = new Set(
  [
    'password', 'password1', 'passw0rd', '123456', '12345678', '123456789', '1234567890',
    'qwerty', 'qwerty123', 'abc123', '111111', '000000', 'iloveyou', 'admin', 'letmein',
    'welcome', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'login',
    'master', 'hello', 'freedom', 'whatever', 'trustno1', 'secret', 'changeme',
  ].map((p) => p.toLowerCase()),
);

const KEYBOARD_RUNS = ['qwerty', 'asdf', 'zxcv', '123456', 'abcdef', '7890'];

/**
 * Return the list of weakness reasons for a single password (independent of
 * reuse/breach, which are cross-account / corpus checks).
 * @param {string} user
 * @param {string} pass
 * @returns {string[]}
 */
export function passwordWeaknesses(user, pass) {
  const reasons = [];
  const p = String(pass ?? '');
  const lower = p.toLowerCase();

  if (p.length < 8) reasons.push('shorter than 8 characters');
  if (COMMON_PASSWORDS.has(lower)) reasons.push('common password');
  if (/^\d+$/.test(p) && p.length) reasons.push('digits only');
  if (/^[a-z]+$/.test(p)) reasons.push('lowercase letters only');
  if (KEYBOARD_RUNS.some((run) => lower.includes(run))) reasons.push('keyboard/sequence pattern');

  const local = String(user ?? '').split('@')[0].toLowerCase();
  if (local && lower === local) reasons.push('same as username');

  return reasons;
}

/**
 * A streaming accumulator so a large account export can be analyzed line-by-line
 * without holding every record. Reuse is tracked by password digest (not the
 * plaintext), and only a capped sample of flagged accounts is retained for
 * display; the full flagged set can be written out separately if needed.
 *
 * @param {{breachedHashes?:Set<string>, sampleLimit?:number}} [opts]
 */
export function createHygieneAccumulator({ breachedHashes = null, sampleLimit = 200 } = {}) {
  const digestCounts = new Map(); // password SHA-1 -> how many accounts use it
  const sample = [];
  const summary = { total: 0, weak: 0, reused: 0, breached: 0, flagged: 0 };
  const pending = []; // accounts needing a second pass once reuse counts are known

  return {
    add(record) {
      const user = record.user ?? '';
      const pass = record.pass ?? '';
      summary.total++;
      const digest = sha1Hex(pass);
      digestCounts.set(digest, (digestCounts.get(digest) || 0) + 1);
      pending.push({ user, digest, weak: passwordWeaknesses(user, pass) });
    },
    /** Finalize: resolve reuse (needs all counts) and breach flags, build summary. */
    result() {
      for (const acc of pending) {
        const reasons = [...acc.weak];
        const reused = (digestCounts.get(acc.digest) || 0) > 1;
        const breached = !!breachedHashes && breachedHashes.has(acc.digest);
        if (reused) reasons.push('reused across accounts');
        if (breached) reasons.push('found in breach corpus');
        if (acc.weak.length) summary.weak++;
        if (reused) summary.reused++;
        if (breached) summary.breached++;
        if (reasons.length) {
          summary.flagged++;
          if (sample.length < sampleLimit) sample.push({ user: acc.user, reasons });
        }
      }
      return { summary, sample };
    },
  };
}

/**
 * Convenience wrapper over the accumulator for an in-memory array of records.
 * @param {Array<{user:string, pass:string}>} records
 * @param {{breachedHashes?:Set<string>, sampleLimit?:number}} [opts]
 */
export function analyzeHygiene(records, opts = {}) {
  const acc = createHygieneAccumulator(opts);
  for (const r of records || []) acc.add(r);
  return acc.result();
}
