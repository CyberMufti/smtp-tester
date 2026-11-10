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

test('Intermedia hosted Exchange is recognized (not mistaken for Microsoft 365)', () => {
  assert.equal(mx('a@wildewealth.com', 'east.smtp.mx.o365.serverdata.net'), 'Intermedia');
  assert.equal(mx('a@acme.com', 'mx1.intermedia.net'), 'Intermedia');
});

test('security gateways are labeled by the gateway', () => {
  assert.equal(mx('a@acme.com', 'acme-com.mail.protection.outlook.com'), 'Microsoft 365'); // still M365
  assert.equal(mx('a@acme.com', 'us-smtp-inbound-1.mimecast.com'), 'Mimecast');
  assert.equal(mx('a@acme.com', 'mxa-00000000.gslb.pphosted.com'), 'Proofpoint');
  assert.equal(mx('a@acme.com', 'cust00000.in.cloud.barracuda.com'), 'Barracuda');
});

test('major Chinese providers are recognized', () => {
  assert.equal(mx('a@junzejun.com', 'qiye163mx01.mxmail.netease.com'), 'NetEase');
  assert.equal(mx('a@acme.com', 'mxbiz1.qq.com'), 'Tencent Exmail');
  assert.equal(mx('a@acme.cn', 'mxn.mxhichina.com'), 'Alibaba Mail');
  assert.equal(classifyProvider({ user: 'a@163.com' }), 'NetEase');
  assert.equal(classifyProvider({ user: 'a@qq.com' }), 'Tencent Exmail');
});

test('transactional ESPs (Mailgun, Mailjet, Brevo) are recognized from host/MX', () => {
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'smtp.mailgun.org' }), 'Mailgun');
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'in-v3.mailjet.com' }), 'Mailjet');
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'smtp-relay.brevo.com' }), 'Brevo');
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'smtp-relay.sendinblue.com' }), 'Brevo');
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

test('boundary fixes: no substring misclassification (audit regressions)', () => {
  assert.notEqual(mx('a@t-online.de', 'mx00.t-online.de'), 'IONOS');       // t-online != IONOS
  assert.notEqual(mx('a@x.com', 'mx.notgoogle.com'), 'Google Workspace');  // notgoogle != Google
  assert.notEqual(mx('a@x.com', 'ec2-1-2-3-4.compute-1.amazonaws.com'), 'Amazon WorkMail'); // EC2 rDNS
  assert.notEqual(mx('a@x.com', 'mail.0126.com'), 'NetEase');              // 0126 != 126.com
  // real hosts still classify
  assert.equal(mx('a@x.com', 'aspmx.l.google.com'), 'Google Workspace');
  assert.equal(mx('a@x.com', 'inbound-smtp.us-east-1.amazonaws.com'), 'Amazon WorkMail');
  assert.equal(classifyProvider({ user: 'a@126.com' }), 'NetEase');
});
