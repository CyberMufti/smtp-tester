import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCredentialsFromFile, countCredentialsInFile, dedupeFileToDisk } from '../src/core/parse-file.js';

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

test('dedupeFileToDisk writes a deduped copy that re-parses to the same records (dedup off)', async () => {
  const text = [
    '# comment',
    'smtp.a.com:587:a@a.com:p1',
    '',
    'smtp.b.com:587:b@b.com:p2',
    'smtp.a.com:587:a@a.com:p1', // exact dupe
    'totally bogus line',
  ].join('\n');
  await withTempFile(text, async (path) => {
    const dest = path + '.deduped';
    const errs = [];
    const { count, errors, sample } = await dedupeFileToDisk(path, dest, { onError: (e) => errs.push(e) });

    assert.equal(count, 2);
    assert.equal(errors, 1);
    assert.equal(errs.length, 1);
    assert.ok(sample.length >= 1 && sample.length <= 5);
    assert.equal(sample[0].user, 'a@a.com');

    // The dest holds only unique credential lines; re-reading WITHOUT dedup
    // must yield exactly the deduped set (proves the run needs no second Set).
    const reparsed = await collect(streamCredentialsFromFile(dest, { dedupe: false }));
    assert.equal(reparsed.length, 2);
    assert.deepEqual(reparsed[0], { host: 'smtp.a.com', port: 587, user: 'a@a.com', pass: 'p1' });
    assert.equal(reparsed[1].user, 'b@b.com');
  });
});

test('dedupeFileToDisk preserves passwords containing the delimiter (raw round-trip)', async () => {
  // A password with a ':' is fidelity-sensitive — writing the raw line and
  // re-parsing it must reproduce the exact same record.
  const text = 'smtp.a.com:587:a@a.com:p:a:ss';
  await withTempFile(text, async (path) => {
    const dest = path + '.deduped';
    const direct = (await collect(streamCredentialsFromFile(path)))[0];
    await dedupeFileToDisk(path, dest);
    const reparsed = (await collect(streamCredentialsFromFile(dest, { dedupe: false })))[0];
    assert.deepEqual(reparsed, direct);
  });
});

test('parsedCredsPathFor gives distinct files distinct paths (no collision), same file a stable path', async () => {
  const { parsedCredsPathFor } = await import('../src/core/parse-file.js');
  const { join, basename, dirname } = await import('node:path');
  const dir = join('data', 'cache');
  const a = parsedCredsPathFor(dir, join('uploads', 'fileA.txt'));
  const b = parsedCredsPathFor(dir, join('uploads', 'fileB.txt'));
  const aAgain = parsedCredsPathFor(dir, join('uploads', 'fileA.txt'));
  assert.notEqual(a, b, 'different source files must map to different parsed paths');
  assert.equal(a, aAgain, 'same source file must map to the same parsed path (idempotent)');
  // Placed in the given dir, named parsed-creds-<hash>.txt — platform-agnostic.
  assert.equal(dirname(a), dir);
  assert.match(basename(a), /^parsed-creds-[0-9a-f]+\.txt$/);
});
