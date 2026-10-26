import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { verify, send, sendViaRelay } from '../src/core/smtp.js';

/** Start an SMTPServer that accepts user "good"/"pass"; return { server, port }. */
function startServer(onData) {
  return new Promise((resolve) => {
    const server = new SMTPServer({
      authOptional: false,
      disabledCommands: ['STARTTLS'],
      onAuth(auth, _session, cb) {
        if (auth.username === 'good' && auth.password === 'pass') return cb(null, { user: 'good' });
        return cb(new Error('Invalid username or password'));
      },
      onData(stream, _session, cb) {
        stream.on('data', () => {});
        stream.on('end', () => {
          if (onData) onData();
          cb();
        });
      },
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.server.address().port }));
  });
}

let ctx;
before(async () => {
  ctx = await startServer();
});
after(() => {
  ctx.server.close();
});

test('verify returns connected+authenticated for good credentials', async () => {
  const res = await verify(
    { host: '127.0.0.1', port: ctx.port, user: 'good', pass: 'pass' },
    { connectTimeout: 3000 },
  );
  assert.equal(res.connected, true);
  assert.equal(res.authenticated, true);
});

test('verify reports authenticated=false on wrong password', async () => {
  const res = await verify(
    { host: '127.0.0.1', port: ctx.port, user: 'good', pass: 'WRONG' },
    { connectTimeout: 3000 },
  );
  assert.equal(res.connected, true);
  assert.equal(res.authenticated, false);
  assert.ok(res.error);
});

test('verify reports connected=false when nothing is listening', async () => {
  // Port 1 is privileged/unused; connection should be refused quickly.
  const res = await verify(
    { host: '127.0.0.1', port: 1, user: 'good', pass: 'pass' },
    { connectTimeout: 3000 },
  );
  assert.equal(res.connected, false);
  assert.ok(res.error);
});

test('sendViaRelay sends with no authentication to an open relay and reports acceptance', async () => {
  // A relay that accepts mail without auth (IP-authorized, like a configured
  // Workspace/365 relay from an allow-listed IP).
  const relay = await new Promise((resolve) => {
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onData(stream, _s, cb) { stream.on('data', () => {}); stream.on('end', cb); },
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.server.address().port }));
  });
  try {
    const res = await sendViaRelay('127.0.0.1', relay.port, {
      to: 'dest@example.com',
      from: 'me@mydomain.com',
      subject: 'relay test',
      text: 'hi',
      connectTimeout: 5000,
    });
    assert.ok(res.accepted.includes('dest@example.com'));
    assert.ok(!res.error);
  } finally {
    relay.server.close();
  }
});

test('send delivers to the accepting server and reports accepted recipient', async () => {
  const res = await send(
    { host: '127.0.0.1', port: ctx.port, user: 'good', pass: 'pass' },
    {
      to: 'seed@example.com',
      from: 'from@example.com',
      subject: 'SMTPTEST-123',
      text: 'token SMTPTEST-123',
      sendTimeout: 5000,
    },
  );
  assert.ok(Array.isArray(res.accepted));
  assert.ok(res.accepted.includes('seed@example.com'));
  assert.ok(!res.error);
});
