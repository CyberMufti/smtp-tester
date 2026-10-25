import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reverseIp, queryName, checkIp, DEFAULT_ZONES } from '../src/core/dnsbl.js';

test('reverseIp reverses the octets', () => {
  assert.equal(reverseIp('1.2.3.4'), '4.3.2.1');
});

test('queryName builds the DNSBL lookup name', () => {
  assert.equal(queryName('1.2.3.4', 'zen.spamhaus.org'), '4.3.2.1.zen.spamhaus.org');
});

test('checkIp reports the zones that list the IP', async () => {
  const resolve4 = async (name) => {
    // Spamhaus "lists" it (returns a 127.0.0.x code); the others do not.
    if (name.endsWith('zen.spamhaus.org')) return ['127.0.0.2'];
    throw new Error('ENOTFOUND');
  };
  const r = await checkIp('1.2.3.4', { resolve4 }, ['zen.spamhaus.org', 'bl.spamcop.net']);
  assert.equal(r.listed, true);
  assert.deepEqual(r.lists, ['zen.spamhaus.org']);
});

test('checkIp reports clean when no zone lists the IP', async () => {
  const resolve4 = async () => {
    throw new Error('ENOTFOUND');
  };
  const r = await checkIp('8.8.8.8', { resolve4 }, ['zen.spamhaus.org']);
  assert.equal(r.listed, false);
  assert.deepEqual(r.lists, []);
});

test('checkIp returns an error field for a non-IPv4 input and does not throw', async () => {
  const resolve4 = async () => ['127.0.0.2'];
  const r = await checkIp('not-an-ip', { resolve4 });
  assert.equal(r.listed, false);
  assert.ok(r.error);
});

test('DEFAULT_ZONES includes Spamhaus', () => {
  assert.ok(DEFAULT_ZONES.includes('zen.spamhaus.org'));
});
