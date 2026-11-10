import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLeadCountry } from '../src/core/provider-class.js';
import { countryCodeFromName, countryList } from '../src/core/country-names.js';

test('ccTLD is authoritative and beats the batch override', () => {
  // A .co.uk in a list tagged "US" still reports United Kingdom.
  assert.equal(resolveLeadCountry({ userDomain: 'acme.co.uk', provider: 'Other', batchCountry: 'US' }), 'United Kingdom');
});

test('region-locked provider beats the batch override', () => {
  assert.equal(resolveLeadCountry({ userDomain: 'x.com', provider: 'NetEase', batchCountry: 'US' }), 'China');
});

test('batch override fills gTLD domains with no other signal', () => {
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Rackspace', batchCountry: 'US' }), 'United States');
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Other', batchCountry: 'US' }), 'United States');
});

test('RDAP fills the gap only when nothing cheaper resolved it, and never beats ccTLD/override', () => {
  // No override: RDAP result is used.
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Other', rdapCode: 'CA' }), 'Canada');
  // Override present: it wins; RDAP is not consulted here (both resolve to the same precedence test).
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Other', batchCountry: 'US', rdapCode: 'CA' }), 'United States');
  // ccTLD present: it wins over RDAP.
  assert.equal(resolveLeadCountry({ userDomain: 'acme.de', provider: 'Other', rdapCode: 'CA' }), 'Germany');
});

test('self-hosted server GeoIP is the final fallback before Unknown', () => {
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Postfix', serverGeo: 'US' }), 'United States');
  // Reseller/SaaS does NOT use server GeoIP.
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Rackspace', serverGeo: 'DE' }), 'Unknown');
});

test('nothing resolves -> Unknown', () => {
  assert.equal(resolveLeadCountry({ userDomain: 'acme.com', provider: 'Other' }), 'Unknown');
});

test('countryCodeFromName reverses names and common aliases', () => {
  assert.equal(countryCodeFromName('United States'), 'US');
  assert.equal(countryCodeFromName('united states of america'), 'US');
  assert.equal(countryCodeFromName('UK'), 'GB');
  assert.equal(countryCodeFromName('Germany'), 'DE');
  assert.equal(countryCodeFromName('Nowhereland'), null);
});

test('countryList is sorted name/code pairs for the UI dropdown', () => {
  const list = countryList();
  assert.ok(list.length > 100);
  assert.ok(list.every((c) => c.code && c.name));
  assert.deepEqual([...list].sort((a, b) => a.name.localeCompare(b.name)), list);
});
