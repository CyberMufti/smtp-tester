import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverLocationMeaningful } from '../src/core/provider-class.js';

test('self-hosted software: server GeoIP is a meaningful country signal', () => {
  // The server is plausibly the customer's own machine in their own country.
  for (const p of ['Postfix', 'cPanel/Exim', 'Zimbra', 'Microsoft Exchange']) {
    assert.equal(serverLocationMeaningful(p), true, p);
  }
});

test('SaaS/reseller platforms: server GeoIP is the datacenter, NOT meaningful', () => {
  // Shared, centralized, often foreign datacenters — the server country is the
  // datacenter's, not the lead's. Includes recognized US-datacenter resellers:
  // their server IP is reliable, but the policy is to show the lead country only
  // from the domain/provider, keeping the datacenter as a separate badge.
  for (const p of ['Gmail', 'Google Workspace', 'Microsoft 365', 'Outlook/Hotmail', 'Yahoo/AOL',
                   'Alibaba Mail', 'NetEase', 'Tencent Exmail', 'Zoho', 'iCloud', 'Proton Mail',
                   'Mimecast', 'Proofpoint', 'Rackspace', 'IONOS', 'OVH',
                   'GoDaddy', 'Namecheap', 'Network Solutions', 'Intermedia', 'HostGator', 'Bluehost']) {
    assert.equal(serverLocationMeaningful(p), false, p);
  }
});

test('unidentified servers: server GeoIP is NOT a trustworthy lead country', () => {
  // Could not identify the provider → the server could be any reseller's
  // datacenter, so its country must not be promoted to the lead's.
  for (const p of ['Other', 'Unknown']) {
    assert.equal(serverLocationMeaningful(p), false, p);
  }
});
