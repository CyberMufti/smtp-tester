import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverLocationMeaningful } from '../src/core/provider-class.js';

test('hosting providers: server GeoIP is a meaningful country signal', () => {
  // US-datacenter resellers: the server GeoIP correctly reports US for US
  // customers, so it stays a meaningful lead-country signal.
  // Excluded (server location NOT meaningful): Rackspace (shared US/UK hosts) and
  // IONOS / OVH (European datacenters) — covered in the next test.
  for (const p of ['GoDaddy', 'Namecheap', 'Network Solutions',
                   'HostGator', 'Bluehost', 'cPanel/Exim', 'Zimbra', 'Postfix', 'Other']) {
    assert.equal(serverLocationMeaningful(p), true, p);
  }
});

test('global anycast platforms: server GeoIP is the datacenter, NOT meaningful', () => {
  for (const p of ['Gmail', 'Google Workspace', 'Microsoft 365', 'Outlook/Hotmail', 'Yahoo/AOL',
                   'Alibaba Mail', 'NetEase', 'Tencent Exmail', 'Zoho', 'iCloud', 'Proton Mail',
                   'Mimecast', 'Proofpoint', 'Rackspace', 'IONOS', 'OVH']) {
    assert.equal(serverLocationMeaningful(p), false, p);
  }
});
