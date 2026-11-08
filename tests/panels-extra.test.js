import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPleskLogin, classifyDirectAdminLogin, verifyPlesk, verifyDirectAdmin } from '../src/core/panels-extra.js';

test('Plesk: 302 to dashboard = valid', () => {
  const r = classifyPleskLogin({ statusCode: 302, headers: { location: '/admin/dashboard' }, body: '' });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('Plesk: redirect script in body = valid', () => {
  const r = classifyPleskLogin({ statusCode: 200, body: "window.location.href = '/admin/home';" });
  assert.equal(r.valid, true);
});

test('Plesk: "invalid password" = invalid', () => {
  const r = classifyPleskLogin({ statusCode: 200, body: 'Error: invalid username or password' });
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('Plesk: redirect back to login = invalid', () => {
  const r = classifyPleskLogin({ statusCode: 302, headers: { location: '/login_up.php?error=1' }, body: '' });
  assert.equal(r.status, 'invalid');
});

test('Plesk: network error = unreachable', () => {
  assert.equal(classifyPleskLogin({ error: 'ECONNREFUSED' }).status, 'unreachable');
});

test('DirectAdmin: 302 to / with session = valid', () => {
  const r = classifyDirectAdminLogin({ statusCode: 302, headers: { location: '/', 'set-cookie': ['session=abc;'] }, body: '' });
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('DirectAdmin: "invalid login" = invalid', () => {
  const r = classifyDirectAdminLogin({ statusCode: 200, body: '<div>Invalid login. Please verify your username and password.</div>' });
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('DirectAdmin: network error = unreachable', () => {
  assert.equal(classifyDirectAdminLogin({ error: 'timeout' }).status, 'unreachable');
});

test('verifyPlesk uses port 8443 by default', async () => {
  // Just test the no-host shortcut path
  const r = await verifyPlesk({ host: '', user: 'u', pass: 'p' });
  assert.equal(r.status, 'unreachable');
  assert.equal(r.port, 8443);
});

test('verifyDirectAdmin uses port 2222 by default', async () => {
  const r = await verifyDirectAdmin({ host: '', user: 'u', pass: 'p' });
  assert.equal(r.status, 'unreachable');
  assert.equal(r.port, 2222);
});
