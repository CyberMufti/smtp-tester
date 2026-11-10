import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warmupRecommendation } from '../src/core/warmup.js';

test('dead SMTPs get no recommendation', () => {
  assert.equal(warmupRecommendation({ status: 'dead', provider: 'Gmail' }), null);
  assert.equal(warmupRecommendation(null), null);
});

test('uses provider default daily cap and a conservative start', () => {
  const g = warmupRecommendation({ status: 'valid', provider: 'Gmail' });
  assert.equal(g.dailyCap, 500);
  assert.ok(g.startVolume >= 10 && g.startVolume <= 50);
  assert.ok(g.rampDays >= 3);
  assert.ok(Array.isArray(g.ramp) && g.ramp[g.ramp.length - 1] <= g.dailyCap);

  assert.equal(warmupRecommendation({ status: 'inbox', provider: 'Microsoft 365 — Native Office' }).dailyCap, 10000);
});

test('already-limited server is throttled to a very low cap', () => {
  const r = warmupRecommendation({ status: 'limited', provider: 'Gmail', limited: true });
  assert.ok(r.dailyCap <= 50);
  assert.match(r.note, /limit/i);
});

test('a tripped limit probe caps the recommendation near the observed point', () => {
  const r = warmupRecommendation({ status: 'valid', provider: 'Google Workspace', limitProbe: { tripped: true, at: 2 } });
  assert.ok(r.dailyCap < 2000, 'well below the Workspace default');
  assert.match(r.note, /throttl/i);
});

test('unknown provider falls back to a conservative default', () => {
  const r = warmupRecommendation({ status: 'valid', provider: 'Other' });
  assert.ok(r.dailyCap > 0 && r.dailyCap <= 500);
});
