import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, applyAuthGate, detectLimited } from '../src/core/classify.js';

test('not connected -> dead with connection reason', () => {
  const r = classify({ connected: false, authenticated: false, sent: false, seeds: [] });
  assert.equal(r.status, 'dead');
  assert.match(r.reason, /connect/i);
});

test('connected but not authenticated -> dead with auth error', () => {
  const r = classify({
    connected: true,
    authenticated: false,
    authError: 'Invalid login: 535 auth failed',
    sent: false,
    seeds: [],
  });
  assert.equal(r.status, 'dead');
  assert.equal(r.reason, 'Invalid login: 535 auth failed');
});

test('authenticated but send failed -> dead with send error', () => {
  const r = classify({
    connected: true,
    authenticated: true,
    sent: false,
    sendError: 'relay access denied',
    seeds: [],
  });
  assert.equal(r.status, 'dead');
  assert.equal(r.reason, 'relay access denied');
});

test('sent with no seeds -> valid (placement not evaluated)', () => {
  const r = classify({ connected: true, authenticated: true, sent: true, seeds: [] });
  assert.equal(r.status, 'valid');
});

test('sent to self only -> valid but flagged and reason warns external delivery unverified', () => {
  const r = classify({
    connected: true,
    authenticated: true,
    sent: true,
    seeds: [],
    selfSendOnly: true,
  });
  assert.equal(r.status, 'valid');
  assert.equal(r.selfSendOnly, true);
  assert.match(r.reason, /self|external delivery not verified/i);
});

test('selfSendOnly is not attached when a real recipient received the message', () => {
  const r = classify({ connected: true, authenticated: true, sent: true, seeds: [] });
  assert.equal('selfSendOnly' in r, false);
});

test('sent, all seeds inbox -> inbox', () => {
  const r = classify({
    connected: true,
    authenticated: true,
    sent: true,
    seeds: [
      { label: 'Gmail', folder: 'inbox' },
      { label: 'Outlook', folder: 'inbox' },
    ],
  });
  assert.equal(r.status, 'inbox');
});

test('sent, any seed spam -> spam (conservative)', () => {
  const r = classify({
    connected: true,
    authenticated: true,
    sent: true,
    seeds: [
      { label: 'Gmail', folder: 'inbox' },
      { label: 'Outlook', folder: 'spam' },
    ],
  });
  assert.equal(r.status, 'spam');
});

test('sent, all seeds null folder -> unknown', () => {
  const r = classify({
    connected: true,
    authenticated: true,
    sent: true,
    seeds: [
      { label: 'Gmail', folder: null },
      { label: 'Outlook', folder: null },
    ],
  });
  assert.equal(r.status, 'unknown');
});

test('sent, every seed errored -> valid with placement-undetermined note', () => {
  const r = classify({
    connected: true,
    authenticated: true,
    sent: true,
    seeds: [
      { label: 'Gmail', folder: null, error: 'IMAP login failed' },
      { label: 'Outlook', folder: null, error: 'connection reset' },
    ],
  });
  assert.equal(r.status, 'valid');
  assert.match(r.reason, /placement/i);
});

test('perSeed always echoes the passed seed array', () => {
  const seeds = [{ label: 'Gmail', folder: 'inbox' }];
  const r = classify({ connected: true, authenticated: true, sent: true, seeds });
  assert.deepEqual(r.perSeed, seeds);
});

test('auth rejected with userExists:false -> dead, flagged not-found, reason notes it', () => {
  const r = classify({
    connected: true,
    authenticated: false,
    authError: 'Invalid login: 550 user unknown',
    userExists: false,
    sent: false,
    seeds: [],
  });
  assert.equal(r.status, 'dead');
  assert.equal(r.userExists, false);
  assert.match(r.reason, /not found|does not exist|no such/i);
});

test('auth rejected with userExists:true -> dead, flagged exists, reason unchanged', () => {
  const r = classify({
    connected: true,
    authenticated: false,
    authError: 'Invalid login: 535 bad password',
    userExists: true,
    sent: false,
    seeds: [],
  });
  assert.equal(r.status, 'dead');
  assert.equal(r.userExists, true);
  assert.equal(r.reason, 'Invalid login: 535 bad password');
});

test('userExists is not attached to non-auth outcomes', () => {
  const connectFail = classify({ connected: false, authenticated: false, sent: false, seeds: [] });
  assert.equal('userExists' in connectFail, false);
  const ok = classify({ connected: true, authenticated: true, sent: true, seeds: [] });
  assert.equal('userExists' in ok, false);
});

test('applyAuthGate: valid + missing SPF -> unverified', () => {
  const g = applyAuthGate('valid', { spf: { found: false }, dmarc: { found: true } });
  assert.equal(g.status, 'unverified');
  assert.match(g.reason, /SPF/);
});

test('applyAuthGate: valid + missing DMARC -> unverified', () => {
  const g = applyAuthGate('valid', { spf: { found: true }, dmarc: { found: false } });
  assert.equal(g.status, 'unverified');
  assert.match(g.reason, /DMARC/);
});

