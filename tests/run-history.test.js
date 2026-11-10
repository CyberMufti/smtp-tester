import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, pushHistory } from '../src/core/run-history.js';

test('summarizeRun normalizes counts and takes top-5 providers/countries', () => {
  const s = summarizeRun({
    at: '2026-11-10T00:00:00Z', total: 100, source: 'test',
    counts: { inbox: 10, dead: 80, valid: 10 },
    providers: { Gmail: 40, 'Microsoft 365': 30, IONOS: 5, OVH: 3, Zoho: 2, Other: 20 },
    countries: { 'United States': 50, Germany: 10 },
    grades: { A: 5, B: 8, F: 60 },
  });
  assert.equal(s.total, 100);
  assert.equal(s.source, 'test');
  assert.deepEqual(s.counts, { inbox: 10, dead: 80, valid: 10 });
  assert.equal(s.topProviders.length, 5);
  assert.deepEqual(s.topProviders[0], { name: 'Gmail', count: 40 });
  assert.deepEqual(s.topCountries[0], { name: 'United States', count: 50 });
  assert.deepEqual(s.grades, { A: 5, B: 8, F: 60 });
});

test('pushHistory prepends newest and caps the list', () => {
  let hist = [];
  for (let i = 0; i < 60; i++) hist = pushHistory(hist, { at: String(i), total: i }, 50);
  assert.equal(hist.length, 50);
  assert.equal(hist[0].at, '59', 'newest first');
  assert.equal(hist[49].at, '10', 'oldest kept within cap');
});
