import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/core/parser.js';

test('parses colon-delimited host:port:user:pass', () => {
  const { records, errors } = parse('smtp.example.com:587:user@example.com:secret');
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    host: 'smtp.example.com',
    port: 587,
    user: 'user@example.com',
    pass: 'secret',
  });
  assert.strictEqual(typeof records[0].port, 'number');
});

test('parses comma-delimited (CSV) and pipe-delimited equally', () => {
  const csv = parse('smtp.example.com,587,user@example.com,secret');
  const pipe = parse('smtp.example.com|587|user@example.com|secret');
  assert.deepEqual(csv.records[0], pipe.records[0]);
  assert.equal(csv.records[0].host, 'smtp.example.com');
  assert.equal(csv.records[0].port, 587);
});

test('optional 5th field becomes from address', () => {
  const { records } = parse('smtp.example.com:587:user@example.com:secret:from@example.com');
  assert.equal(records[0].from, 'from@example.com');
});

test('blank lines and # comments are skipped without error', () => {
  const input = [
    '# this is a comment',
    '',
    '   ',
    'smtp.example.com:587:user@example.com:secret',
  ].join('\n');
  const { records, errors } = parse(input);
  assert.equal(records.length, 1);
  assert.equal(errors.length, 0);
});

test('colon-format password may contain colons (split caps at 4 fields)', () => {
  const { records } = parse('smtp.x.com:587:u@x.com:p:a:ss');
  assert.equal(records[0].pass, 'p:a:ss');
  assert.equal(records[0].from, undefined);
});

test('colon-format password with a SINGLE embedded colon is not split into a bogus from', () => {
  const { records } = parse('smtp.x.com:587:u@x.com:pa:ss');
  assert.equal(records[0].pass, 'pa:ss');
  assert.equal(records[0].from, undefined);
});

test('colon-format 5th field is only treated as from when it is a recognizable email', () => {
  const { records } = parse('smtp.example.com:587:user@example.com:secret:from@example.com');
  assert.equal(records[0].pass, 'secret');
  assert.equal(records[0].from, 'from@example.com');
});

test('CSV quoted field keeps the comma inside the value', () => {
  const { records } = parse('smtp.x.com,587,u@x.com,"p,ass"');
  assert.equal(records[0].pass, 'p,ass');
});

test('non-numeric port is a ParseError and does not appear in records; neighbors still parse', () => {
  const input = [
    'good1.com:587:u1@x.com:p1',
    'bad.com:notaport:u@x.com:p',
    'good2.com:465:u2@x.com:p2',
  ].join('\n');
  const { records, errors } = parse(input);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.host), ['good1.com', 'good2.com']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].reason, /port/i);
});

test('line with too few fields is a ParseError', () => {
  const { records, errors } = parse('smtp.x.com:587:only3fields');
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
});