test('applyAuthGate: valid + missing both -> unverified names both', () => {
  const g = applyAuthGate('valid', { spf: { found: false }, dmarc: { found: false } });
  assert.equal(g.status, 'unverified');
  assert.match(g.reason, /SPF/);
  assert.match(g.reason, /DMARC/);
});

test('applyAuthGate: valid + SPF and DMARC present (records only) stays valid', () => {
  assert.equal(applyAuthGate('valid', { spf: { found: true }, dmarc: { found: true } }), null);
});

test('applyAuthGate: sidecar SPF result=fail (IP not authorized) -> unverified', () => {
  const g = applyAuthGate('valid', { spf: { found: true, result: 'fail' }, dmarc: { found: true, aligned: true } });
  assert.equal(g.status, 'unverified');
  assert.match(g.reason, /SPF/);
});

test('applyAuthGate: sidecar SPF result=pass + DMARC aligned stays valid', () => {
  assert.equal(
    applyAuthGate('valid', { spf: { found: true, result: 'pass' }, dmarc: { found: true, aligned: true, policy: 'reject' } }),
    null,
  );
});

test('applyAuthGate: softfail/neutral SPF is lenient (not gated)', () => {
  assert.equal(applyAuthGate('valid', { spf: { found: true, result: 'softfail' }, dmarc: { found: true } }), null);
  assert.equal(applyAuthGate('valid', { spf: { found: true, result: 'neutral' }, dmarc: { found: true } }), null);
});

test('applyAuthGate: DMARC not aligned under enforcing policy -> unverified', () => {
  const g = applyAuthGate('valid', { spf: { found: true, result: 'pass' }, dmarc: { found: true, aligned: false, policy: 'reject' } });
  assert.equal(g.status, 'unverified');
  assert.match(g.reason, /DMARC/);
});

test('applyAuthGate: DMARC not aligned under p=none is monitor-only (not gated)', () => {
  assert.equal(
    applyAuthGate('valid', { spf: { found: true, result: 'pass' }, dmarc: { found: true, aligned: false, policy: 'none' } }),
    null,
  );
});

test('applyAuthGate: inbox/spam are never downgraded (delivery already proven)', () => {
  const deliv = { spf: { found: false }, dmarc: { found: false } };
  assert.equal(applyAuthGate('inbox', deliv), null);
  assert.equal(applyAuthGate('spam', deliv), null);
});

test('applyAuthGate: no-op when deliverability checks did not run', () => {
  assert.equal(applyAuthGate('valid', undefined), null);
  assert.equal(applyAuthGate('valid', {}), null); // spf/dmarc undefined -> lookup never ran
});

test('detectLimited: authenticated send rejected with quota text -> limited', () => {
  const r = { status: 'dead', deadReason: 'send', reason: '550 5.4.5 Daily user sending quota exceeded' };
  const g = detectLimited(r);
  assert.equal(g.status, 'limited');
  assert.match(g.reason, /rate\/quota/i);
});

test('detectLimited: 421 deferral after auth -> limited', () => {
  const r = { status: 'dead', deadReason: 'send', reason: '421 4.7.0 Try again later, closing connection' };
  assert.equal(detectLimited(r).status, 'limited');
});

test('detectLimited: accepted send whose response carries throttle text -> limited', () => {
  const r = { status: 'valid', reason: 'sent', sendResponse: '250 OK but temporarily deferred due to rate limiting' };
  assert.equal(detectLimited(r).status, 'limited');
});

test('detectLimited: unusual activity / suspicious -> limited', () => {
  const r = { status: 'dead', deadReason: 'send', reason: 'Please log in via your web browser: unusual sign-in activity' };
  assert.equal(detectLimited(r).status, 'limited');
});

test('detectLimited: clean accepted send is NOT limited', () => {
  assert.equal(detectLimited({ status: 'valid', reason: 'sent', sendResponse: '250 2.0.0 OK  1699 - gsmtp' }), null);
});

test('detectLimited: a failed probe on another port does NOT downgrade a working credential', () => {
  // Authenticated + sent + landed in inbox on port 465, but the earlier port-25
  // probe was greylisted. The throttle text lives only in a FAILED attempt, so
  // the credential must stay inbox — not be mislabeled "limited".
  const r = {
    status: 'inbox',
    reason: 'landed in inbox on all resolved seeds',
    sendResponse: '250 2.0.0 OK message accepted',
    attempts: [
      { host: 'mail.example.com', port: 25, outcome: 'auth rejected (421 4.7.0 too many connections, try again later)' },
      { host: 'mail.example.com', port: 465, outcome: 'ok' },
    ],
  };
  assert.equal(detectLimited(r), null);
});

test('detectLimited: a connect/auth failure is never limited (login does not work)', () => {
  assert.equal(detectLimited({ status: 'dead', deadReason: 'auth', reason: '535 too many bad auth attempts' }), null);
  assert.equal(detectLimited({ status: 'dead', deadReason: 'connect', reason: 'connect ETIMEDOUT' }), null);
});
