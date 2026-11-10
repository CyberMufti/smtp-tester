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

test('accepts an async-iterable source (streaming) and tests every credential once', async () => {
  const deps = okDeps();
  async function* source() {
    for (const c of makeCreds(7)) yield c;
  }
  let progress = 0;
  const results = await runBatch(source(), [], { concurrency: 3, deps }, () => progress++);
  assert.equal(results.length, 7);
  assert.equal(progress, 7);
  assert.ok(deps.maxInFlight() <= 3, `maxInFlight was ${deps.maxInFlight()}`);
  // Each credential handed to exactly one worker — users are all distinct.
  assert.equal(new Set(results.map((r) => r.cred.user)).size, 7);
});

test('streaming source stops promptly when aborted', async () => {
  const deps = okDeps();
  let produced = 0;
  async function* source() {
    for (let i = 0; i < 1000; i++) {
      produced++;
      yield { host: `h${i}.com`, port: 587, user: `u${i}`, pass: 'p' };
    }
  }
  const ac = new AbortController();
  const run = runBatch(source(), [], { concurrency: 2, deps, signal: ac.signal });
  setTimeout(() => ac.abort(), 15);
  const results = await run;
  // It must not drain all 1000 after an early abort.
  assert.ok(produced < 1000, `produced ${produced} — abort did not stop the stream`);
  assert.ok(results.length <= produced);
});

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

