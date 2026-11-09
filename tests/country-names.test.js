import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countryName } from '../src/core/country-names.js';

test('maps ISO alpha-2 codes to full names', () => {
  assert.equal(countryName('US'), 'United States');
  assert.equal(countryName('us'), 'United States'); // case-insensitive
  assert.equal(countryName('FR'), 'France');
  assert.equal(countryName('GB'), 'United Kingdom');
  assert.equal(countryName('IE'), 'Ireland');
  assert.equal(countryName('DE'), 'Germany');
});

test('Unknown / empty / unmapped degrade sensibly', () => {
  assert.equal(countryName('Unknown'), 'Unknown');
  assert.equal(countryName(''), 'Unknown');
  assert.equal(countryName(null), 'Unknown');
  assert.equal(countryName('ZZ'), 'ZZ'); // unmapped code returns the code itself
});
