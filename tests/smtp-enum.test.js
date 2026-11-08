import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateUser } from '../src/core/smtp-enum.js';

test('enumerateUser: no host returns unknown', async () => {
  const r = await enumerateUser({ user: 'test@domain.com' }, { host: '' });
  assert.equal(r.exists, 'unknown');
});

test('enumerateUser: no user returns unknown', async () => {
  const r = await enumerateUser({ user: '' }, { host: 'mail.test' });
  assert.equal(r.exists, 'unknown');
});
