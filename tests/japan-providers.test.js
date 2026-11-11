import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProvider, providerHomeCountry, PROVIDER_BUCKETS } from '../src/core/provider-class.js';

test('Japanese consumer/ISP/carrier domains map to their own bucket (not generic Yahoo/AOL or Other)', () => {
  assert.equal(classifyProvider({ user: 'a@yahoo.co.jp' }), 'Yahoo! Japan');
  assert.notEqual(classifyProvider({ user: 'a@yahoo.co.jp' }), 'Yahoo/AOL');
  assert.equal(classifyProvider({ user: 'a@docomo.ne.jp' }), 'docomo');
  assert.equal(classifyProvider({ user: 'a@softbank.ne.jp' }), 'SoftBank');
  assert.equal(classifyProvider({ user: 'a@ezweb.ne.jp' }), 'au/KDDI');
  assert.equal(classifyProvider({ user: 'a@ocn.ne.jp' }), 'OCN');
  assert.equal(classifyProvider({ user: 'a@nifty.com' }), '@nifty');
  assert.equal(classifyProvider({ user: 'a@biglobe.ne.jp' }), 'BIGLOBE');
  assert.equal(classifyProvider({ user: 'a@so-net.ne.jp' }), 'So-net');
  assert.equal(classifyProvider({ user: 'a@rakuten.co.jp' }), 'Rakuten');
});

test('custom domains on Japanese hosts are recognized from MX/host', () => {
  assert.equal(classifyProvider({ user: 'a@acme.co.jp', mxHosts: ['acme.co.jp.mail.sakura.ne.jp'] }), 'Sakura Internet');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mx.xserver.jp'] }), 'Xserver');
  assert.equal(classifyProvider({ user: 'a@shop.jp', mxHosts: ['mx.lolipop.jp'] }), 'Lolipop');
  assert.equal(classifyProvider({ user: 'a@acme.com', host: 'smtp.heteml.jp' }), 'GMO');
  assert.equal(classifyProvider({ user: 'a@acme.com', mxHosts: ['mail.onamae.com'] }), 'GMO');
});

test('a custom domain whose MX is Yahoo! JAPAN is not mistaken for US Yahoo/AOL', () => {
  assert.equal(classifyProvider({ user: 'a@acme.jp', mxHosts: ['mx1.mail.yahoo.co.jp'] }), 'Yahoo! Japan');
});

test('Japanese providers report Japan as the home country (fixes .com/.net with no ccTLD)', () => {
  for (const b of ['Yahoo! Japan', 'docomo', 'au/KDDI', 'SoftBank', 'OCN', '@nifty',
                   'BIGLOBE', 'So-net', 'Rakuten', 'Sakura Internet', 'Xserver', 'Lolipop', 'GMO']) {
    assert.equal(providerHomeCountry(b), 'Japan', b);
  }
});

test('every Japanese bucket is a declared PROVIDER_BUCKET', () => {
  for (const b of ['Yahoo! Japan', 'docomo', 'au/KDDI', 'SoftBank', 'OCN', '@nifty', 'BIGLOBE',
                   'So-net', 'Plala', 'Rakuten', 'J:COM', 'Sakura Internet', 'Xserver', 'Lolipop', 'GMO', 'Asahi Net']) {
    assert.ok(PROVIDER_BUCKETS.includes(b), `missing bucket: ${b}`);
  }
});

test('non-Japanese look-alikes are not swept into Japanese buckets', () => {
  assert.notEqual(classifyProvider({ user: 'a@notnifty.com', host: 'mail.notnifty.com' }), '@nifty');
  assert.notEqual(classifyProvider({ user: 'a@yahoo.com' }), 'Yahoo! Japan'); // US Yahoo stays Yahoo/AOL
  assert.equal(classifyProvider({ user: 'a@yahoo.com' }), 'Yahoo/AOL');
});
