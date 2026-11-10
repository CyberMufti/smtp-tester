import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, PROVIDER_BUCKETS } from '../src/core/provider-class.js';

test('NetEase/Tencent host patterns do not over-match look-alike domains', () => {
  // A hyphenated look-alike must NOT be bucketed as the Chinese provider.
  assert.notEqual(classifyProvider({ user: 'a@my-163.com', host: 'mail.my-163.com', mxHosts: ['mail.my-163.com'] }), 'NetEase');
  assert.notEqual(classifyProvider({ user: 'a@shop-qq.com', host: 'mail.shop-qq.com', mxHosts: ['mail.shop-qq.com'] }), 'Tencent Exmail');
  // The real domains still classify.
  assert.equal(classifyProvider({ user: 'a@163.com', host: 'smtp.163.com', mxHosts: ['smtp.163.com'] }), 'NetEase');
  assert.equal(classifyProvider({ user: 'a@qq.com', host: 'smtp.qq.com', mxHosts: ['smtp.qq.com'] }), 'Tencent Exmail');
});

test('consumer domains map to their bucket by email domain alone', () => {
  assert.equal(classifyProvider({ user: 'a@gmail.com' }), 'Gmail');
  assert.equal(classifyProvider({ user: 'a@googlemail.com' }), 'Gmail');
  assert.equal(classifyProvider({ user: 'a@outlook.com' }), 'Outlook/Hotmail');
  assert.equal(classifyProvider({ user: 'a@hotmail.com' }), 'Outlook/Hotmail');
  assert.equal(classifyProvider({ user: 'a@yahoo.com' }), 'Yahoo/AOL');
  assert.equal(classifyProvider({ user: 'a@aol.com' }), 'Yahoo/AOL');
  assert.equal(classifyProvider({ user: 'a@zoho.com' }), 'Zoho');
});

test('custom domain is classified by its MX platform', () => {
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['aspmx.l.google.com'] }), 'Google Workspace');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['acme-com.mail.protection.outlook.com'] }), 'Microsoft 365');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mx.zoho.com'] }), 'Zoho');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mail.worldnic.com'] }), 'Network Solutions');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['smtp.secureserver.net'] }), 'GoDaddy');
});

test('falls back to the used host when no domain/MX signal resolves it', () => {
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'smtp.office365.com' }), 'Microsoft 365');
  assert.equal(classifyProvider({ host: 'smtp.gmail.com', user: 'a@acme.com' }), 'Google Workspace'); // gmail host, non-gmail domain
  assert.equal(classifyProvider({ host: 'smtp.gmail.com', user: 'a@gmail.com' }), 'Gmail');
});

test('a plain custom mail host with no platform signal is Other; nothing is Unknown', () => {
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'mail.acme.com' }), 'Other');
  assert.equal(classifyProvider({}), 'Unknown');
});

test('every returned label is a declared bucket', () => {
  const samples = [
    { user: 'a@gmail.com' }, { user: 'a@acme.com', mxHosts: ['aspmx.l.google.com'] },
    { user: 'a@acme.com', host: 'mail.acme.com' }, {},
  ];
  for (const s of samples) assert.ok(PROVIDER_BUCKETS.includes(classifyProvider(s)), classifyProvider(s));
});
