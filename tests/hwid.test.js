import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hwidFromSeed } from '../src/core/hwid.js';

test('hwidFromSeed is deterministic for the same seed', () => {
  assert.equal(hwidFromSeed('machine-abc'), hwidFromSeed('machine-abc'));
});

test('hwidFromSeed differs for different seeds', () => {
  assert.notEqual(hwidFromSeed('machine-abc'), hwidFromSeed('machine-xyz'));
});

test('hwidFromSeed is formatted as grouped uppercase hex', () => {
  const id = hwidFromSeed('machine-abc');
  assert.match(id, /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/);
});
