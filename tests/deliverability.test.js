import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverabilityScore } from '../src/core/deliverability.js';

test('dead results have no deliverability score', () => {
  assert.equal(deliverabilityScore({ status: 'dead' }), null);
  assert.equal(deliverabilityScore(null), null);
});

test('inbox + SPF pass + DMARC reject + clean + clean content -> grade A', () => {
  const r = deliverabilityScore({
    status: 'inbox',
    deliverability: { spf: { found: true, result: 'pass' }, dmarc: { found: true, policy: 'reject' }, dnsbl: { ip: '1.2.3.4', listed: false, lists: [] } },
    spamScore: { score: 0, max: 13 },
  });
  assert.equal(r.grade, 'A');
  assert.ok(r.score >= 85);
});

test('spam + missing SPF/DMARC + blacklisted + spammy content -> grade F', () => {
  const r = deliverabilityScore({
    status: 'spam',
    deliverability: { spf: { found: false }, dmarc: { found: false }, dnsbl: { ip: '1.2.3.4', listed: true, lists: ['zen.spamhaus', 'bl.x'] } },
    spamScore: { score: 10, max: 13 },
  });
  assert.equal(r.grade, 'F');
  assert.ok(r.score < 40);
});

test('valid (accepted, no placement) with good auth lands mid-range', () => {
  const r = deliverabilityScore({
    status: 'valid',
    deliverability: { spf: { found: true, result: 'pass' }, dmarc: { found: true, policy: 'none' }, dnsbl: { ip: '1.2.3.4', listed: false, lists: [] } },
    spamScore: { score: 2, max: 13 },
  });
  assert.ok(['B', 'C'].includes(r.grade), `got ${r.grade} (${r.score})`);
});

test('inbox with no deliverability checks run still scores well from placement', () => {
  const r = deliverabilityScore({ status: 'inbox' });
  assert.ok(r.score >= 85);
  assert.equal(r.grade, 'A');
});

test('factors explain the score', () => {
  const r = deliverabilityScore({ status: 'inbox', deliverability: { spf: { found: false } } });
  assert.ok(Array.isArray(r.factors) && r.factors.length >= 2);
  assert.ok(r.factors.some((f) => /inbox/i.test(f.label)));
  assert.ok(r.factors.some((f) => /SPF/i.test(f.label)));
});
