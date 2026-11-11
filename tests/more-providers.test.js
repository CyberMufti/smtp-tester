import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, providerHomeCountry, PROVIDER_BUCKETS } from '../src/core/provider-class.js';

const host = (h, u = 'a@acme.com') => classifyProvider({ user: u, host: h });
const mx = (m, u = 'a@acme.com') => classifyProvider({ user: u, mxHosts: [m] });

test('transactional ESPs are recognized from host/MX', () => {
  assert.equal(host('smtp.sendgrid.net'), 'SendGrid');
  assert.equal(host('email-smtp.us-east-1.amazonaws.com'), 'Amazon SES');
  assert.equal(mx('feedback-smtp.us-east-1.amazonses.com'), 'Amazon SES');
  assert.equal(host('smtp.postmarkapp.com'), 'Postmark');
  assert.equal(mx('acme.com.mtasv.net'), 'Postmark');
  assert.equal(host('smtp.sparkpostmail.com'), 'SparkPost');
  assert.equal(host('smtp.mandrillapp.com'), 'Mandrill');
  assert.equal(mx('acme.mcsv.net'), 'Mailchimp');
  assert.equal(host('mail.smtp2go.com'), 'SMTP2GO');
  assert.equal(host('smtp.elasticemail.com'), 'Elastic Email');
  assert.equal(host('smtp.mailersend.net'), 'MailerSend');
  // regression: the originals still work
  assert.equal(host('smtp.mailgun.org'), 'Mailgun');
  assert.equal(host('in-v3.mailjet.com'), 'Mailjet');
});

test('Amazon SES and WorkMail stay distinct', () => {
  assert.equal(mx('inbound-smtp.us-east-1.amazonaws.com'), 'Amazon WorkMail');
  assert.equal(mx('acme.awsapps.com'), 'Amazon WorkMail');
  assert.equal(host('email-smtp.eu-west-1.amazonaws.com'), 'Amazon SES');
});

test('security gateways: Cisco IronPort / TrendMicro / Forcepoint / Sophos', () => {
  assert.equal(mx('mx.acme.com.iphmx.com'), 'Cisco IronPort');
  assert.equal(mx('acme-com.mail.protection.trendmicro.com'), 'TrendMicro'); // NOT Microsoft 365
  assert.equal(mx('mx.mailcontrol.com'), 'Forcepoint');
  assert.equal(mx('acme.com.inbound.sophos.com'), 'Sophos');
});

test('Microsoft 365 still classifies correctly after the mail.protection tightening', () => {
  assert.equal(mx('acme-com.mail.protection.outlook.com'), 'Microsoft 365');
  assert.equal(host('smtp.office365.com'), 'Microsoft 365');
});

test('major ISPs are recognized and carry their home country', () => {
  assert.equal(classifyProvider({ user: 'a@cox.net' }), 'Cox');
  assert.equal(classifyProvider({ user: 'a@centurylink.net' }), 'CenturyLink');
  assert.equal(classifyProvider({ user: 'a@frontier.com' }), 'Frontier');
  assert.equal(classifyProvider({ user: 'a@earthlink.net' }), 'Earthlink');
  assert.equal(classifyProvider({ user: 'a@t-online.de' }), 'T-Online');
  assert.equal(mx('mx00.t-online.de'), 'T-Online');
  assert.equal(classifyProvider({ user: 'a@bigpond.com' }), 'Telstra');
  assert.equal(classifyProvider({ user: 'a@sky.com' }), 'Sky');
  assert.equal(classifyProvider({ user: 'a@rogers.com' }), 'Rogers');
  assert.equal(classifyProvider({ user: 'a@bell.net' }), 'Bell');

  assert.equal(providerHomeCountry('Cox'), 'United States');
  assert.equal(providerHomeCountry('T-Online'), 'Germany');
  assert.equal(providerHomeCountry('Telstra'), 'Australia');
  assert.equal(providerHomeCountry('Rogers'), 'Canada');
  assert.equal(providerHomeCountry('Sky'), 'United Kingdom');
});

test('all new buckets are declared in PROVIDER_BUCKETS', () => {
  for (const b of ['SendGrid', 'Amazon SES', 'Postmark', 'SparkPost', 'Mandrill', 'Mailchimp',
                   'SMTP2GO', 'Elastic Email', 'MailerSend', 'Cisco IronPort', 'TrendMicro',
                   'Forcepoint', 'Sophos', 'Cox', 'CenturyLink', 'Frontier', 'Earthlink',
                   'T-Online', 'Telstra', 'Sky', 'Virgin Media', 'TalkTalk', 'Rogers', 'Bell', 'Telus', 'Shaw']) {
    assert.ok(PROVIDER_BUCKETS.includes(b), `missing bucket: ${b}`);
  }
});

test('no substring false positives for the new patterns', () => {
  assert.notEqual(mx('mail.notsendgrid.example'), 'SendGrid');
  assert.notEqual(host('mail.mycox.net'), 'Cox');
});
