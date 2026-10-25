import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpf, parseDmarc, checkDomain, parseAuthResults } from '../src/core/authrecords.js';

test('parseSpf finds the policy qualifier', () => {
  assert.equal(parseSpf(['v=spf1 include:_spf.google.com ~all']).found, true);
  assert.equal(parseSpf(['v=spf1 include:_spf.google.com ~all']).all, '~all');
  assert.equal(parseSpf(['v=spf1 -all']).all, '-all');
  assert.equal(parseSpf(['something else']).found, false);
});

test('parseDmarc extracts the policy', () => {
  assert.equal(parseDmarc(['v=DMARC1; p=reject; pct=100']).policy, 'reject');
  assert.equal(parseDmarc(['v=DMARC1; p=none']).policy, 'none');
  assert.equal(parseDmarc(['v=DMARC1; p=quarantine; pct=50']).pct, 50);
  assert.equal(parseDmarc(['nope']).found, false);
});

test('checkDomain resolves SPF and DMARC via the injected resolver', async () => {
  const resolveTxt = async (name) => {
    if (name === 'acme.com') return [['v=spf1 include:_spf.google.com -all']];
    if (name === '_dmarc.acme.com') return [['v=DMARC1; p=quarantine']];
    throw new Error('ENOTFOUND');
  };
  const r = await checkDomain('acme.com', { resolveTxt });
  assert.equal(r.spf.found, true);
  assert.equal(r.spf.all, '-all');
  assert.equal(r.dmarc.found, true);
  assert.equal(r.dmarc.policy, 'quarantine');
});

test('checkDomain reports not-found when records are missing', async () => {
  const resolveTxt = async () => {
    throw new Error('ENOTFOUND');
  };
  const r = await checkDomain('nope.com', { resolveTxt });
  assert.equal(r.spf.found, false);
  assert.equal(r.dmarc.found, false);
});

test('parseAuthResults reads spf/dkim/dmarc verdicts as the receiver evaluated them', () => {
  const header = 'mx.google.com; spf=pass smtp.mailfrom=u@acme.com; dkim=pass header.d=acme.com; dmarc=pass';
  const r = parseAuthResults(header);
  assert.equal(r.spf, 'pass');
  assert.equal(r.dkim, 'pass');
  assert.equal(r.dmarc, 'pass');
});

test('parseAuthResults handles fail/absent verdicts', () => {
  const r = parseAuthResults('mx.google.com; spf=softfail; dkim=fail');
  assert.equal(r.spf, 'softfail');
  assert.equal(r.dkim, 'fail');
  assert.equal(r.dmarc, null);
});
