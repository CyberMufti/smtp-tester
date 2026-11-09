import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, PROVIDER_BUCKETS } from '../src/core/provider-class.js';

const mx = (user, ...mxHosts) => classifyProvider({ user, mxHosts });

test('IONOS / 1&1 is recognized from its MX', () => {
  assert.equal(mx('a@chudproperty.co.uk', 'mx01.ionos.co.uk'), 'IONOS');
  assert.equal(mx('a@acme.de', 'mx00.kundenserver.de'), 'IONOS');
  assert.equal(mx('a@acme.com', 'mx.perfora.net'), 'IONOS');
});

test('other major mailbox hosts are recognized from MX', () => {
  assert.equal(mx('a@acme.com', 'mx1.ovh.net'), 'OVH');
  assert.equal(mx('a@acme.com', 'mx1.emailsrvr.com'), 'Rackspace');       // Rackspace Email
  assert.equal(mx('a@acme.com', 'mx1.privateemail.com'), 'Namecheap');    // Namecheap Private Email
  assert.equal(mx('a@acme.com', 'mail.protonmail.ch'), 'Proton Mail');
  assert.equal(mx('a@acme.com', 'in1-smtp.messagingengine.com'), 'Fastmail');
  assert.equal(mx('a@acme.com', 'mx.yandex.net'), 'Yandex');
  assert.equal(mx('a@acme.com', 'mxs.mail.ru'), 'Mail.ru');
  assert.equal(mx('a@acme.com', 'gateway.hostgator.com'), 'HostGator');
  assert.equal(mx('a@acme.com', 'mail.titan.email'), 'Titan');
});

test('security gateways are labeled by the gateway', () => {
  assert.equal(mx('a@acme.com', 'acme-com.mail.protection.outlook.com'), 'Microsoft 365'); // still M365
  assert.equal(mx('a@acme.com', 'us-smtp-inbound-1.mimecast.com'), 'Mimecast');
  assert.equal(mx('a@acme.com', 'mxa-00000000.gslb.pphosted.com'), 'Proofpoint');
  assert.equal(mx('a@acme.com', 'cust00000.in.cloud.barracuda.com'), 'Barracuda');
});

test('consumer webmail domains added', () => {
  assert.equal(classifyProvider({ user: 'a@gmx.com' }), 'GMX/Web.de');
  assert.equal(classifyProvider({ user: 'a@web.de' }), 'GMX/Web.de');
  assert.equal(classifyProvider({ user: 'a@proton.me' }), 'Proton Mail');
  assert.equal(classifyProvider({ user: 'a@icloud.com' }), 'iCloud');
  assert.equal(classifyProvider({ user: 'a@yandex.com' }), 'Yandex');
});

test('still "Other" for a genuinely unknown custom host, "Unknown" with no signal', () => {
  assert.equal(classifyProvider({ user: 'a@tiny-local-isp.example', host: 'mail.tiny-local-isp.example' }), 'Other');
  assert.equal(classifyProvider({}), 'Unknown');
});

test('every classification result is a declared bucket', () => {
  const samples = [
    mx('a@x.com', 'mx1.ovh.net'), mx('a@x.com', 'mx01.ionos.co.uk'),
    classifyProvider({ user: 'a@gmx.com' }), classifyProvider({ user: 'a@x.com', host: 'h.unknown' }),
  ];
  for (const s of samples) assert.ok(PROVIDER_BUCKETS.includes(s), s);
});
