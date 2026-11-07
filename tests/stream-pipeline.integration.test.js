// End-to-end test of the data path the app runs for a file upload, minus
// Electron/IPC: file on disk -> streaming parse -> runBatch (async-iterable
// source) -> JSONL result sink -> streaming export. This mirrors
// runBatchToDisk() in src/main/index.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCredentialsFromFile } from '../src/core/parse-file.js';
import { runBatch } from '../src/core/tester.js';
import { createResultSink, exportRun } from '../src/core/result-store.js';
import { parse } from '../src/core/parser.js';

// Stub smtp/imap: every even-indexed user authenticates and lands in inbox; odd
// users fail to connect (dead). Deterministic so counts are exact.
function deps() {
  return {
    smtp: {
      async verify(cred) {
        const n = Number(cred.user.replace(/\D/g, '')) || 0;
        return n % 2 === 0 ? { connected: true, authenticated: true } : { connected: false, error: 'ECONNREFUSED' };
      },
      async send(cred, opts) {
        return { accepted: [opts.to] };
      },
    },
    imap: { async findToken() { return { found: true, folder: 'inbox' }; } },
  };
}

test('file -> stream -> runBatch -> disk sink -> export, with exact counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smtp-pipeline-'));
  try {
    // 200 credentials, 10 of them exact duplicates that must be deduped away.
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`smtp.h${i}.com:587:user${i}@x.com:p${i}`);
    for (let i = 0; i < 10; i++) lines.push(`smtp.h${i}.com:587:user${i}@x.com:p${i}`); // dupes
    const credsFile = join(dir, 'leads.txt');
    await writeFile(credsFile, lines.join('\n'), 'utf8');

    // Drive the batch exactly like the main process does.
    const runFile = join(dir, 'run.jsonl');
    const sink = createResultSink(runFile);
    const source = streamCredentialsFromFile(credsFile, { onError: () => {} });
    let progress = 0;
    await runBatch(source, [], { concurrency: 8, deps: deps() }, (result) => {
      sink.write(result);
      progress++;
    });
    const { total, counts } = await sink.close();

    // 200 unique creds tested (10 dupes removed by the streaming parser).
    assert.equal(total, 200);
    assert.equal(progress, 200);
    // No IMAP seeds here, so a successful send is 'valid' (placement needs a seed).
    assert.equal(counts.valid, 100, 'even users authenticate and send');
    assert.equal(counts.dead, 100, 'odd users are dead');

    // Export the working set and confirm it re-imports as the 100 inbox creds.
    const txtOut = join(dir, 'working.txt');
    await exportRun(runFile, txtOut, 'txt', { generatedAt: '2026-11-07' });
    const txt = await readFile(txtOut, 'utf8');
    const { records, errors } = parse(txt);
    assert.equal(errors.length, 0);
    assert.equal(records.length, 100, 'only the 100 working creds are exported');

    // CSV has header + one row per tested credential.
    const csvOut = join(dir, 'all.csv');
    await exportRun(runFile, csvOut, 'csv');
    const csvLines = (await readFile(csvOut, 'utf8')).trim().split('\n');
    assert.equal(csvLines.length, 201, 'header + 200 rows');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
