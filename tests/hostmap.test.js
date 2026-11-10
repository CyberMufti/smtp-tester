import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHostMapEntries } from '../src/core/hostmap.js';

test('counts non-empty mapping lines', () => {
  assert.equal(countHostMapEntries('a.com smtp.a.com\nb.com smtp.b.com'), 2);
});

test('ignores blank lines and whitespace', () => {
  assert.equal(countHostMapEntries('a.com smtp.a.com\n\n   \nb.com smtp.b.com\n'), 2);
});

test('ignores comment lines (# or //)', () => {
  assert.equal(countHostMapEntries('# header\na.com smtp.a.com\n// note\nb.com smtp.b.com'), 2);
});

test('empty or missing input is zero, never throws', () => {
  assert.equal(countHostMapEntries(''), 0);
  assert.equal(countHostMapEntries(null), 0);
  assert.equal(countHostMapEntries(undefined), 0);
});
