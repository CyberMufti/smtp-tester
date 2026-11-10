import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRdapCountry, rdapCountry, registrarRdapUrl } from '../src/core/rdap.js';

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

// Two-hop: .com/.net registries are THIN (registrar only, no registrant). The
// registrant country lives at the registrar's RDAP, linked via rel="related".
const thinRegistry = {
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'GoDaddy.com, LLC']]] }],
  links: [
    { rel: 'self', href: 'https://rdap.verisign.com/com/v1/domain/acme.com' },
    { rel: 'related', href: 'https://rdap.godaddy.com/v1/domain/ACME.COM' },
  ],
};
const registrarReg = (props) => ({ entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ...props]] }] });

test('registrarRdapUrl extracts the related registrar RDAP link', () => {
  assert.equal(registrarRdapUrl(thinRegistry), 'https://rdap.godaddy.com/v1/domain/ACME.COM');
  assert.equal(registrarRdapUrl({ links: [] }), null);
  assert.equal(registrarRdapUrl({}), null);
});

test('rdapCountry follows the registrar hop when the registry is thin (skip-proxy: real registrant)', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('rdap.org')) return { ok: true, json: async () => thinRegistry };
    return { ok: true, json: async () => registrarReg([['fn', {}, 'text', 'Amy Gorsline'], ['adr', { cc: 'US' }, 'text', ['', '', '', '', '', '', 'United States']]]) };
  };
  assert.equal(await rdapCountry('acme.com', { fetchFn }), 'US');
  assert.equal(calls.length, 2, 'one registry hop + one registrar hop');
});

test('two-hop still skips a privacy-proxy registrant at the registrar (-> null)', async () => {
  const fetchFn = async (url) =>
    url.includes('rdap.org')
      ? { ok: true, json: async () => thinRegistry }
      : { ok: true, json: async () => registrarReg([['fn', {}, 'text', 'Registration Private'], ['org', {}, 'text', 'Domains By Proxy, LLC'], ['adr', { cc: 'US' }, 'text', ['', '', '', '', '', '', 'United States']]]) };
  assert.equal(await rdapCountry('acme.com', { fetchFn }), null);
});

test('rdapCountry does not make a second hop when the first response already has a country', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => registrarReg([['adr', { cc: 'DE' }, 'text', ['', '', '', '', '', '', 'Germany']]]) }; };
  assert.equal(await rdapCountry('acme.de', { fetchFn }), 'DE');
  assert.equal(calls, 1);
});
