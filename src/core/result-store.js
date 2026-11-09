/**
 * Streaming result store: keep a test run's results on disk instead of in RAM.
 *
 * At large scale (millions of credentials) the results themselves are too big to
 * hold in memory — keeping the full array, re-serializing it on every autosave,
 * and shipping it to the renderer for export would all blow up. Instead each
 * result is appended to a JSONL file as it arrives (bounded memory, O(1) per
 * result), running counts are tracked for the summary, and exports stream from
 * that file. The JSONL file also serves as the crash-safe autosave.
 *
 * @typedef {import('./tester.js').Result} Result
 */
import { createWriteStream, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { credKey } from './parser.js';
import {
  workingTxtHeaderLines,
  workingCredLine,
  csvHeaderLine,
  csvRowLine,
  WORKING_GROUPS,
  confirmedTxtHeaderLines,
  CONFIRMED_STATUSES,
} from './export.js';

/**
 * Open a JSONL sink at `filePath`. `write(result)` appends one line and updates
 * running counts; `close()` flushes and returns `{total, counts}`.
 * @param {string} filePath
 */
export function createResultSink(filePath, { append = false, initialTotal = 0, initialCounts = {} } = {}) {
  const stream = createWriteStream(filePath, { flags: append ? 'a' : 'w' });
  let total = initialTotal;
  const counts = { ...initialCounts };
  return {
    /** @param {Result} result — returns false under backpressure (caller may await drain). */
    write(result) {
      total++;
      counts[result.status] = (counts[result.status] || 0) + 1;
      return stream.write(JSON.stringify(result) + '\n');
    },
    total: () => total,
    counts: () => ({ ...counts }),
    drain() {
      return new Promise((resolve) => stream.once('drain', resolve));
    },
    close() {
      return new Promise((resolve, reject) =>
        stream.end((err) => (err ? reject(err) : resolve({ total, counts: { ...counts } }))),
      );
    },
  };
}

/**
 * Yield each result from a JSONL run file. Bounded memory — one line at a time.
 * @param {string} filePath
 * @returns {AsyncGenerator<Result>}
 */
export async function* readResults(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue;
      yield JSON.parse(line);
    }
  } finally {
    rl.close();
  }
}

/**
 * Read an existing run file to learn what has already been tested, so a run can
 * resume without repeating work. Returns the set of completed credential keys
 * plus the prior totals/counts (used to seed an appending sink). A missing file
 * yields an empty result.
 * @param {string} filePath
 * @returns {Promise<{keys:Set<string>, total:number, counts:Record<string,number>}>}
 */
export async function readRunProgress(filePath) {
  const keys = new Set();
  const counts = {};
  let total = 0;
  try {
    for await (const r of readResults(filePath)) {
      total++;
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.cred) keys.add(credKey(r.cred));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { keys, total, counts };
}

/** Write a string to a stream, awaiting drain on backpressure. */
function writeBackpressured(out, chunk) {
  if (out.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => out.once('drain', resolve));
}

/**
 * Stream-export a JSONL run file to `dest` in the given format, holding only one
 * result in memory at a time.
 *
 * - `json` — a pretty-ish JSON array, one record per line.
 * - `csv`  — header + one row per result.
 * - `txt`  — working (non-dead) credentials grouped by placement, re-importable.
 *   Grouping needs the per-group counts, so TXT makes one counting pass then one
 *   pass per non-empty group (both bounded-memory).
 *
 * @param {string} src JSONL run file
 * @param {string} dest output path
 * @param {'txt'|'csv'|'json'} format
 * @param {{generatedAt?:string}} [opts]
 */
export async function exportRun(src, dest, format, opts = {}) {
  const out = createWriteStream(dest, { flags: 'w' });
  const write = (chunk) => writeBackpressured(out, chunk);
  try {
    if (format === 'json') {
      await write('[\n');
      let first = true;
      for await (const r of readResults(src)) {
        await write((first ? '' : ',\n') + JSON.stringify(r));
        first = false;
      }
      await write('\n]\n');
    } else if (format === 'csv') {
      await write(csvHeaderLine() + '\n');
      for await (const r of readResults(src)) await write(csvRowLine(r) + '\n');
    } else if (format === 'confirmed') {
      // Confirmed-delivered only (inbox/spam) — one bounded-memory pass, no
      // grouping. Excludes "valid" (accepted but never found in a mailbox).
      await write(confirmedTxtHeaderLines(opts.generatedAt).join('\n') + '\n');
      for await (const r of readResults(src)) {
        if (CONFIRMED_STATUSES.includes(r.status)) await write(workingCredLine(r) + '\n');
      }
    } else {
      // txt — working credentials grouped by placement.
      await write(workingTxtHeaderLines(opts.generatedAt).join('\n') + '\n');
      const counts = {};
      for await (const r of readResults(src)) {
        if (r.status !== 'dead') counts[r.status] = (counts[r.status] || 0) + 1;
      }
      for (const [key, label] of WORKING_GROUPS) {
        if (!counts[key]) continue;
        await write(`# === ${label} (${counts[key]}) ===\n`);
        for await (const r of readResults(src)) {
          if (r.status === key) await write(workingCredLine(r) + '\n');
        }
        await write('\n');
      }
    }
  } finally {
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  }
}