test('tries the input host first, falls back to the detected host, and records which worked', async () => {
  const verifyCalls = [];
  const deps = {
    smtp: {
      async verify(cred) {
        verifyCalls.push(`${cred.host}:${cred.port}`);
        // The user's typed host is wrong; the detected Gmail host works.
        if (cred.host === 'wrong.host.com') return { connected: false, error: 'ECONNREFUSED' };
        if (cred.host === 'smtp.gmail.com') return { connected: true, authenticated: true };
        return { connected: false, error: 'ECONNREFUSED' };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const creds = [{ host: 'wrong.host.com', port: 587, user: 'me@gmail.com', pass: 'x' }];
  const [result] = await runBatch(creds, [], { concurrency: 1, deps });
  // Input tried before the detected fallback.
  assert.equal(verifyCalls[0], 'wrong.host.com:587');
  assert.ok(verifyCalls.includes('smtp.gmail.com:587'));
  assert.equal(result.status, 'valid');
  assert.equal(result.usedHost, 'smtp.gmail.com');
  assert.equal(result.triedFallback, true);
});

test('a wrong-but-reachable host that auth-fails still falls back to the detected provider', async () => {
  const deps = {
    smtp: {
      async verify(cred) {
        if (cred.host === 'smtp-mail.outlook.com') return { connected: true, authenticated: false, error: 'EAUTH' };
        if (cred.host === 'smtp.gmail.com') return { connected: true, authenticated: true };
        return { connected: false, error: 'no' };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  // Mislabeled line: Gmail credentials pointed at Outlook's (reachable) server.
  const creds = [{ host: 'smtp-mail.outlook.com', port: 587, user: 'bob@gmail.com', pass: 'x' }];
  const [r] = await runBatch(creds, [], { concurrency: 1, deps });
  assert.equal(r.status, 'valid');
  assert.equal(r.usedHost, 'smtp.gmail.com');
  assert.equal(r.triedFallback, true);
});

test('same-host auth failure with no other provider is dead (no infinite retry)', async () => {
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: false, error: 'EAUTH' }; },
      async send() { return { accepted: [] }; },
    },
    imap: { async findToken() { return { found: false, folder: null }; } },
  };
  const creds = [{ host: null, port: null, user: 'me@gmail.com', pass: 'x' }];
  const [r] = await runBatch(creds, [], { concurrency: 1, deps });
  assert.equal(r.status, 'dead');
  assert.match(r.reason, /EAUTH|auth/i);
});

test('a host-less custom-domain credential discovers its server via MX', async () => {
  const tried = [];
  const deps = {
    smtp: {
      async verify(cred) {
        tried.push(cred.host);
        return cred.host === 'mx1.biz-domain.com'
          ? { connected: true, authenticated: true }
          : { connected: false, error: 'ECONNREFUSED' };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
    dns: {
      async resolveMx(domain) {
        return domain === 'biz-domain.com' ? [{ exchange: 'mx1.biz-domain.com', priority: 10 }] : [];
      },
    },
  };
  const creds = [{ host: null, port: null, user: 'u@biz-domain.com', pass: 'x' }];
  const [r] = await runBatch(creds, [], { concurrency: 1, deps });
  assert.equal(r.status, 'valid');
  assert.equal(r.usedHost, 'mx1.biz-domain.com');
  assert.ok(tried.includes('mx1.biz-domain.com'));
});

test('a host-less credential is resolved entirely from the provider', async () => {
  const deps = {
    smtp: {
      async verify(cred) {
        return cred.host === 'smtp.gmail.com'
          ? { connected: true, authenticated: true }
          : { connected: false, error: 'no' };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const creds = [{ host: null, port: null, user: 'me@gmail.com', pass: 'x' }];
  const [result] = await runBatch(creds, [], { concurrency: 1, deps });
  assert.equal(result.status, 'valid');
  assert.equal(result.usedHost, 'smtp.gmail.com');
});

test('a credential with no connectable candidate is dead (could not connect)', async () => {
  const deps = {
    smtp: {
      async verify() { return { connected: false, error: 'ECONNREFUSED' }; },
      async send() { return { accepted: [] }; },
    },
    imap: { async findToken() { return { found: false, folder: null }; } },
  };
  const creds = [{ host: 'nope.example.com', port: 587, user: 'u@unknownxyz.com', pass: 'x' }];
  const [result] = await runBatch(creds, [], { concurrency: 1, deps });
  assert.equal(result.status, 'dead');
});

test('manual recipient emails are included in the send and surfaced on the result', async () => {
  let sentTo = null;
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { sentTo = opts.to; return { accepted: opts.to.split(', ') }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const creds = [{ host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p' }];
  const [result] = await runBatch(creds, [], {
    concurrency: 1,
    deps,
    manualRecipients: ['check1@gmail.com', 'check2@outlook.com'],
  });
  assert.ok(sentTo.includes('check1@gmail.com'));
  assert.ok(sentTo.includes('check2@outlook.com'));
  // The result carries the token so the user can search their inbox.
  assert.ok(result.token && result.token.startsWith('SMTPTEST-'));
  assert.deepEqual(result.manualRecipients, ['check1@gmail.com', 'check2@outlook.com']);
  // A real recipient received the message, so it is not a self-send.
  assert.ok(!result.selfSendOnly);
});

test('no seeds and no manual recipients -> self-send flagged on the result', async () => {
  let sentTo = null;
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { sentTo = opts.to; return { accepted: opts.to.split(', ') }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const creds = [{ host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p' }];
  const [result] = await runBatch(creds, [], { concurrency: 1, deps });
  // The only recipient was the account itself.
  assert.equal(sentTo, 'u@x.com');
  assert.equal(result.status, 'valid');
  assert.equal(result.selfSendOnly, true);
  assert.match(result.reason, /self|external delivery not verified/i);
});

test('records each host/port attempted and its outcome', async () => {
  const deps = {
    smtp: {
      async verify(cred) {
        if (cred.port === 465) return { connected: true, authenticated: true };
        return { connected: false, error: 'ECONNREFUSED' };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  // Input host with a wrong port; candidates become 2525, 587, 465 on that host.
  const [r] = await runBatch([{ host: 'multi.com', port: 2525, user: 'u@multi.com', pass: 'p' }], [], {
    concurrency: 1,
    deps,
  });
  assert.ok(Array.isArray(r.attempts));
  assert.equal(r.attempts.length, 3);
  assert.deepEqual(r.attempts.map((a) => a.port), [2525, 587, 465]);
  assert.equal(r.attempts[2].outcome, 'ok');
  assert.match(r.attempts[0].outcome, /ECONNREFUSED/i);
});

test('stops immediately when an authoritative (detected) host rejects auth — no pointless guesses', async () => {
  const deps = {
    smtp: {
      async verify(cred) {
        // The detected provider host rejects auth (e.g. M365 SMTP AUTH disabled);
        // anything else would succeed — so if it keeps going, status would be valid.
        if (cred.host === 'smtp.zoho.com') {
          return { connected: true, authenticated: false, error: '535 SmtpClientAuthentication is disabled' };
        }
        return { connected: true, authenticated: true };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
    dns: {
      async resolveMx(domain) {
        return domain === 'biz.com' ? [{ exchange: 'mx.zoho.com', priority: 10 }] : [];
      },
    },
  };
  const [r] = await runBatch([{ host: null, port: null, user: 'u@biz.com', pass: 'x' }], [], {
    concurrency: 1,
    deps,
  });
  assert.equal(r.status, 'dead');
  assert.equal(r.attempts.length, 1, 'should stop after the authoritative host auth-fails');
  assert.equal(r.attempts[0].host, 'smtp.zoho.com');
});

test('retries a transient connection failure and succeeds, without retrying auth failures', async () => {
  // Transient: fails to connect on the first pass (2 candidates), succeeds after.
  let calls = 0;
  const transientDeps = {
    smtp: {
      async verify() {
        calls++;
        return calls <= 2 ? { connected: false, error: 'ECONNREFUSED' } : { connected: true, authenticated: true };
      },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
  const [r] = await runBatch([{ host: 'h.com', port: 587, user: 'u@h.com', pass: 'p' }], [], {
    concurrency: 1,
    deps: transientDeps,
    retries: 1,
    retryBackoffMs: 0,
  });
  assert.equal(r.status, 'valid', 'transient connect failure should be retried and recover');

  // Auth failure is permanent — must NOT be retried.
  let authCalls = 0;
  const authDeps = {
    smtp: {
      async verify() { authCalls++; return { connected: true, authenticated: false, error: 'EAUTH' }; },
      async send() { return { accepted: [] }; },
    },
    imap: { async findToken() { return { found: false, folder: null }; } },
  };
  const [r2] = await runBatch([{ host: 'h.com', port: 587, user: 'u@h.com', pass: 'p' }], [], {
    concurrency: 1,
    deps: authDeps,
    retries: 3,
    retryBackoffMs: 0,
  });
  assert.equal(r2.status, 'dead');
  assert.equal(authCalls, 1, 'auth failure should not trigger retries');
});

test('deliverability checks populate SPF/DMARC, DNSBL and spam score when enabled', async () => {
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
    dns: {
      async resolveTxt(name) {
        if (name === 'acme.com') return [['v=spf1 -all']];
        if (name === '_dmarc.acme.com') return [['v=DMARC1; p=reject']];
        return [];
      },
      async resolve4(name) {
        if (name === 'smtp.acme.com') return ['1.2.3.4'];
        if (name.endsWith('zen.spamhaus.org')) return ['127.0.0.2'];
        throw new Error('ENOTFOUND');
      },
    },
  };
  const creds = [{ host: 'smtp.acme.com', port: 587, user: 'u@acme.com', pass: 'p' }];
  const [r] = await runBatch(creds, [], {
    concurrency: 1,
    deps,
    from: 'sender@acme.com',
    checks: { authRecords: true, dnsbl: true, spamScore: true },
    subjectTemplate: 'Hello {token}',
    bodyTemplate: 'Body {token}',
  });
  assert.equal(r.deliverability.spf.all, '-all');
  assert.equal(r.deliverability.dmarc.policy, 'reject');
  assert.equal(r.deliverability.dnsbl.listed, true);
  assert.deepEqual(r.deliverability.dnsbl.lists, ['zen.spamhaus.org']);
  assert.ok(r.spamScore && typeof r.spamScore.score === 'number');
});

test('no SPF/DMARC lookup (or bogus "missing" result) when there is no real From domain', async () => {
  let txtCalled = false;
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
    dns: {
      async resolveTxt() { txtCalled = true; return []; },
      async resolve4() { throw new Error('ENOTFOUND'); },
    },
  };
  // From unset, username is a SendGrid-style apikey (not an email/domain).
  const creds = [{ host: 'smtp.sendgrid.net', port: 587, user: 'apikey', pass: 'SG.x' }];
  const [r] = await runBatch(creds, [], { concurrency: 1, deps, from: '', checks: { authRecords: true } });
  assert.equal(txtCalled, false, 'should not look up TXT for a non-domain');
  assert.equal(r.deliverability?.spf, undefined);
  assert.equal(r.deliverability?.dmarc, undefined);
});

test('deliverability checks are skipped (no network) when not enabled', async () => {
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
    dns: {
      async resolveTxt() { throw new Error('should not be called'); },
      async resolve4() { throw new Error('should not be called'); },
    },
  };
  const [r] = await runBatch(makeCreds(1), [], { concurrency: 1, deps });
  assert.equal(r.deliverability, undefined);
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

test('a valid SMTP whose placement check outlasts the network budget is still classified inbox (watchdog must not abort placement polling)', async () => {
  // Regression: the per-credential watchdog wrapped ALL of testOne, including
  // the IMAP placement poll. With the flat 25s default < the 90s placement
  // timeout, any seed whose test mail took longer than the watchdog to appear
  // was force-killed as "dead: watchdog timeout" and never classified inbox/spam.
  const deps = {
    smtp: {
      async verify() { return { connected: true, authenticated: true }; },
      async send(cred, opts) { return { accepted: [opts.to] }; },
    },
    imap: {
      // Placement resolves AFTER the (tiny) network budget below, but well
      // within placementTimeoutMs — exactly the real-world "mail takes a while
      // to land" case.
      async findToken() {
        await new Promise((r) => setTimeout(r, 150));
        return { found: true, folder: 'inbox' };
      },
    },
  };
  const seeds = [{ label: 'Gmail', address: 'seed@x.com' }];
  const [r] = await runBatch(makeCreds(1), seeds, {
    concurrency: 1,
    deps,
    credentialTimeoutMs: 50, // network-phase budget, smaller than placement delay
    placementTimeoutMs: 5000,
    pollIntervalMs: 20,
  });
  assert.equal(r.status, 'inbox', `expected inbox, got ${r.status} (${r.reason})`);
});

test('sidecar evalAuth drives the unverified gate: SPF fail for the sending IP -> unverified', async () => {
  const deps = {
    smtp: { async verify(){return {connected:true,authenticated:true};}, async send(_,o){return {accepted:[o.to]};} },
    imap: { async findToken(){return {found:false};} },
    dns: { async resolve4(){ return ['203.0.113.9']; }, async resolveTxt(){ return []; } },
    // Sidecar says: SPF record exists but the sending IP is NOT authorized.
    evalAuth: async ({ ip }) => ({
      engine: 'python',
      spf: { found: true, all: '-all', result: ip ? 'fail' : null },
      dmarc: { found: true, policy: 'reject', aligned: false },
    }),
  };
  const [r] = await runBatch(
    [{ host: 'smtp.sender.com', port: 587, user: 'u@sender.com', pass: 'p' }],
    [],
    { concurrency: 1, deps, manualRecipients: ['t@x.com'], checks: { authRecords: true } },
  );
  assert.equal(r.status, 'unverified', `expected unverified, got ${r.status}`);
  assert.equal(r.deliverability.authEngine, 'python');
  assert.equal(r.deliverability.spf.result, 'fail');
});

test('no sidecar (evalAuth absent) falls back to JS record read and still gates on missing records', async () => {
  const deps = {
    smtp: { async verify(){return {connected:true,authenticated:true};}, async send(_,o){return {accepted:[o.to]};} },
    imap: { async findToken(){return {found:false};} },
    // JS fallback path: no TXT records -> SPF/DMARC both absent.
    dns: { async resolve4(){ return ['203.0.113.9']; }, async resolveTxt(){ return []; } },
  };
  const [r] = await runBatch(
    [{ host: 'smtp.sender.com', port: 587, user: 'u@sender.com', pass: 'p' }],
    [],
    { concurrency: 1, deps, manualRecipients: ['t@x.com'], checks: { authRecords: true } },
  );
  assert.equal(r.status, 'unverified');
  assert.equal(r.deliverability.authEngine, 'js');
});

test('deep limit probe: an account that throttles after the first send -> limited', async () => {
  let sends = 0;
  const deps = {
    smtp: {
      async verify(){ return { connected: true, authenticated: true }; },
      async send(_, o) {
        sends++;
        // First send (the real test) is accepted; the 2nd probe gets throttled.
        if (sends >= 2) return { accepted: [], error: '421 4.7.0 Try again later, rate limited' };
        return { accepted: [o.to], response: '250 OK' };
      },
    },
    imap: { async findToken(){ return { found: false }; } },
  };
  const [r] = await runBatch(
    [{ host: 'smtp.sender.com', port: 587, user: 'u@sender.com', pass: 'p' }],
    [],
    { concurrency: 1, deps, manualRecipients: ['t@x.com'], limitProbe: true, limitProbeCount: 3 },
  );
  assert.equal(r.status, 'limited', `expected limited, got ${r.status}`);
  assert.ok(r.limitProbe?.tripped);
});

test('deep limit probe: an account that accepts every probe stays valid', async () => {
  const deps = {
    smtp: {
      async verify(){ return { connected: true, authenticated: true }; },
      async send(_, o){ return { accepted: [o.to], response: '250 2.0.0 OK gsmtp' }; },
    },
    imap: { async findToken(){ return { found: false }; } },
  };
  const [r] = await runBatch(
    [{ host: 'smtp.sender.com', port: 587, user: 'u@sender.com', pass: 'p' }],
    [],
    { concurrency: 1, deps, manualRecipients: ['t@x.com'], limitProbe: true, limitProbeCount: 3 },
  );
  assert.equal(r.status, 'valid');
});

test('a port-25 auth failure does not skip the submission ports (587/465 still tried)', async () => {
  const smtp = {
    async verify(cred) {
      if (cred.port === 25) return { connected: true, authenticated: false, error: '535 AUTH not offered on 25' };
      if (cred.port === 587) return { connected: true, authenticated: true };
      return { connected: false, authenticated: false, error: 'refused' };
    },
    async send() { return { accepted: ['x@x.com'], response: '250 OK' }; },
  };
  const imap = { async findToken() { return { found: false, folder: null }; } };
  const creds = [{ host: 'mail.custom.com', port: 25, user: 'u@custom.com', pass: 'p' }];
  const results = await runBatch(creds, [], { concurrency: 1, deps: { smtp, imap } });
  assert.equal(results[0].status, 'valid', 'valid on 587 despite port-25 auth failure');
  assert.equal(results[0].usedPort, 587);
});

test('a pool-proxy connect failure always retries DIRECT, even for an unusual error', async () => {
  // Proxy present -> fails with a message the old regex would NOT match; no proxy -> works.
  const smtp = {
    async verify(cred, opts) {
      if (opts && opts.proxy) return { connected: false, authenticated: false, error: 'Socks5 Authentication failed' };
      return { connected: true, authenticated: true };
    },
    async send() { return { accepted: ['u@x.com'], response: '250 OK' }; },
  };
  const imap = { async findToken() { return { found: false, folder: null }; } };
  const creds = [{ host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p' }];
  const results = await runBatch(creds, [], {
    concurrency: 1, deps: { smtp, imap },
    proxyProvider: () => 'socks5://1.2.3.4:1080', onProxyFailure: () => {},
  });
  assert.equal(results[0].status, 'valid', 'retried direct and succeeded');
  assert.equal(results[0].proxyFallback, true);
});

test('a down TARGET (direct also fails) does NOT retire the proxy', async () => {
  // Both proxied and direct fail to connect -> target is down, proxy is fine.
  const smtp = {
    async verify() { return { connected: false, authenticated: false, error: 'connect ETIMEDOUT' }; },
    async send() { return { accepted: [] }; },
  };
  const imap = { async findToken() { return { found: false, folder: null }; } };
  let retired = 0;
  const creds = [{ host: 'down.x.com', port: 587, user: 'u@x.com', pass: 'p' }];
  const results = await runBatch(creds, [], {
    concurrency: 1, deps: { smtp, imap },
    proxyProvider: () => 'socks5://1.2.3.4:1080', onProxyFailure: () => { retired++; },
  });
  assert.equal(results[0].status, 'dead');
  assert.equal(retired, 0, 'good proxy must not be retired when the target is down');
});
