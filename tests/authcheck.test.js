import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEmailAuth } from '../src/core/authcheck.js';

// A resolver stub standing in for node:dns resolveTxt (returns string[][]).
function fakeResolver(map) {
  return async (name) => {
    if (name in map) return map[name].map((s) => [s]);
    const err = new Error('ENOTFOUND');
    throw err;
  };
}

test('uses the Python sidecar when available and returns its SPF/DKIM/DMARC verdicts', async () => {
  const exec = async (args) => {
    if (args[0] === '--selfcheck') {
      return { code: 0, stdout: JSON.stringify({ available: true, partial: true, missing: [] }), stderr: '' };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        engine: 'python',
        missing: [],
        spf: { found: true, record: 'v=spf1 -all', all: '-all', result: 'pass', explanation: 'sender SPF authorized' },
        dkim: { verified: true, domains: ['example.com'], detail: null },
        dmarc: { found: true, record: 'v=DMARC1; p=reject', policy: 'reject', pct: 100, aligned: true },
      }),
      stderr: '',
    };
  };
  const report = await checkEmailAuth(
    { domain: 'example.com', ip: '203.0.113.4', mailfrom: 'a@example.com', message: 'raw' },
    { resolveTxt: fakeResolver({}), exec },
  );
  assert.equal(report.engine, 'python');
  assert.equal(report.spf.result, 'pass');       // evaluated, not just parsed
  assert.equal(report.dkim.verified, true);        // cryptographically verified
  assert.equal(report.dmarc.aligned, true);
});

test('falls back to the JS checks when the sidecar is unavailable', async () => {
  const exec = async () => ({ code: -1, stdout: '', stderr: 'python3: not found' });
  const resolveTxt = fakeResolver({
    'example.com': ['v=spf1 include:_spf.example.com ~all'],
    '_dmarc.example.com': ['v=DMARC1; p=quarantine; pct=50'],
  });
  const report = await checkEmailAuth({ domain: 'example.com', ip: '203.0.113.4' }, { resolveTxt, exec });

  assert.equal(report.engine, 'js-fallback');
  assert.equal(report.spf.found, true);
  assert.equal(report.spf.all, '~all');
  assert.equal(report.spf.result, null);            // JS can't evaluate SPF
  assert.match(report.spf.explanation, /sidecar/i);
  assert.equal(report.dmarc.policy, 'quarantine');
  assert.equal(report.dmarc.pct, 50);
  assert.equal(report.dkim.verified, null);          // JS can't verify DKIM
  assert.match(report.dkim.detail, /sidecar/i);
});

test('falls back to JS when the sidecar is present but errors on the request', async () => {
  const exec = async (args) => {
    if (args[0] === '--selfcheck') {
      return { code: 0, stdout: JSON.stringify({ available: true, partial: false, missing: [] }), stderr: '' };
    }
    return { code: 2, stdout: '', stderr: 'boom' }; // the check itself fails
  };
  const resolveTxt = fakeResolver({ 'example.com': ['v=spf1 -all'] });
  const report = await checkEmailAuth({ domain: 'example.com' }, { resolveTxt, exec });
  assert.equal(report.engine, 'js-fallback');
  assert.equal(report.spf.all, '-all');
});
