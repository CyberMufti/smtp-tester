import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, providerHomeCountry } from '../src/core/provider-class.js';

test('region-tied providers have a home country', () => {
  assert.equal(providerHomeCountry('Alibaba Mail'), 'China');
  assert.equal(providerHomeCountry('NetEase'), 'China');
  assert.equal(providerHomeCountry('Tencent Exmail'), 'China');
  assert.equal(providerHomeCountry('Yandex'), 'Russia');
  assert.equal(providerHomeCountry('Mail.ru'), 'Russia');
  assert.equal(providerHomeCountry('Optimum'), 'United States');
  assert.equal(providerHomeCountry('Spectrum/RR'), 'United States');
  assert.equal(providerHomeCountry('Mailgun'), 'United States');
  assert.equal(providerHomeCountry('GMX/Web.de'), 'Germany');
});

test('global providers have NO home country (their users are everywhere)', () => {
  for (const g of ['Gmail', 'Google Workspace', 'Microsoft 365', 'Outlook/Hotmail', 'Yahoo/AOL', 'GoDaddy', 'Other', 'Unknown']) {
    assert.equal(providerHomeCountry(g), 'Unknown', g);
  }
});

test('national ISP / webmail providers are recognized with home countries', () => {
  assert.equal(classifyProvider({ user: 'a@naver.com' }), 'Naver');
  assert.equal(providerHomeCountry('Naver'), 'South Korea');
  assert.equal(classifyProvider({ user: 'a@daum.net' }), 'Daum');
  assert.equal(classifyProvider({ user: 'a@uol.com.br' }), 'UOL');
  assert.equal(providerHomeCountry('UOL'), 'Brazil');
  assert.equal(classifyProvider({ user: 'a@comcast.net' }), 'Comcast');
  assert.equal(providerHomeCountry('Comcast'), 'United States');
  assert.equal(classifyProvider({ user: 'a@orange.fr' }), 'Orange');
  assert.equal(providerHomeCountry('Orange'), 'France');
  assert.equal(classifyProvider({ user: 'a@btinternet.com' }), 'BT');
  assert.equal(classifyProvider({ user: 'a@libero.it' }), 'Libero');
  assert.equal(classifyProvider({ user: 'a@seznam.cz' }), 'Seznam');
});

test('new US ISP / ESP providers are recognized', () => {
  assert.equal(classifyProvider({ user: 'a@optimum.net' }), 'Optimum');
  assert.equal(classifyProvider({ user: 'a@optonline.net' }), 'Optimum');
  assert.equal(classifyProvider({ user: 'a@rr.com' }), 'Spectrum/RR');
  assert.equal(classifyProvider({ user: 'a@roadrunner.com' }), 'Spectrum/RR');
  assert.equal(classifyProvider({ user: 'a@charter.net' }), 'Spectrum/RR');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mxa.mailgun.org'] }), 'Mailgun');
});
