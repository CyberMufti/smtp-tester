import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFromBanner, PROVIDER_BUCKETS } from '../src/core/provider-class.js';

test('recognizes self-hosted mail software from the server banner', () => {
  assert.equal(classifyFromBanner('220 mail.acme.com Zimbra ESMTP ready'), 'Zimbra');
  assert.equal(classifyFromBanner('* OK [CAPABILITY ...] Zimbra IMAP4rev1 server ready'), 'Zimbra');
  assert.equal(classifyFromBanner('220-balder.hostcit.com ESMTP Exim 4.100.1 #2'), 'cPanel/Exim');
  assert.equal(classifyFromBanner('220 mail.acme.com ESMTP Postfix (Ubuntu)'), 'Postfix');
  assert.equal(classifyFromBanner('220 EXCH01.corp.local Microsoft ESMTP MAIL Service ready'), 'Microsoft Exchange');
});

test('Zimbra wins even when its SMTP layer mentions Postfix', () => {
  // Zimbra runs a customized Postfix; the Zimbra marker must take priority.
  assert.equal(classifyFromBanner('220 mail.acme.com Zimbra ESMTP Postfix'), 'Zimbra');
});

test('no recognizable signature returns null', () => {
  assert.equal(classifyFromBanner('220 mail.acme.com ESMTP ready'), null);
  assert.equal(classifyFromBanner(''), null);
  assert.equal(classifyFromBanner(null), null);
});

test('every banner bucket is a declared provider bucket', () => {
  for (const b of ['Zimbra', 'cPanel/Exim', 'Postfix', 'Microsoft Exchange']) {
    assert.ok(PROVIDER_BUCKETS.includes(b), b);
  }
});
