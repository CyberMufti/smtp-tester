import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submissionFromMx, candidatesFor } from '../src/core/providers.js';
import { classifyProvider, serverLocationMeaningful } from '../src/core/provider-class.js';

// #1 — Rackspace email-only creds must be tried against the submission server,
// not the MX host (which rejects submission AUTH and reads as "dead").
test('submissionFromMx maps Rackspace MX to secure.emailsrvr.com', () => {
  const sub = submissionFromMx(['mx1.emailsrvr.com', 'mx2.emailsrvr.com']);
  assert.ok(sub, 'Rackspace MX should resolve to a submission endpoint');
  assert.equal(sub.host, 'secure.emailsrvr.com');
  assert.ok(sub.ports.includes(587) || sub.ports.includes(465));
});

test('candidatesFor tries the Rackspace submission server before the raw MX host', () => {
  const cands = candidatesFor(
    { user: 'amy@gorsline.com', pass: 'x' },
    { mxHosts: ['mx1.emailsrvr.com'], discovered: [] },
  );
  const submissionIdx = cands.findIndex((c) => c.host === 'secure.emailsrvr.com');
  const rawMxIdx = cands.findIndex((c) => c.host === 'mx1.emailsrvr.com');
  assert.ok(submissionIdx >= 0, 'secure.emailsrvr.com must be a candidate');
  assert.ok(submissionIdx < rawMxIdx, 'submission server must be tried before the MX host');
});

// #2 — Rackspace is a shared multi-datacenter platform, so its server GeoIP is
// NOT a meaningful lead-country signal (it was wrongly treated as one).
test('Rackspace is a global-edge provider (server GeoIP is not the lead country)', () => {
  assert.equal(serverLocationMeaningful('Rackspace'), false);
});

// #3 — the emailsrvr MX signal classifies as Rackspace (control: still works).
test('classifyProvider identifies Rackspace from emailsrvr MX', () => {
  assert.equal(classifyProvider({ user: 'amy@gorsline.com', mxHosts: ['mx1.emailsrvr.com'] }), 'Rackspace');
});
