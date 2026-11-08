import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyImapReply, classifyPop3Reply, verifyImap, verifyPop3 } from '../src/core/mail-extra.js';

test('IMAP: a1 OK = valid', () => {
  const r = classifyImapReply('a1 OK LOGIN completed');
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
});

test('IMAP: a1 NO = invalid', () => {
  const r = classifyImapReply('a1 NO [AUTHENTICATIONFAILED] Invalid credentials');
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('IMAP: a1 BAD = invalid', () => {
  const r = classifyImapReply('a1 BAD Could not parse');
  assert.equal(r.status, 'invalid');
});

test('IMAP: BYE = lockout signal', () => {
  const r = classifyImapReply('* BYE too many failed logins');
  assert.equal(r.status, 'invalid');
});

test('POP3: +OK = valid', () => {
  const r = classifyPop3Reply('+OK Mailbox open');
  assert.equal(r.valid, true);
});

test('POP3: -ERR = invalid', () => {
  const r = classifyPop3Reply('-ERR invalid password');
  assert.equal(r.reachable, true);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid');
});

test('verifyImap: no host is unreachable without connecting', async () => {
  let called = false;
  const r = await verifyImap({ host: '', user: 'u', pass: 'p' }, { connect: async () => { called = true; return {}; } });
  assert.equal(r.status, 'unreachable');
  assert.equal(called, false);
});

test('verifyImap: default port 993', async () => {
  let seenPort;
  await verifyImap({ host: 'h', user: 'u', pass: 'p' }, { connect: async (o) => { seenPort = o.port; return { reachable: true, valid: true, status: 'valid' }; } });
  assert.equal(seenPort, 993);
});

test('verifyPop3: no host is unreachable', async () => {
  const r = await verifyPop3({ host: '', user: 'u', pass: 'p' });
  assert.equal(r.status, 'unreachable');
});

test('verifyPop3: default port 995', async () => {
  let seenPort;
  await verifyPop3({ host: 'h', user: 'u', pass: 'p' }, { connect: async (o) => { seenPort = o.port; return { reachable: true, valid: true, status: 'valid' }; } });
  assert.equal(seenPort, 995);
});
