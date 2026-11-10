import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, serverLocationMeaningful } from '../src/core/provider-class.js';

// Regression: the host a credential actually authenticated against is ground
// truth for its SENDING provider and must beat the domain's INBOUND MX. A
// company that receives mail on Microsoft/Google/Yahoo can still send through a
// legacy Rackspace / IONOS SMTP account — classifying by MX mislabeled those
// live credentials as the inbound platform ("Microsoft 365", "Yahoo/AOL").
test('connected host beats a conflicting inbound MX', () => {
  // Rackspace account authenticated to secure.emailsrvr.com; domain receives on M365.
  assert.equal(
    classifyProvider({
      user: 'john@acmecorp.com',
      host: 'secure.emailsrvr.com',
      mxHosts: ['acmecorp-com.mail.protection.outlook.com'],
    }),
    'Rackspace',
  );
  // IONOS account; domain receives on Google Workspace.
  assert.equal(
    classifyProvider({
      user: 'sue@biz.com',
      host: 'smtp.ionos.com',
      mxHosts: ['aspmx.l.google.com'],
    }),
    'IONOS',
  );
  // Rackspace account; domain parked on Yahoo Small Business MX.
  assert.equal(
    classifyProvider({
      user: 'x@foo.com',
      host: 'secure.emailsrvr.com',
      mxHosts: ['mx-biz.mail.am0.yahoodns.net'],
    }),
    'Rackspace',
  );
});

// A vanity host the pattern list does NOT recognize (a CNAME like mail.<domain>)
// must still fall through to the MX signal, so Rackspace-via-vanity-host resolves.
test('an unrecognized vanity host still falls through to the MX platform', () => {
  assert.equal(
    classifyProvider({
      user: 'a@acmecorp.com',
      host: 'mail.acmecorp.com',
      mxHosts: ['mx1.emailsrvr.com'],
    }),
    'Rackspace',
  );
});

// MX-only classification (dead / host-less cred) is unchanged.
test('MX still classifies when no host is present', () => {
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mx1.emailsrvr.com'] }), 'Rackspace');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mx01.ionos.co.uk'] }), 'IONOS');
});

// The lead country comes from the server GeoIP only for self-hosted mail
// software (likely the customer's own machine). Every SaaS/reseller platform —
// IONOS, OVH, Rackspace, and even US-datacenter resellers like Network Solutions
// / Intermedia / GoDaddy — runs shared datacenters, so the server IP is NOT
// promoted to the lead country (it stays a separate "datacenter" badge). This
// stops US creds on foreign-hosted platforms from being labeled Germany/France.
test('reseller platforms do not use server GeoIP as the lead country', () => {
  for (const p of ['IONOS', 'OVH', 'Rackspace', 'Network Solutions', 'Intermedia', 'GoDaddy']) {
    assert.equal(serverLocationMeaningful(p), false, p);
  }
});

test('self-hosted software still uses server GeoIP as the lead country', () => {
  for (const p of ['Postfix', 'cPanel/Exim', 'Zimbra', 'Microsoft Exchange']) {
    assert.equal(serverLocationMeaningful(p), true, p);
  }
});
