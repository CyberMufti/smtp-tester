import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credKey, monitorDiff } from '../src/core/monitor.js';

test('credKey is stable and case-insensitive', () => {
  assert.equal(
    credKey({ host: 'Smtp.X.com', port: 587, user: 'U@x.com', pass: 'P' }),
    credKey({ host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p' }),
  );
});

test('monitorDiff flags a credential that was live and is now dead', () => {
  const prev = {
    [credKey({ host: 'a', port: 1, user: 'u1', pass: 'p' })]: 'inbox',
    [credKey({ host: 'b', port: 1, user: 'u2', pass: 'p' })]: 'valid',
  };
  const results = [
    { cred: { host: 'a', port: 1, user: 'u1', pass: 'p' }, status: 'dead' },
    { cred: { host: 'b', port: 1, user: 'u2', pass: 'p' }, status: 'valid' },
  ];
  const { died, newMap } = monitorDiff(prev, results);
  assert.equal(died.length, 1);
  assert.equal(died[0].cred.user, 'u1');
  assert.equal(newMap[credKey({ host: 'a', port: 1, user: 'u1', pass: 'p' })], 'dead');
});

test('monitorDiff does not alert on a first-seen dead credential', () => {
  const results = [{ cred: { host: 'a', port: 1, user: 'u', pass: 'p' }, status: 'dead' }];
  const { died } = monitorDiff({}, results);
  assert.equal(died.length, 0);
});

test('monitorDiff treats unknown-placement (sent) as live, so a later dead alerts', () => {
  const key = credKey({ host: 'a', port: 1, user: 'u', pass: 'p' });
  const { died } = monitorDiff({ [key]: 'unknown' }, [
    { cred: { host: 'a', port: 1, user: 'u', pass: 'p' }, status: 'dead' },
  ]);
  assert.equal(died.length, 1);
});

test('monitorDiff does not alert dead->dead', () => {
  const key = credKey({ host: 'a', port: 1, user: 'u', pass: 'p' });
  const { died } = monitorDiff({ [key]: 'dead' }, [
    { cred: { host: 'a', port: 1, user: 'u', pass: 'p' }, status: 'dead' },
  ]);
  assert.equal(died.length, 0);
});
