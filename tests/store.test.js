import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, mergeSettings } from '../src/main/store.js';

test('defaultSettings returns documented defaults', () => {
  const d = defaultSettings();
  assert.equal(d.concurrency, 50);
  assert.equal(d.placementTimeoutMs, 90000);
  assert.equal(d.pollIntervalMs, 5000);
  assert.deepEqual(d.seeds, []);
  assert.ok(typeof d.subjectTemplate === 'string' && d.subjectTemplate.includes('{token}'));
  assert.ok(typeof d.bodyTemplate === 'string' && d.bodyTemplate.includes('{token}'));
});

test('mergeSettings overlays a patch without dropping unspecified keys', () => {
  const base = defaultSettings();
  const merged = mergeSettings(base, { concurrency: 10 });
  assert.equal(merged.concurrency, 10);
  // Untouched keys survive.
  assert.equal(merged.placementTimeoutMs, 90000);
  assert.equal(merged.pollIntervalMs, 5000);
  assert.deepEqual(merged.seeds, []);
});

test('mergeSettings does not mutate the base object', () => {
  const base = defaultSettings();
  mergeSettings(base, { concurrency: 99 });
  assert.equal(base.concurrency, 50);
});
