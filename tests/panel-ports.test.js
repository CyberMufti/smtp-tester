import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelScheme } from '../src/core/panel-ports.js';

test('plain cPanel/WHM/Webmail ports map to http', () => {
  assert.equal(panelScheme(2082), 'http');  // cPanel plain
  assert.equal(panelScheme(2086), 'http');  // WHM plain
  assert.equal(panelScheme(2095), 'http');  // Webmail plain
  assert.equal(panelScheme(80), 'http');
});
test('TLS panel ports map to https', () => {
  assert.equal(panelScheme(2083), 'https'); // cPanel TLS
  assert.equal(panelScheme(2087), 'https'); // WHM TLS
  assert.equal(panelScheme(2096), 'https'); // Webmail TLS
  assert.equal(panelScheme(8443), 'https');
  assert.equal(panelScheme(443), 'https');
});
test('unknown ports default to https', () => {
  assert.equal(panelScheme(12345), 'https');
});
