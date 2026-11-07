import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { verify, send, buildProxyUrl, buildAuth } from '../src/core/smtp.js';

test('buildAuth uses password auth when no OAuth payload is present', () => {
  const a = buildAuth({ user: 'u@example.com', pass: 'secret' });
  assert.deepEqual(a, { user: 'u@example.com', pass: 'secret' });
});

test('buildAuth builds an XOAUTH2 auth from a ready access token', () => {
  const a = buildAuth({ user: 'u@example.com', pass: 'ignored', oauth: { accessToken: 'ya29.abc' } });
  assert.equal(a.type, 'OAuth2');
  assert.equal(a.user, 'u@example.com');
  assert.equal(a.accessToken, 'ya29.abc');
  assert.equal(a.pass, undefined); // password is not used in OAuth mode
});

test('buildAuth builds an XOAUTH2 auth from a refresh-token set', () => {
  const a = buildAuth({
    user: 'u@example.com',
    oauth: { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt', accessUrl: 'https://oauth2.example/token' },
  });
  assert.equal(a.type, 'OAuth2');
  assert.deepEqual(
    { clientId: a.clientId, clientSecret: a.clientSecret, refreshToken: a.refreshToken, accessUrl: a.accessUrl },
    { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt', accessUrl: 'https://oauth2.example/token' },
  );
});

test('buildAuth falls back to password when oauth has neither token', () => {
  const a = buildAuth({ user: 'u@example.com', pass: 'secret', oauth: { clientId: 'cid' } });
  assert.deepEqual(a, { user: 'u@example.com', pass: 'secret' });
});

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

test('buildProxyUrl builds a socks5 URL, with and without credentials', () => {
  assert.equal(buildProxyUrl({ host: '1.2.3.4', port: 1080 }), 'socks5://1.2.3.4:1080');
  assert.equal(
    buildProxyUrl({ host: 'proxy.example.com', port: 1080, user: 'u', pass: 'p' }),
    'socks5://u:p@proxy.example.com:1080',
  );
  // special characters in credentials are URL-encoded
  assert.equal(
    buildProxyUrl({ host: 'h', port: 1080, user: 'a@b', pass: 'p:s@w' }),
    'socks5://a%40b:p%3As%40w@h:1080',
  );
  assert.equal(buildProxyUrl({ host: '', port: 1080 }), null);
  assert.equal(buildProxyUrl(null), null);
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
