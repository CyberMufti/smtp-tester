import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../src/core/tester.js';

function makeCreds(n) {
  return Array.from({ length: n }, (_, i) => ({
    host: `h${i}.com`,
    port: 587,
    user: `u${i}`,
    pass: `p${i}`,
  }));
}

// A stub smtp/imap pair that always succeeds and records call order.
function okDeps() {
  let inFlight = 0;
  let maxInFlight = 0;
  const tokens = [];
  return {
    maxInFlight: () => maxInFlight,
    tokens,
    smtp: {
      async verify() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { connected: true, authenticated: true };
      },
      async send(cred, opts) {
        tokens.push(opts.subject);
        return { accepted: [opts.to] };
      },
    },
    imap: {
      async findToken() {
        return { found: true, folder: 'inbox' };
      },
    },
  };
}

test('respects concurrency limit and returns a result per credential', async () => {
  const deps = okDeps();
  const creds = makeCreds(10);
  const results = await runBatch(creds, [], { concurrency: 3, deps });
  assert.equal(results.length, 10);
  assert.ok(deps.maxInFlight() <= 3, `maxInFlight was ${deps.maxInFlight()}`);
});

test('calls onProgress once per credential', async () => {
  const deps = okDeps();
  const creds = makeCreds(5);
  let calls = 0;
  await runBatch(creds, [], { concurrency: 2, deps }, () => calls++);
  assert.equal(calls, 5);
});

test('a credential whose smtp throws still yields a dead result; batch completes', async () => {
  const deps = {
    smtp: {
      async verify(cred) {
        if (cred.host === 'h1.com') throw new Error('boom');
        return { connected: true, authenticated: true };
      },
      async send(cred, opts) {
        return { accepted: [opts.to] };
      },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const results = await runBatch(makeCreds(3), [], { concurrency: 3, deps });
  assert.equal(results.length, 3);
  const bad = results.find((r) => r.cred.host === 'h1.com');
  assert.equal(bad.status, 'dead');
});

test('pipeline short-circuits: not-authenticated skips send and findToken', async () => {
  let sendCalled = false;
  let findCalled = false;
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: false, error: 'bad auth' }; },
      async send() { sendCalled = true; return { accepted: [] }; },
    },
    imap: { async findToken() { findCalled = true; return { found: false, folder: null }; } },
  };
  const seeds = [{ label: 'Gmail', address: 'seed@x.com' }];
  const results = await runBatch(makeCreds(1), seeds, { concurrency: 1, deps });
  assert.equal(results[0].status, 'dead');
  assert.equal(sendCalled, false);
  assert.equal(findCalled, false);
});

test('a seed without an address does not inject "undefined" into the recipient list', async () => {
  let sentTo = null;
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { sentTo = opts.to; return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const seeds = [
    { label: 'Good', address: 'good@x.com' },
    { label: 'Missing' }, // no address
  ];
  await runBatch(makeCreds(1), seeds, { concurrency: 1, deps });
  assert.ok(sentTo, 'send should have been called');
  // Only the valid address — no trailing blank or "undefined" recipient.
  assert.equal(sentTo, 'good@x.com');
});

test('token passed to send and findToken matches and is unique per credential', async () => {
  const sendTokens = [];
  const findTokens = [];
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { sendTokens.push(opts.subject); return { accepted: [opts.to] }; },
    },
    imap: {
      async findToken(seed, token) { findTokens.push(token); return { found: true, folder: 'inbox' }; },
    },
  };
  const seeds = [{ label: 'Gmail', address: 'seed@x.com' }];
  await runBatch(makeCreds(3), seeds, { concurrency: 3, deps });
  // Each send subject contains the token handed to findToken.
  assert.equal(sendTokens.length, 3);
  assert.equal(findTokens.length, 3);
  for (const token of findTokens) {
    assert.ok(sendTokens.some((subj) => subj.includes(token)), `no send subject contained ${token}`);
  }
  // Tokens are unique across credentials.
  assert.equal(new Set(findTokens).size, 3);
});
