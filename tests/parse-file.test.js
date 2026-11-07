import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCredentialsFromFile, countCredentialsInFile } from '../src/core/parse-file.js';

async function withTempFile(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'smtp-parsefile-'));
  const path = join(dir, 'leads.txt');
  await writeFile(path, contents, 'utf8');
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}

test('streams one deduped credential per unique line', async () => {
  const text = [
    'smtp.example.com:587:user1@example.com:secret1',
    'smtp.example.com:587:user2@example.com:secret2',
    'smtp.example.com:587:user1@example.com:secret1', // exact dupe
  ].join('\n');
  await withTempFile(text, async (path) => {
    const records = await collect(streamCredentialsFromFile(path));
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], { host: 'smtp.example.com', port: 587, user: 'user1@example.com', pass: 'secret1' });
    assert.equal(records[1].user, 'user2@example.com');
  });
});

test('skips blank and # comment lines without error', async () => {
  const text = ['# header', '', '   ', 'smtp.example.com:587:u@example.com:p'].join('\n');
  await withTempFile(text, async (path) => {
    const records = await collect(streamCredentialsFromFile(path));
    assert.equal(records.length, 1);
  });
});

test('reports unparseable lines via onError and keeps streaming', async () => {
  const text = ['garbage-no-delimiters', 'smtp.example.com:587:u@example.com:p'].join('\n');
  await withTempFile(text, async (path) => {
    const errs = [];
    const records = await collect(streamCredentialsFromFile(path, { onError: (e) => errs.push(e) }));
    assert.equal(records.length, 1);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 1);
    assert.match(errs[0].reason, /delimiter|host|password|port/i);
  });
});

test('dedupe can be disabled', async () => {
  const text = ['smtp.x.com:587:u@x.com:p', 'smtp.x.com:587:u@x.com:p'].join('\n');
  await withTempFile(text, async (path) => {
    const deduped = await collect(streamCredentialsFromFile(path));
    const raw = await collect(streamCredentialsFromFile(path, { dedupe: false }));
    assert.equal(deduped.length, 1);
    assert.equal(raw.length, 2);
  });
});

test('countCredentialsInFile returns deduped count, error count, and a small sample', async () => {
  const text = [
    'smtp.a.com:587:a@a.com:p1',
    'smtp.b.com:587:b@b.com:p2',
    'smtp.a.com:587:a@a.com:p1', // dupe
    'totally bogus line',
  ].join('\n');
  await withTempFile(text, async (path) => {
    const { count, errors, sample } = await countCredentialsInFile(path);
    assert.equal(count, 2);
    assert.equal(errors, 1);
    assert.ok(sample.length >= 1 && sample.length <= 5);
    assert.equal(sample[0].user, 'a@a.com');
  });
});
