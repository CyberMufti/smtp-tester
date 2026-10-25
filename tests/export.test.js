import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWorkingTxt } from '../src/core/export.js';
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
