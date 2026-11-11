import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credLineFor, maskCredLine } from '../src/core/cred-line.js';

test('credLineFor uses the endpoint that worked, else the cred host, else the email domain', () => {
  assert.equal(credLineFor({ usedHost: 'smtp.x.com', usedPort: 587, cred: { user: 'a@x.com', pass: 'p' } }), 'smtp.x.com:587:a@x.com:p');
  assert.equal(credLineFor({ cred: { host: 'mail.x.com', port: 465, user: 'a@x.com', pass: 'p' } }), 'mail.x.com:465:a@x.com:p');
  // dead, host-less email:pass -> fall back to the email domain so the line is still useful
  assert.equal(credLineFor({ status: 'dead', cred: { user: 'a@acme.com', pass: 'p' } }), 'acme.com::a@acme.com:p');
});

test('maskCredLine hides the password but keeps host:port:user', () => {
  assert.equal(maskCredLine('smtp.x.com:587:a@x.com:secret'), 'smtp.x.com:587:a@x.com:••••••');
  // a password containing colons is still fully masked
  assert.equal(maskCredLine('h:587:u:a:b:c'), 'h:587:u:•••••');
  // too few fields -> unchanged
  assert.equal(maskCredLine('h:587:u'), 'h:587:u');
});

import { panelLineFor } from '../src/core/cred-line.js';

test('panelLineFor builds host:port:user:pass for a valid panel, null otherwise', () => {
  const r = { usedHost: 'smtp.x.com', cred: { user: 'admin@x.com', pass: 'pw' },
    panels: { cpanel: { valid: true, host: 'x.com', port: 2083 }, whm: { valid: false, port: 2087 } } };
  assert.equal(panelLineFor(r, 'cpanel'), 'x.com:2083:admin@x.com:pw');
  assert.equal(panelLineFor(r, 'whm'), null);
  assert.equal(panelLineFor({ cred: {} }, 'cpanel'), null);
});
