import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, providerHomeCountry, PROVIDER_BUCKETS } from '../src/core/provider-class.js';
import { detectProvider } from '../src/core/providers.js';

test('Australian ISP/webmail domains map to their own bucket (not generic Other)', () => {
  assert.equal(classifyProvider({ user: 'a@bigpond.com' }), 'Telstra');
  assert.equal(classifyProvider({ user: 'a@bigpond.net.au' }), 'Telstra');
  assert.equal(classifyProvider({ user: 'a@optusnet.com.au' }), 'Optus');
  assert.equal(classifyProvider({ user: 'a@iinet.net.au' }), 'iiNet');
  assert.equal(classifyProvider({ user: 'a@westnet.com.au' }), 'Westnet');
  assert.equal(classifyProvider({ user: 'a@tpg.com.au' }), 'TPG');
  assert.equal(classifyProvider({ user: 'a@internode.on.net' }), 'Internode');
  assert.equal(classifyProvider({ user: 'a@dodo.com.au' }), 'Dodo');
  assert.equal(classifyProvider({ user: 'a@iprimus.com.au' }), 'iPrimus');
  assert.equal(classifyProvider({ user: 'a@ozemail.com.au' }), 'Ozemail');
  assert.equal(classifyProvider({ user: 'a@exetel.com.au' }), 'Exetel');
  assert.equal(classifyProvider({ user: 'a@aussiebroadband.com.au' }), 'Aussie Broadband');
  assert.equal(classifyProvider({ user: 'a@netspace.net.au' }), 'Netspace');
  assert.equal(classifyProvider({ user: 'a@adam.com.au' }), 'Adam Internet');
});

test('custom domains parked on an Australian ISP are recognized from MX/host', () => {
  assert.equal(classifyProvider({ user: 'a@acme.com.au', mxHosts: ['mail.bigpond.com'] }), 'Telstra');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mx.optusnet.com.au'] }), 'Optus');
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'mail.iinet.net.au' }), 'iiNet');
});

test('Australian providers report Australia as the home country (fixes bigpond.com/iinet.com with no .au ccTLD)', () => {
  for (const b of ['Telstra', 'Optus', 'iiNet', 'Westnet', 'TPG', 'Internode', 'Dodo',
                   'iPrimus', 'Ozemail', 'Exetel', 'Aussie Broadband', 'Grapevine',
                   'Netspace', 'Adam Internet']) {
    assert.equal(providerHomeCountry(b), 'Australia', b);
  }
});

test('every Australian bucket is a declared PROVIDER_BUCKET', () => {
  for (const b of ['Telstra', 'Optus', 'iiNet', 'Westnet', 'TPG', 'Internode', 'Dodo',
                   'iPrimus', 'Ozemail', 'Exetel', 'Aussie Broadband', 'Grapevine',
                   'Netspace', 'Adam Internet']) {
    assert.ok(PROVIDER_BUCKETS.includes(b), `missing bucket: ${b}`);
  }
});

test('Australian ISP domains have an SMTP submission endpoint for the tester', () => {
  assert.equal(detectProvider('a@bigpond.com').host, 'smtp.telstra.com');
  assert.equal(detectProvider('a@optusnet.com.au').host, 'mail.optusnet.com.au');
  assert.equal(detectProvider('a@iinet.net.au').host, 'mail.iinet.net.au');
  assert.deepEqual(detectProvider('a@bigpond.com').ports, [465, 587]);
});
