import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMutations } from '../src/core/mutator.js';

test('generates standard suffix mutations', () => {
  const m = generateMutations('password', 'user@domain.com');
  assert.ok(m.includes('password1'));
  assert.ok(m.includes('password123'));
  assert.ok(m.includes('password!'));
  assert.ok(m.includes('password2024'));
});

test('generates capitalization mutations', () => {
  const m = generateMutations('password', 'user@domain.com');
  assert.ok(m.includes('Password'));
  assert.ok(m.includes('PASSWORD'));
});

test('does not include the base password itself', () => {
  const m = generateMutations('password', 'user@domain.com');
  assert.equal(m.includes('password'), false);
});

test('leetspeak mutations', () => {
  const m = generateMutations('password', 'user@domain.com');
  assert.ok(m.includes('p@$$w0rd') || m.includes('p@ssw0rd'));
});

test('domain and username combos', () => {
  const m = generateMutations('pass', 'john@mycompany.com');
  assert.ok(m.includes('passmycompany'));
  assert.ok(m.includes('passjohn'));
});

test('caps mutations at 25 items', () => {
  const m = generateMutations('extremelylongpassword', 'user@domain.com');
  assert.ok(m.length <= 25);
});
