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

// Regression: IONOS and OVH run European datacenters, so their mail server's
// GeoIP is the datacenter country, NOT the customer's — US customers were
// wrongly labeled Germany/France. Like Rackspace, their server location is not a
// meaningful lead-country signal. (Network Solutions / Intermedia use US
// datacenters and stay meaningful — those correctly reported US.)
test('IONOS and OVH server GeoIP is the datacenter, NOT the lead country', () => {
  assert.equal(serverLocationMeaningful('IONOS'), false);
  assert.equal(serverLocationMeaningful('OVH'), false);
});

test('US-datacenter resellers keep server GeoIP as a meaningful signal', () => {
  assert.equal(serverLocationMeaningful('Network Solutions'), true);
  assert.equal(serverLocationMeaningful('Intermedia'), true);
  assert.equal(serverLocationMeaningful('GoDaddy'), true);
});
