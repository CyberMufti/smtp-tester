import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hwidFromSeed, normalizeHwid } from '../src/core/hwid.js';

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

test('normalizeHwid accepts a valid HWID (any case/whitespace) and rejects junk', () => {
  assert.equal(normalizeHwid('16da-426b-8dea-32ba-1a4f-939a'), '16DA-426B-8DEA-32BA-1A4F-939A');
  assert.equal(normalizeHwid('  16DA-426B-8DEA-32BA-1A4F-939A  '), '16DA-426B-8DEA-32BA-1A4F-939A');
  assert.equal(normalizeHwid('hello there'), null);
  assert.equal(normalizeHwid('16DA-426B'), null);
  assert.equal(normalizeHwid(''), null);
});
