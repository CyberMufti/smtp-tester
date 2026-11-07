import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, looksRateLimited } from '../src/core/tester.js';

function makeCreds(n) {
  return Array.from({ length: n }, (_, i) => ({ host: `h${i}.com`, port: 587, user: `u${i}`, pass: `p${i}` }));
}

// Fast, always-succeeding deps so timing reflects the rate gate, not the work.
function fastDeps() {
  return {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
}

test('maxPerSec spaces test starts (cooperative throttle)', async () => {
  const deps = fastDeps();
  const start = Date.now();
  // 5 tests at 20/sec => ~50ms between starts => >= ~200ms for the 5th start.
  await runBatch(makeCreds(5), [], { concurrency: 5, deps, maxPerSec: 20 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 160, `expected throttled run >=160ms, got ${elapsed}ms`);
});

test('no throttle (maxPerSec unset) runs without added spacing', async () => {
  const deps = fastDeps();
  const start = Date.now();
  await runBatch(makeCreds(5), [], { concurrency: 5, deps });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 150, `expected fast run, got ${elapsed}ms`);
});

test('looksRateLimited recognizes 421 and 4xx too-many / throttle responses', () => {
  assert.equal(looksRateLimited({ reason: '421 Too many connections, slow down' }), true);
  assert.equal(looksRateLimited({ reason: '', attempts: [{ outcome: '450 4.7.1 rate limited' }] }), true);
  assert.equal(looksRateLimited({ reason: 'greylisted, try again later' }), true);
  assert.equal(looksRateLimited({ reason: '535 authentication failed' }), false);
  assert.equal(looksRateLimited({ reason: 'ECONNREFUSED' }), false);
  assert.equal(looksRateLimited(null), false);
});

test('a rate-limit response triggers a cooldown that delays subsequent tests', async () => {
  // First test comes back rate-limited; cooldown should push the next start out.
  let calls = 0;
  const deps = {
    smtp: {
      async verify() {
        calls++;
        if (calls === 1) return { connected: true, authenticated: false, error: '421 too many, slow down' };
        return { connected: true, authenticated: true };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const start = Date.now();
  // Concurrency 1 so ordering is deterministic; small cooldown to keep the test quick.
  await runBatch(makeCreds(2), [], { concurrency: 1, deps, rateLimitCooldownMs: 200 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 180, `expected cooldown to delay the 2nd test, got ${elapsed}ms`);
});
