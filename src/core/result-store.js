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
import { createWriteStream, createReadStream, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { credKey } from './parser.js';
import { isKeeperResult } from './keepers.js';
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
  // A write-stream error (disk full, path removed, volume unmounted mid-run) is
  // otherwise fatal in two ways: an unhandled 'error' crashes the process, and —
  // worse — a caller awaiting drain() would wait forever for a 'drain' event that
  // never comes, silently hanging the whole scan. Capture the error, keep the
  // process alive, and surface it to write()/drain()/close() so the run fails
  // cleanly instead of deadlocking.
  let streamError = null;
  stream.on('error', (err) => { streamError = err; });
  return {
    /** @param {Result} result — returns false under backpressure (caller may await drain). @throws if the stream has errored. */
    write(result) {
      if (streamError) throw streamError;
      total++;
      counts[result.status] = (counts[result.status] || 0) + 1;
      return stream.write(JSON.stringify(result) + '\n');
    },
    total: () => total,
    counts: () => ({ ...counts }),
    // Resolve as soon as the buffer drains OR the stream errors — the caller
    // checks write()'s return next and will throw, so this must never hang.
    drain() {
      if (streamError) return Promise.reject(streamError);
      return new Promise((resolve, reject) => {
        const onDrain = () => { stream.off('error', onError); resolve(); };
        const onError = (err) => { stream.off('drain', onDrain); reject(err); };
        stream.once('drain', onDrain);
        stream.once('error', onError);
      });
    },
    close() {
      if (streamError) return Promise.reject(streamError);
      return new Promise((resolve, reject) =>
        stream.end((err) => (err || streamError ? reject(err || streamError) : resolve({ total, counts: { ...counts } }))),
      );
    },
  };
}

/**
 * A standalone file of confirmed (inbox+spam) credentials, appended the instant
 * each hit is detected — so confirmed hits survive a cancel/crash before the run
 * finishes. inbox/spam are rare, so a synchronous write-through append per hit is
 * cheap and guarantees durability (a buffered stream could lose the last hits on
 * a crash). `add(result)` writes only inbox/spam and returns whether it did.
 *
 * @param {string} filePath
 * @param {{append?:boolean, generatedAt?:string}} [opts] append continues an
 *   existing file (resume); otherwise the file is started fresh with a header.
 */
export function createConfirmedLiveFile(filePath, { append = false, generatedAt = '' } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  if (!append || !existsSync(filePath)) {
    writeFileSync(filePath, confirmedTxtHeaderLines(generatedAt).join('\n') + '\n');
  }
  return {
    /** @param {object} result @returns {boolean} true if it was a confirmed hit that got written. */
    add(result) {
      if (!result || !CONFIRMED_STATUSES.includes(result.status)) return false;
      appendFileSync(filePath, workingCredLine(result) + '\n');
      return true;
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
 * plus the prior totals/counts (used to seed an appending sink). It also returns
 * `recent`: the newest `recentCap` results (oldest-first), so a resumed run can
 * repopulate the dashboard's in-memory window and keep the tile counts and the
 * tile-drawer content in sync. A missing file yields an empty result.
 * @param {string} filePath
 * @param {{recentCap?:number, keeperCap?:number}} [opts] recentCap bounds the
 *   returned `recent` tail; keeperCap bounds the returned `keepers` list.
 * @returns {Promise<{keys:Set<string>, total:number, counts:Record<string,number>, recent:Result[], keepers:Result[]}>}
 */
export async function readRunProgress(filePath, { recentCap = 5000, keeperCap = 100000 } = {}) {
  const keys = new Set();
  const counts = {};
  let total = 0;
  let recent = [];
  // Every rare/valuable hit (inbox/spam/valid/… and panel logins), not just the
  // newest window — so a resumed drawer can show all of them the tile counts.
  let keepers = [];
  try {
    for await (const r of readResults(filePath)) {
      total++;
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.cred) keys.add(credKey(r.cred));
      // Retain only the newest recentCap results; trim in bulk so this stays
      // amortized O(1) even across millions of rows (mirrors the renderer).
      recent.push(r);
      if (recentCap > 0 && recent.length > recentCap * 1.2) recent = recent.slice(-recentCap);
      if (isKeeperResult(r)) {
        keepers.push(r);
        if (keeperCap > 0 && keepers.length > keeperCap * 1.2) keepers = keepers.slice(-keeperCap);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (recentCap > 0 && recent.length > recentCap) recent = recent.slice(-recentCap);
  if (keeperCap > 0 && keepers.length > keeperCap) keepers = keepers.slice(-keeperCap);
  return { keys, total, counts, recent, keepers };
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
