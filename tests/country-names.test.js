import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countryName, domainCountry } from '../src/core/country-names.js';

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

test('domainCountry derives the lead country from the domain ccTLD', () => {
  assert.equal(domainCountry('chudproperty.co.uk'), 'United Kingdom'); // uk -> GB
  assert.equal(domainCountry('acme.de'), 'Germany');
  assert.equal(domainCountry('gov.cn'), 'China');
  assert.equal(domainCountry('firm.com.au'), 'Australia');
});

test('domainCountry is Unknown for generic gTLDs and vanity ccTLDs', () => {
  assert.equal(domainCountry('gzcsg.com'), 'Unknown');     // generic gTLD
  assert.equal(domainCountry('x.org'), 'Unknown');
  assert.equal(domainCountry('x.info'), 'Unknown');
  assert.equal(domainCountry('startup.io'), 'Unknown');    // .io used globally, not Indian Ocean
  assert.equal(domainCountry('brand.co'), 'Unknown');      // .co used globally, not Colombia
  assert.equal(domainCountry('cool.me'), 'Unknown');
  assert.equal(domainCountry(''), 'Unknown');
});
