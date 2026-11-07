import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultSink, readResults, exportRun } from '../src/core/result-store.js';
import { parse } from '../src/core/parser.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'smtp-resultstore-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function result(status, cred, extra = {}) {
  return { status, cred, usedHost: cred.host, usedPort: cred.port, reason: '', latencyMs: 10, ...extra };
}

const SAMPLE = [
  result('inbox', { host: 'smtp.gmail.com', port: 587, user: 'a@gmail.com', pass: 'p1' }),
  result('spam', { host: 'smtp.x.com', port: 587, user: 'b@x.com', pass: 'p2' }),
  result('valid', { host: 'smtp.y.com', port: 465, user: 'c@y.com', pass: 'p3' }),
  result('dead', { host: 'dead.com', port: 587, user: 'd@dead.com', pass: 'p4' }, { usedHost: null, usedPort: null }),
];

async function writeRun(dir) {
  const path = join(dir, 'run.jsonl');
  const sink = createResultSink(path);
  for (const r of SAMPLE) sink.write(r);
  const { total, counts } = await sink.close();
  return { path, total, counts };
}

test('sink appends JSONL and reports running totals and counts', async () => {
  await withTempDir(async (dir) => {
    const { path, total, counts } = await writeRun(dir);
    assert.equal(total, 4);
    assert.deepEqual(counts, { inbox: 1, spam: 1, valid: 1, dead: 1 });
    const text = await readFile(path, 'utf8');
    assert.equal(text.trim().split('\n').length, 4, 'one JSON object per line');
    const back = [];
    for await (const r of readResults(path)) back.push(r);
    assert.equal(back.length, 4);
    assert.equal(back[0].cred.user, 'a@gmail.com');
  });
});

test('exportRun json produces a valid JSON array of every result', async () => {
  await withTempDir(async (dir) => {
    const { path } = await writeRun(dir);
    const dest = join(dir, 'out.json');
    await exportRun(path, dest, 'json');
    const parsed = JSON.parse(await readFile(dest, 'utf8'));
    assert.equal(parsed.length, 4);
    assert.equal(parsed[3].status, 'dead');
  });
});

test('exportRun csv has a header and one row per result', async () => {
  await withTempDir(async (dir) => {
    const { path } = await writeRun(dir);
    const dest = join(dir, 'out.csv');
    await exportRun(path, dest, 'csv');
    const lines = (await readFile(dest, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 5, 'header + 4 rows');
    assert.ok(lines[0].startsWith('host,port,user,status'));
  });
});

test('exportRun txt excludes dead, groups by placement, and re-imports cleanly', async () => {
  await withTempDir(async (dir) => {
    const { path } = await writeRun(dir);
    const dest = join(dir, 'out.txt');
    await exportRun(path, dest, 'txt', { generatedAt: '2026-11-07' });
    const txt = await readFile(dest, 'utf8');
    assert.ok(!txt.includes('dead.com'), 'dead credential must not be exported');
    assert.ok(/# === INBOX \(1\) ===/.test(txt));
    assert.ok(/# === SPAM \(1\) ===/.test(txt));
    assert.ok(/# === VALID \/ SENT \(1\) ===/.test(txt));
    const { records, errors } = parse(txt);
    assert.equal(errors.length, 0);
    assert.equal(records.length, 3, 'three working credentials round-trip');
  });
});
