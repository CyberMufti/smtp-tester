import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverLocationMeaningful } from '../src/core/provider-class.js';

test('hosting providers: server GeoIP is a meaningful country signal', () => {
  for (const p of ['IONOS', 'Rackspace', 'GoDaddy', 'Namecheap', 'OVH', 'Network Solutions',
                   'HostGator', 'Bluehost', 'cPanel/Exim', 'Zimbra', 'Postfix', 'Other']) {
    assert.equal(serverLocationMeaningful(p), true, p);
  }
});

test('global anycast platforms: server GeoIP is the datacenter, NOT meaningful', () => {
  for (const p of ['Gmail', 'Google Workspace', 'Microsoft 365', 'Outlook/Hotmail', 'Yahoo/AOL',
                   'Alibaba Mail', 'NetEase', 'Tencent Exmail', 'Zoho', 'iCloud', 'Proton Mail',
                   'Mimecast', 'Proofpoint']) {
    assert.equal(serverLocationMeaningful(p), false, p);
  }
});
