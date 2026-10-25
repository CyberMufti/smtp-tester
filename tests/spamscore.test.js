import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreContent } from '../src/core/spamscore.js';

test('a clean newsletter scores low with no reasons', () => {
  const r = scoreContent({
    subject: 'Monthly product newsletter',
    text: 'Hello, here is our update for this month. To stop receiving these, unsubscribe: http://example.com/u',
  });
  assert.equal(r.level, 'low');
  assert.equal(r.score, 0);
  assert.deepEqual(r.reasons, []);
});

test('a spammy message scores high and explains why', () => {
  const r = scoreContent({
    subject: 'FREE MONEY!!!',
    text: 'Act now! Click here to claim your prize. 100% risk-free cash!!!',
  });
  assert.equal(r.level, 'high');
  assert.ok(r.score >= 6);
  assert.ok(r.reasons.some((x) => /ALL CAPS/i.test(x)));
  assert.ok(r.reasons.some((x) => /trigger/i.test(x)));
  assert.ok(r.reasons.some((x) => /exclamation/i.test(x)));
});

test('shortened URLs are flagged', () => {
  const r = scoreContent({ subject: 'hi', text: 'Check this http://bit.ly/abc123' });
  assert.ok(r.reasons.some((x) => /shortened/i.test(x)));
});

test('image-only HTML with little text is flagged', () => {
  const r = scoreContent({ subject: 'sale', html: "<img src='http://x.com/a.png'>" });
  assert.ok(r.reasons.some((x) => /image/i.test(x)));
});

test('links with no unsubscribe are flagged', () => {
  const r = scoreContent({ subject: 'news', text: 'Visit http://a.com and http://b.com for details' });
  assert.ok(r.reasons.some((x) => /unsubscribe/i.test(x)));
});

test('score never exceeds max and level thresholds are consistent', () => {
  const r = scoreContent({ subject: 'HELLO', text: 'free cash prize winner guarantee act now click here' });
  assert.ok(r.score <= r.max);
  assert.ok(['low', 'medium', 'high'].includes(r.level));
});
