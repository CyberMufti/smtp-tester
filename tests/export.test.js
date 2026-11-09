import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWorkingTxt, toConfirmedTxt } from '../src/core/export.js';
import { parse } from '../src/core/parser.js';

function result(status, cred, usedHost, usedPort) {
  return { status, cred, usedHost, usedPort };
}

const SAMPLE = [
  result('inbox', { host: 'smtp.gmail.com', port: 587, user: 'a@gmail.com', pass: 'p1' }, 'smtp.gmail.com', 587),
  result('spam', { host: 'smtp.x.com', port: 587, user: 'b@x.com', pass: 'p2' }, 'smtp.x.com', 587),
  result('valid', { host: 'smtp.y.com', port: 465, user: 'c@y.com', pass: 'p3' }, 'smtp.y.com', 465),
  result('dead', { host: 'dead.com', port: 587, user: 'd@dead.com', pass: 'p4' }, null, null),
  // host-less credential whose endpoint was detected
  result('valid', { host: null, port: null, user: 'e@gmail.com', pass: 'p5' }, 'smtp.gmail.com', 587),
];

test('excludes dead results and groups the rest by status', () => {
  const txt = toWorkingTxt(SAMPLE, { generatedAt: '2026-10-25' });
  assert.ok(!txt.includes('dead.com'), 'dead credential must not be written');
  assert.ok(/# === INBOX \(1\) ===/.test(txt));
  assert.ok(/# === SPAM \(1\) ===/.test(txt));
  assert.ok(/# === VALID \/ SENT \(2\) ===/.test(txt));
});

test('toConfirmedTxt writes ONLY inbox+spam credentials as host:port:user:pass', () => {
  const txt = toConfirmedTxt(SAMPLE, {});
  // Confirmed-delivered only: inbox + spam.
  assert.ok(txt.includes('smtp.gmail.com:587:a@gmail.com:p1'), 'inbox credential present');
  assert.ok(txt.includes('smtp.x.com:587:b@x.com:p2'), 'spam credential present');
  // Accepted-but-unconfirmed and dead must NOT appear.
  assert.ok(!txt.includes('c@y.com'), 'valid (accepted, unconfirmed) must be excluded');
  assert.ok(!txt.includes('e@gmail.com'), 'valid host-less must be excluded');
  assert.ok(!txt.includes('dead.com'), 'dead must be excluded');
});

test('toConfirmedTxt output is re-importable: exactly the 2 confirmed creds', () => {
  const { records, errors } = parse(toConfirmedTxt(SAMPLE, {}));
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.user).sort(), ['a@gmail.com', 'b@x.com']);
});

test('toConfirmedTxt is empty of credentials when nothing was confirmed', () => {
  const noneConfirmed = [
    result('valid', { host: 'smtp.y.com', port: 465, user: 'c@y.com', pass: 'p3' }, 'smtp.y.com', 465),
    result('dead', { host: 'dead.com', port: 587, user: 'd@dead.com', pass: 'p4' }, null, null),
  ];
  const { records } = parse(toConfirmedTxt(noneConfirmed, {}));
  assert.equal(records.length, 0);
});

test('writes the detected working host:port for a host-less credential', () => {
  const txt = toWorkingTxt(SAMPLE, {});
  assert.ok(txt.includes('smtp.gmail.com:587:e@gmail.com:p5'));
});

test('output is re-importable by the parser (comments ignored, 4 working creds)', () => {
  const txt = toWorkingTxt(SAMPLE, {});
  const { records, errors } = parse(txt);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.host && r.port && r.user && r.pass));
});

test('round-trips a password whose last colon-segment looks like an email', () => {
  const results = [
    result('valid', { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'x:admin@foo.com' }, 'smtp.x.com', 587),
  ];
  const txt = toWorkingTxt(results, {});
  const { records, errors } = parse(txt);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].pass, 'x:admin@foo.com');
  assert.equal(records[0].user, 'u@x.com');
  assert.equal(records[0].from, undefined);
});

test('round-trips a password containing a comma', () => {
  const results = [
    result('valid', { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'a,b:c' }, 'smtp.x.com', 587),
  ];
  const { records } = parse(toWorkingTxt(results, {}));
  assert.equal(records[0].pass, 'a,b:c');
});

test('empty when there are no working results', () => {
  const txt = toWorkingTxt([result('dead', { host: 'x', port: 1, user: 'u', pass: 'p' }, null, null)], {});
  const { records } = parse(txt);
  assert.equal(records.length, 0);
});

test('hostGroupKey maps hosts to their registrable domain', async () => {
  const { hostGroupKey } = await import('../src/core/export.js');
  assert.equal(hostGroupKey('smtp.gmail.com'), 'gmail.com');
  assert.equal(hostGroupKey('smtp.mail.yahoo.com'), 'yahoo.com');
  assert.equal(hostGroupKey('smtp.office365.com'), 'office365.com');
  assert.equal(hostGroupKey('mail.acme.co.uk'), 'acme.co.uk');
  assert.equal(hostGroupKey('203.0.113.4'), '203.0.113.4'); // IP groups under itself
  assert.equal(hostGroupKey(''), 'unknown');
  assert.equal(hostGroupKey(null), 'unknown');
});

test('hostGroupedExportFiles groups working SMTPs by host and separates unverified', async () => {
  const { hostGroupedExportFiles } = await import('../src/core/export.js');
  const rows = [
    result('valid', { host: null, port: null, user: 'a@gmail.com', pass: 'p1' }, 'smtp.gmail.com', 587),
    result('inbox', { host: null, port: null, user: 'b@gmail.com', pass: 'p2' }, 'smtp.gmail.com', 587),
    result('valid', { host: 'smtp.mail.yahoo.com', port: 465, user: 'c@yahoo.com', pass: 'p3' }, 'smtp.mail.yahoo.com', 465),
    result('unverified', { host: 'smtp.gmail.com', port: 587, user: 'd@gmail.com', pass: 'p4' }, 'smtp.gmail.com', 587),
    result('valid', { host: null, port: null, user: 'e', pass: 'p5' }, null, null), // no host -> unknown
    result('dead', { host: 'x.com', port: 587, user: 'f@x.com', pass: 'p6' }, null, null),
  ];
  const files = hostGroupedExportFiles(rows);
  assert.deepEqual(files['valid/gmail.com.txt'], ['smtp.gmail.com:587:a@gmail.com:p1', 'smtp.gmail.com:587:b@gmail.com:p2']);
  assert.deepEqual(files['valid/yahoo.com.txt'], ['smtp.mail.yahoo.com:465:c@yahoo.com:p3']);
  assert.deepEqual(files['unverified/gmail.com.txt'], ['smtp.gmail.com:587:d@gmail.com:p4']);
  assert.ok(files['valid/unknown.txt']); // host-less working cred
  // unverified never lands in a valid-by-host file
  assert.ok(!files['valid/gmail.com.txt'].some((l) => l.includes('d@gmail.com')));
  // dead excluded entirely
  assert.ok(!Object.values(files).some((arr) => arr.some((l) => l.includes('f@x.com'))));
});
