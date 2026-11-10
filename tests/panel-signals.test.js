import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPanelBlock } from '../src/core/panel-signals.js';

test('Cloudflare / WAF challenge is detected as blocked', () => {
  assert.equal(detectPanelBlock({ statusCode: 403, headers: { 'cf-ray': 'abc123' }, body: '' }).status, 'blocked');
  assert.equal(detectPanelBlock({ statusCode: 503, body: '<title>Just a moment...</title> challenge-platform' }).status, 'blocked');
  assert.match(detectPanelBlock({ statusCode: 403, body: 'Attention Required! | Cloudflare' }).detail, /WAF|Cloudflare/i);
});

test('rate limiting is detected as blocked', () => {
  assert.equal(detectPanelBlock({ statusCode: 429, body: '' }).status, 'blocked');
  assert.equal(detectPanelBlock({ statusCode: 200, body: 'Too many login attempts, please try again later' }).status, 'blocked');
});

test('cPHulk / brute-force lockout is detected as blocked', () => {
  assert.equal(detectPanelBlock({ statusCode: 200, body: 'Login blocked by cPHulk Brute Force Protection' }).status, 'blocked');
  assert.equal(detectPanelBlock({ statusCode: 200, body: 'This account is temporarily locked' }).status, 'blocked');
});

test('a normal login response is NOT flagged as blocked (returns null)', () => {
  assert.equal(detectPanelBlock({ statusCode: 200, body: '{"status":1}' }), null);
  assert.equal(detectPanelBlock({ statusCode: 302, headers: { location: '/cpsess123/' }, body: '' }), null);
  assert.equal(detectPanelBlock({ statusCode: 200, body: 'invalid username or password' }), null);
  assert.equal(detectPanelBlock(null), null);
});
