// Integration test: run auditServer's real socket dialogue against a live
// smtp-server configured insecurely (AUTH advertised, STARTTLS disabled) and
// confirm it reports the cleartext-auth and missing-STARTTLS findings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { auditServer } from '../src/core/authaudit.js';

function startInsecureServer() {
  return new Promise((resolve) => {
    const server = new SMTPServer({
      authOptional: false,
      disabledCommands: ['STARTTLS'], // no way to go secure — AUTH is on cleartext
      onAuth(_auth, _session, cb) {
        cb(new Error('audit does not authenticate'));
      },
      onData(stream, _session, cb) {
        stream.on('data', () => {});
        stream.on('end', cb);
      },
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.server.address().port }));
  });
}

let ctx;
before(async () => {
  ctx = await startInsecureServer();
});
after(() => ctx.server.close());

test('auditServer reports cleartext-auth and missing STARTTLS against an insecure server', async () => {
  const report = await auditServer({ host: '127.0.0.1', port: ctx.port, connectTimeout: 3000 });
  const ids = report.findings.map((f) => f.id);
  assert.ok(ids.includes('cleartext-auth'), `expected cleartext-auth, got ${ids.join(', ')}`);
  assert.ok(ids.includes('no-starttls'), `expected no-starttls, got ${ids.join(', ')}`);
  assert.ok(report.mechs.includes('LOGIN') || report.mechs.includes('PLAIN'), 'should see basic-auth mechs');
});
