import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countryOf, makeGeoResolver } from '../src/core/geoip.js';

const DEPS = {
  resolve4: async (h) => ({ 'smtp.acme.com': ['1.2.3.4'], 'smtp.de.com': ['5.6.7.8'] }[h] || []),
  lookup: (ip) => ({ '1.2.3.4': 'US', '5.6.7.8': 'DE' }[ip] || null),
};

test('resolves host -> ip -> country code', async () => {
  assert.equal(await countryOf('smtp.acme.com', DEPS), 'US');
  assert.equal(await countryOf('smtp.de.com', DEPS), 'DE');
});

test('an IP literal is looked up directly, without DNS', async () => {
  let resolved = false;
  const deps = { resolve4: async () => { resolved = true; return []; }, lookup: () => 'FR' };
  assert.equal(await countryOf('9.9.9.9', deps), 'FR');
  assert.equal(resolved, false, 'must not DNS-resolve an IP literal');
});

test('unknown/unresolvable host yields "Unknown", never throws', async () => {
  assert.equal(await countryOf('nope.example', DEPS), 'Unknown');       // resolve4 returns []
  assert.equal(await countryOf('smtp.acme.com', { resolve4: async () => { throw new Error('dns'); }, lookup: () => null }), 'Unknown');
  assert.equal(await countryOf('', DEPS), 'Unknown');
});

test('makeGeoResolver caches by host (resolves each host once)', async () => {
  let calls = 0;
  const deps = { resolve4: async () => { calls++; return ['1.2.3.4']; }, lookup: () => 'US' };
  const resolver = makeGeoResolver(deps);
  await resolver('smtp.acme.com');
  await resolver('smtp.acme.com');
  await resolver('smtp.acme.com');
  assert.equal(calls, 1, 'second and third calls served from cache');
});
