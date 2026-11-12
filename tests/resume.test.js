import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultSink, readRunProgress, readResults } from '../src/core/result-store.js';
import { credKey } from '../src/core/parser.js';

function result(status, cred) {
  return { status, cred, usedHost: cred.host, usedPort: cred.port, reason: '', latencyMs: 1 };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'smtp-resume-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readRunProgress on a missing file returns an empty baseline', async () => {
  await withTempDir(async (dir) => {
    const prog = await readRunProgress(join(dir, 'nope.jsonl'));
    assert.equal(prog.total, 0);
    assert.equal(prog.keys.size, 0);
    assert.deepEqual(prog.counts, {});
  });
});

test('readRunProgress reports completed keys and counts from a partial run', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'run.jsonl');
    const sink = createResultSink(path);
    sink.write(result('valid', { host: 'a.com', port: 587, user: 'a@a.com', pass: 'p' }));
    sink.write(result('dead', { host: 'b.com', port: 587, user: 'b@b.com', pass: 'p' }));
    await sink.close();

    const prog = await readRunProgress(path);
    assert.equal(prog.total, 2);
    assert.deepEqual(prog.counts, { valid: 1, dead: 1 });
    assert.ok(prog.keys.has(credKey({ host: 'a.com', port: 587, user: 'a@a.com', pass: 'p' })));
  });
});

test('readRunProgress returns the newest results so a resumed drawer stays in sync', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'run.jsonl');
    const sink = createResultSink(path);
    sink.write(result('inbox', { host: 'a.com', port: 587, user: 'a@a.com', pass: 'p1' }));
    sink.write(result('dead', { host: 'b.com', port: 587, user: 'b@b.com', pass: 'p2' }));
    await sink.close();

    const prog = await readRunProgress(path);
    // The tile count for 'inbox' is 1, so the drawer must be able to find that row.
    assert.equal(prog.counts.inbox, 1);
    assert.ok(Array.isArray(prog.recent), 'recent tail is returned for the drawer');
    assert.equal(prog.recent.length, 2, 'every retained result comes back');
    assert.equal(prog.recent.filter((r) => r.status === 'inbox').length, 1,
      'the inbox row the tile counts is present in the restored window');
    assert.equal(prog.recent[0].cred.user, 'a@a.com', 'oldest-first order preserved');
  });
});

test('readRunProgress keeps only the newest recentCap results', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'run.jsonl');
    const sink = createResultSink(path);
    for (let i = 0; i < 10; i++) {
      sink.write(result('valid', { host: `h${i}.com`, port: 587, user: `u${i}@x.com`, pass: 'p' }));
    }
    await sink.close();

    const prog = await readRunProgress(path, { recentCap: 3 });
    assert.equal(prog.total, 10, 'counts still reflect the whole run');
    assert.equal(prog.recent.length, 3, 'recent is capped to recentCap');
    assert.deepEqual(prog.recent.map((r) => r.cred.user), ['u7@x.com', 'u8@x.com', 'u9@x.com'],
      'the newest recentCap results are retained, oldest-first');
  });
});

test('append sink seeded with prior totals continues the counts and keeps old rows', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'run.jsonl');
    const first = createResultSink(path);
    first.write(result('valid', { host: 'a.com', port: 587, user: 'a@a.com', pass: 'p' }));
    const prior = await first.close();

    // Resume: append, seeded with prior totals/counts.
    const prog = await readRunProgress(path);
    const second = createResultSink(path, { append: true, initialTotal: prog.total, initialCounts: prog.counts });
    second.write(result('inbox', { host: 'c.com', port: 587, user: 'c@c.com', pass: 'p' }));
    const after = await second.close();

    assert.equal(prior.total, 1);
    assert.equal(after.total, 2, 'cumulative total across the resume');
    assert.deepEqual(after.counts, { valid: 1, inbox: 1 });

    const rows = [];
    for await (const r of readResults(path)) rows.push(r);
    assert.equal(rows.length, 2, 'original row preserved, new row appended');
  });
});
