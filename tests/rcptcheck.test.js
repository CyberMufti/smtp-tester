import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { classifyRcptResponse, classifyWithBaseline, verifyRecipient } from '../src/core/rcptcheck.js';

test('classifyRcptResponse: 250/251 accepted -> exists', () => {
  assert.equal(classifyRcptResponse(250).exists, true);
  assert.equal(classifyRcptResponse(251).exists, true);
});

test('classifyRcptResponse: 550 user unknown -> not exists', () => {
  assert.equal(classifyRcptResponse(550, '550 5.1.1 user unknown').exists, false);
  assert.equal(classifyRcptResponse(550, '550 No such user here').exists, false);
  assert.equal(classifyRcptResponse(550).exists, false); // bare 550 -> unknown recipient
});

test('classifyRcptResponse: 550 relay/policy -> inconclusive, not a false negative', () => {
  assert.equal(classifyRcptResponse(550, '550 5.7.1 Relaying denied').exists, null);
  assert.equal(classifyRcptResponse(554, '554 5.7.1 Message blocked by policy').exists, null);
});

test('classifyRcptResponse: 252 and 4xx -> inconclusive (null)', () => {
  assert.equal(classifyRcptResponse(252).exists, null);
  assert.equal(classifyRcptResponse(451, '451 greylisted, try later').exists, null);
  assert.equal(classifyRcptResponse(421).exists, null);
});

// --- integration: a real SMTP server that only knows "known@test" ---
function startServer() {
  return new Promise((resolve) => {
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onRcptTo(addr, _session, cb) {
        if (addr.address.toLowerCase() === 'known@test') return cb();
        const err = new Error('550 5.1.1 <' + addr.address + '>: Recipient address rejected: User unknown');
        err.responseCode = 550;
        return cb(err);
      },
      onMailFrom(_addr, _session, cb) {
        cb();
      },
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.server.address().port }));
  });
}

test('verifyRecipient: a known mailbox is accepted (exists:true)', async () => {
  const { server, port } = await startServer();
  try {
    const r = await verifyRecipient('known@test', { host: '127.0.0.1', port, timeout: 4000 });
    assert.equal(r.exists, true);
    assert.equal(r.code, 250);
  } finally {
    server.close();
  }
});

test('verifyRecipient: an unknown mailbox is rejected (exists:false)', async () => {
  const { server, port } = await startServer();
  try {
    const r = await verifyRecipient('nobody@test', { host: '127.0.0.1', port, timeout: 4000 });
    assert.equal(r.exists, false);
    assert.equal(r.code, 550);
  } finally {
    server.close();
  }
});

test('verifyRecipient: nothing listening -> inconclusive, never throws', async () => {
  const r = await verifyRecipient('x@test', { host: '127.0.0.1', port: 1, timeout: 1500 });
  assert.equal(r.exists, null);
  assert.equal(r.code, null);
});

test('verifyRecipient: no host -> inconclusive', async () => {
  const r = await verifyRecipient('x@test', {});
  assert.equal(r.exists, null);
  assert.match(r.reason, /no host/i);
});

test('classifyWithBaseline: catch-all (baseline accepted) -> inconclusive', () => {
  const r = classifyWithBaseline({ code: 250 }, { code: 250 });
  assert.equal(r.exists, null);
  assert.match(r.reason, /catch-all/i);
});

test('classifyWithBaseline: baseline rejected -> target reply is trusted', () => {
  assert.equal(classifyWithBaseline({ code: 550 }, { code: 250 }).exists, true);
  assert.equal(classifyWithBaseline({ code: 550 }, { code: 550, text: 'user unknown' }).exists, false);
});

function startCatchAllServer() {
  return new Promise((resolve) => {
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onRcptTo(_addr, _session, cb) { cb(); }, // accept everything
      onMailFrom(_addr, _session, cb) { cb(); },
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.server.address().port }));
  });
}

test('verifyRecipient: a catch-all server yields exists:null (not a false positive)', async () => {
  const { server, port } = await startCatchAllServer();
  try {
    const r = await verifyRecipient('anyone@test', { host: '127.0.0.1', port, timeout: 4000 });
    assert.equal(r.exists, null);
    assert.match(r.reason, /catch-all/i);
  } finally {
    server.close();
  }
});
