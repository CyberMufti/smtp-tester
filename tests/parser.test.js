import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, dedupeCredentials, parseDelimitedLine } from '../src/core/parser.js';

test('parseDelimitedLine: record, blank/comment -> null, bad line -> error', () => {
  assert.deepEqual(parseDelimitedLine('smtp.x.com:587:u@x.com:p'), {
    record: { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'p' },
  });
  assert.equal(parseDelimitedLine(''), null);
  assert.equal(parseDelimitedLine('   '), null);
  assert.equal(parseDelimitedLine('# comment'), null);
  const bad = parseDelimitedLine('garbage-no-delimiters');
  assert.ok(bad && bad.error, 'unparseable line should return an error');
});

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

test('host-first line with an invalid port is tolerated (port=null, to be resolved at test time)', () => {
  const input = [
    'good1.com:587:u1@x.com:p1',
    'bad.com:notaport:u@x.com:p',
    'good2.com:465:u2@x.com:p2',
  ].join('\n');
  const { records, errors } = parse(input);
  assert.equal(records.length, 3);
  assert.equal(errors.length, 0);
  assert.equal(records[1].host, 'bad.com');
  assert.equal(records[1].port, null);
});

test('line with too few fields is a ParseError', () => {
  const { records, errors } = parse('smtp.x.com:587:only3fields');
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
});

// --- flexible "any format" detection ---------------------------------------

test('dedupeCredentials removes exact duplicates, keeping the first and order', () => {
  const recs = [
    { host: 'a.com', port: 587, user: 'u@a.com', pass: 'p' },
    { host: 'b.com', port: 587, user: 'u@b.com', pass: 'p' },
    { host: 'a.com', port: 587, user: 'u@a.com', pass: 'p' }, // dup of #1
    { host: 'a.com', port: 465, user: 'u@a.com', pass: 'p' }, // different port, not a dup
  ];
  const { records, removed } = dedupeCredentials(recs);
  assert.equal(removed, 1);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => `${r.host}:${r.port}`), ['a.com:587', 'b.com:587', 'a.com:465']);
});

test('dedupeCredentials treats host-less (email-only) duplicates by user+pass', () => {
  const recs = [
    { host: null, port: null, user: 'x@gmail.com', pass: 'k' },
    { host: null, port: null, user: 'x@gmail.com', pass: 'k' },
  ];
  const { records, removed } = dedupeCredentials(recs);
  assert.equal(records.length, 1);
  assert.equal(removed, 1);
});

test('whitespace-separated fields parse', () => {
  const { records } = parse('smtp.example.com 587 user@example.com secret');
  assert.deepEqual(records[0], {
    host: 'smtp.example.com',
    port: 587,
    user: 'user@example.com',
    pass: 'secret',
  });
});

test('tab-separated fields parse', () => {
  const { records } = parse('smtp.example.com\t587\tuser@example.com\tsecret');
  assert.equal(records[0].host, 'smtp.example.com');
  assert.equal(records[0].port, 587);
  assert.equal(records[0].pass, 'secret');
});

test('semicolon-separated fields parse', () => {
  const { records } = parse('smtp.example.com;587;user@example.com;secret');
  assert.equal(records[0].port, 587);
  assert.equal(records[0].user, 'user@example.com');
});

test('fields in a non-standard order are detected by role (port=numeric, host=hostname)', () => {
  const { records } = parse('user@example.com secret smtp.example.com 587');
  assert.equal(records[0].host, 'smtp.example.com');
  assert.equal(records[0].port, 587);
  assert.equal(records[0].user, 'user@example.com');
  assert.equal(records[0].pass, 'secret');
});

test('labeled key-value block parses into one record', () => {
  const input = [
    'Host: smtp.sendgrid.net',
    'Port: 587',
    'Username: apikey',
    'Password: SG.abc123',
  ].join('\n');
  const { records, errors } = parse(input);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    host: 'smtp.sendgrid.net',
    port: 587,
    user: 'apikey',
    pass: 'SG.abc123',
  });
});

test('two key-value blocks separated by a blank line parse into two records', () => {
  const input = [
    'Server: smtp.one.com',
    'Port = 465',
    'Login: u1@one.com',
    'Pwd: p1',
    '',
    'Server: smtp.two.com',
    'Port = 587',
    'Login: u2@two.com',
    'Pwd: p2',
  ].join('\n');
  const { records } = parse(input);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.host), ['smtp.one.com', 'smtp.two.com']);
  assert.equal(records[0].port, 465);
  assert.equal(records[1].user, 'u2@two.com');
});

test('key-value synonyms and = separator are recognized', () => {
  const input = [
    'SMTP Host = mail.acme.io',
    'SMTP Port = 587',
    'E-mail: sender@acme.io',
    'API Key: key-xyz',
  ].join('\n');
  const { records } = parse(input);
  assert.equal(records.length, 1);
  assert.equal(records[0].host, 'mail.acme.io');
  assert.equal(records[0].user, 'sender@acme.io');
  assert.equal(records[0].pass, 'key-xyz');
});

test('email:password with no host is accepted for a known provider (host/port null)', () => {
  const { records, errors } = parse('someone@gmail.com:supersecret');
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { host: null, port: null, user: 'someone@gmail.com', pass: 'supersecret' });
});

test('email:password with any domain is accepted host-less (host discovered at test time)', () => {
  const { records, errors } = parse('someone@premiumisme.com:Secret#123');
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].host, null);
  assert.equal(records[0].port, null);
  assert.equal(records[0].user, 'someone@premiumisme.com');
  assert.equal(records[0].pass, 'Secret#123');
});

test('a bare non-email two-field line is still a ParseError', () => {
  const { records, errors } = parse('apikey:secret');
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
});

test('key-value block without a host is accepted for a known provider', () => {
  const input = ['Email: me@gmail.com', 'Password: apppass1234'].join('\n');
  const { records, errors } = parse(input);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].host, null);
  assert.equal(records[0].user, 'me@gmail.com');
});

test('reordered line with no numeric port anywhere is a ParseError', () => {
  const { records, errors } = parse('u@x.com secret foo bar');
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /port/i);
});

test('a mostly-delimited file is NOT forced into key-value mode by a couple of stray label lines', () => {
  const input = [
    'smtp.a.com:587:user1:pass1',
    'smtp.b.com:587:user2:pass2',
    'smtp.c.com:587:user3:pass3',
    'server: smtp.d.com',
    'port: 587',
  ].join('\n');
  const { records } = parse(input);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.host), ['smtp.a.com', 'smtp.b.com', 'smtp.c.com']);
});

test('key-value block with multiple user/pass pairs under one host yields a record each', () => {
  const input = [
    'Host: smtp.a.com',
    'Port: 587',
    'User: u1@a.com',
    'Pass: p1',
    'User: u2@a.com',
    'Pass: p2',
  ].join('\n');
  const { records } = parse(input);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.user), ['u1@a.com', 'u2@a.com']);
  assert.ok(records.every((r) => r.host === 'smtp.a.com' && r.port === 587));
});

test('pipe-delimited password containing pipes keeps the original delimiter', () => {
  const { records } = parse('smtp.x.com|587|u@x.com|p|a|ss');
  assert.equal(records[0].pass, 'p|a|ss');
});

test('mixed delimited lines still parse alongside the new formats', () => {
  const input = [
    'a.com:587:u1@a.com:p1',
    'b.com 2525 u2@b.com p2',
    'c.com,465,u3@c.com,p3',
  ].join('\n');
  const { records } = parse(input);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.port), [587, 2525, 465]);
});
