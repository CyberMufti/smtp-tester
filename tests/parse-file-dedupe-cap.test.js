import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCredentialsFromFile, dedupeFileToDisk } from '../src/core/parse-file.js';

async function withTempFile(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'smtp-dedupecap-'));
  const path = join(dir, 'leads.txt');
  await writeFile(path, contents, 'utf8');
  try { return await fn(dir, path); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function collect(iter) {
  const out = [];
  for await (const r of iter) out.push(r);
  return out;
}

// Four lines: a, b, c, then a duplicate of c. Full dedup -> 3 records.
const CONTENT = [
  'smtp.a.com:587:a@a.com:p',
  'smtp.b.com:587:b@b.com:p',
  'smtp.c.com:587:c@c.com:p',
  'smtp.c.com:587:c@c.com:p',
].join('\n');

test('with no cap, exact duplicates are removed', async () => {
  await withTempFile(CONTENT, async (_dir, path) => {
    const recs = await collect(streamCredentialsFromFile(path, { dedupe: true }));
    assert.equal(recs.length, 3, 'the duplicate c is dropped');
  });
});

test('streamCredentialsFromFile degrades gracefully past the key cap instead of growing unbounded', async () => {
  await withTempFile(CONTENT, async (_dir, path) => {
    // Cap at 2 keys: a and b fill the set; c and its duplicate are past the cap,
    // so the duplicate c is NOT deduped (passes through) rather than OOMing.
    const recs = await collect(streamCredentialsFromFile(path, { dedupe: true, maxDedupeKeys: 2 }));
    assert.equal(recs.length, 4, 'past the cap, the duplicate passes through (no unbounded Set)');
  });
});

test('a unique credential is NEVER dropped, even past the cap', async () => {
  // Distinct keys only; capping must not lose any of them.
  const distinct = Array.from({ length: 6 }, (_, i) => `smtp.x.com:587:u${i}@x.com:p`).join('\n');
  await withTempFile(distinct, async (_dir, path) => {
    const recs = await collect(streamCredentialsFromFile(path, { dedupe: true, maxDedupeKeys: 2 }));
    assert.equal(recs.length, 6, 'all distinct credentials survive regardless of the cap');
  });
});

test('dedupeFileToDisk honors the key cap and flags truncation', async () => {
  await withTempFile(CONTENT, async (dir, path) => {
    const dest = join(dir, 'out.txt');
    const res = await dedupeFileToDisk(path, dest, { maxDedupeKeys: 2 });
    const lines = (await readFile(dest, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 4, 'duplicate past the cap is written (not dropped)');
    assert.equal(res.count, 4);
    assert.equal(res.dedupeTruncated, true, 'signals that dedup was capped');
  });
});
