import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKeeperResult, KEEPER_STATUSES } from '../src/core/keepers.js';

test('keeper statuses are the rare/valuable placements, not the bulk ones', () => {
  for (const s of ['inbox', 'spam', 'valid', 'unverified', 'limited']) {
    assert.ok(KEEPER_STATUSES.includes(s), `${s} should be a keeper status`);
    assert.ok(isKeeperResult({ status: s }), `${s} result should be kept`);
  }
  for (const s of ['dead', 'unknown']) {
    assert.ok(!isKeeperResult({ status: s }), `${s} result should NOT be kept`);
  }
});

test('a result with any valid control-panel hit is kept regardless of status', () => {
  assert.ok(isKeeperResult({ status: 'dead', panels: { cpanel: { valid: true } } }));
  assert.ok(isKeeperResult({ status: 'unknown', panels: { webmail: { valid: true } } }));
  assert.ok(!isKeeperResult({ status: 'dead', panels: { whm: { valid: false } } }));
});

test('isKeeperResult is defensive about missing input', () => {
  assert.ok(!isKeeperResult(null));
  assert.ok(!isKeeperResult(undefined));
  assert.ok(!isKeeperResult({}));
});
