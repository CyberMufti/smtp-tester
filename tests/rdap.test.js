import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRdapCountry, rdapCountry } from '../src/core/rdap.js';

const registrant = (props) => ({
  entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ...props]] }],
});

test('parses the registrant country from the ADR cc parameter (ISO-2)', () => {
  const json = registrant([['adr', { cc: 'US' }, 'text', ['', '', '', '', '', '', 'United States']]]);
  const r = parseRdapCountry(json);
  assert.equal(r.country, 'US');
  assert.equal(r.reason, 'ok');
});

test('falls back to the ADR country name when no cc parameter is present', () => {
  const json = registrant([['adr', {}, 'text', ['', '', '', '', '', '', 'Germany']]]);
  assert.equal(parseRdapCountry(json).country, 'DE');
});

test('privacy/proxy registrant yields no country (the country would be the proxy\'s)', () => {
  for (const name of ['REDACTED FOR PRIVACY', 'Domains By Proxy, LLC', 'WhoisGuard, Inc.', 'Contact Privacy Inc.']) {
    const json = registrant([['fn', {}, 'text', name], ['adr', { cc: 'US' }, 'text', ['', '', '', '', '', '', 'United States']]]);
    const r = parseRdapCountry(json);
    assert.equal(r.country, null, name);
    assert.equal(r.reason, 'privacy', name);
  }
});

test('redacted response (no registrant country) yields null', () => {
  const json = { entities: [], redacted: [{ name: { type: 'Registrant Country' } }] };
  const r = parseRdapCountry(json);
  assert.equal(r.country, null);
  assert.equal(r.reason, 'redacted');
});

test('no entities / no usable data yields null without throwing', () => {
  assert.equal(parseRdapCountry({}).country, null);
  assert.equal(parseRdapCountry(null).country, null);
  assert.equal(parseRdapCountry({ entities: [{ roles: ['technical'] }] }).country, null);
});

test('rdapCountry fetches, parses, and returns the ISO code (injected fetch)', async () => {
  const json = registrant([['adr', { cc: 'US' }, 'text', ['', '', '', '', '', '', 'United States']]]);
  const fetchFn = async () => ({ ok: true, json: async () => json });
  assert.equal(await rdapCountry('acme.com', { fetchFn }), 'US');
});

test('rdapCountry is best-effort: network error / non-ok / bad JSON -> null', async () => {
  assert.equal(await rdapCountry('a.com', { fetchFn: async () => { throw new Error('ENOTFOUND'); } }), null);
  assert.equal(await rdapCountry('a.com', { fetchFn: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(await rdapCountry('a.com', { fetchFn: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) }), null);
  assert.equal(await rdapCountry('a.com', { fetchFn: null }), null);
});
