import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProxyTier, proxyTierNotice } from '../src/core/proxy-select.js';

const MANUAL = 'socks5://tom:pw@23.142.16.35:65280';

test('selectProxyTier: live manual proxy is primary, pool stays secondary', () => {
  const s = selectProxyTier({ manualUrl: MANUAL, manualAlive: true, hasPool: true });
  assert.deepEqual(s, { proxy: MANUAL, tier: 'manual', usePool: true });
});

test('selectProxyTier: live manual proxy, no pool → manual only', () => {
  const s = selectProxyTier({ manualUrl: MANUAL, manualAlive: true, hasPool: false });
  assert.deepEqual(s, { proxy: MANUAL, tier: 'manual', usePool: false });
});

test('selectProxyTier: dead manual proxy falls through to the pool', () => {
  const s = selectProxyTier({ manualUrl: MANUAL, manualAlive: false, hasPool: true });
  assert.deepEqual(s, { proxy: null, tier: 'pool', usePool: true });
});

test('selectProxyTier: dead manual proxy and empty pool → direct', () => {
  const s = selectProxyTier({ manualUrl: MANUAL, manualAlive: false, hasPool: false });
  assert.deepEqual(s, { proxy: null, tier: 'direct', usePool: false });
});

test('selectProxyTier: no manual proxy (declined) uses pool when present', () => {
  const s = selectProxyTier({ manualUrl: null, manualAlive: false, hasPool: true });
  assert.deepEqual(s, { proxy: null, tier: 'pool', usePool: true });
});

test('proxyTierNotice: quiet when manual proxy is alive', () => {
  assert.equal(proxyTierNotice({ tier: 'manual', proxy: MANUAL }, MANUAL), null);
});

test('proxyTierNotice: quiet when user declined the proxy', () => {
  assert.equal(proxyTierNotice({ tier: 'direct', proxy: null }, null), null);
});

test('proxyTierNotice: reports fall-through to pool and to direct', () => {
  assert.match(proxyTierNotice({ tier: 'pool', proxy: null }, MANUAL), /pool/i);
  assert.match(proxyTierNotice({ tier: 'direct', proxy: null }, MANUAL), /direct/i);
});
