/**
 * Streaming credential parser for uploaded files.
 *
 * Bulk lead dumps are delimited lines (host:port:user:pass[:from]) — the style
 * {@link parseDelimitedLine} handles. Reading such a file line-by-line keeps the
 * work off the renderer's UI thread and, crucially, never holds the whole file
 * (a 3M-lead dump is hundreds of MB of text) in memory at once: lines flow
 * through a bounded worker pool as they are read.
 *
 * The labeled key-value block format stays on the paste/textarea path in the
 * renderer — it is for small hand-entered lists, not million-line uploads.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseDelimitedLine, credKey } from './parser.js';

/**
 * Hard cap on how many distinct keys the in-memory dedupe Set may hold. Each
 * key is ~130 bytes with Set overhead, so ~12M keys ≈ 1.5 GB — safe within the
 * raised main-process heap. Past the cap, dedup degrades gracefully: already-seen
 * keys are still dropped, but new keys are no longer tracked (their later
 * duplicates pass through) so a 100M-row file loads instead of OOM-crashing. A
 * unique credential is NEVER dropped. Override via `maxDedupeKeys`.
 */
export const DEFAULT_MAX_DEDUPE_KEYS = 12_000_000;

/**
 * Deterministic on-disk path for a source file's deduped copy, unique PER
 * SOURCE. A single fixed name would collide: loading several files would make
 * every file's deduped copy overwrite the same path, so the run would stream
 * the last file once per loaded file (double-counting it, skipping the rest).
 * Hashing the absolute source path keeps re-counting the same file idempotent
 * while giving distinct files distinct destinations.
 *
 * @param {string} dir  directory to place the copy in (e.g. app userData)
 * @param {string} srcPath  absolute path of the uploaded source file
 * @returns {string}
 */
export function parsedCredsPathFor(dir, srcPath) {
  const hash = createHash('sha1').update(String(srcPath)).digest('hex').slice(0, 16);
  return join(dir, `parsed-creds-${hash}.txt`);
}

/**
 * Yield deduped {@link Credential} records parsed from `filePath`, one line at a
 * time. Blank and `#` comment lines are skipped; an unparseable line is reported
 * via `onError` (if given) and skipped rather than aborting the stream.
 *
 * @param {string} filePath
 * @param {{dedupe?:boolean, onError?:(e:{line:number,raw:string,reason:string})=>void}} [opts]
 * @returns {AsyncGenerator<import('./parser.js').Credential>}
 */
export async function* streamCredentialsFromFile(filePath, opts = {}) {
  const { dedupe = true, onError, maxDedupeKeys = DEFAULT_MAX_DEDUPE_KEYS } = opts;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const seen = dedupe ? new Set() : null;
  let lineNo = 0;
  try {
    for await (const raw of rl) {
      lineNo++;
      const res = parseDelimitedLine(raw);
      if (!res) continue; // blank or comment
      if (res.error) {
        onError?.({ line: lineNo, raw, reason: res.error });
        continue;
      }
      if (seen) {
        const key = credKey(res.record);
        if (seen.has(key)) continue;
        // Stop growing the Set at the cap — never drop an unseen credential,
        // just stop tracking new keys so memory stays bounded on huge files.
        if (seen.size < maxDedupeKeys) seen.add(key);
      }
      yield res.record;
    }
  } finally {
    rl.close();
  }
}

/**
 * Count the deduped credentials (and skipped lines) in a file without loading or
 * testing them. Used to show the parsed count on upload and to drive the
 * progress bar's total for a file run.
 *
 * @param {string} filePath
 * @param {{dedupe?:boolean}} [opts]
 * @returns {Promise<{count:number, errors:number, sample:import('./parser.js').Credential[]}>}
 */
export async function countCredentialsInFile(filePath, opts = {}) {
  let count = 0;
  let errors = 0;
  const sample = [];
  const source = streamCredentialsFromFile(filePath, {
    dedupe: opts.dedupe ?? true,
    onError: () => {
      errors++;
    },
  });
  for await (const rec of source) {
    count++;
    if (sample.length < 5) sample.push(rec);
  }
  return { count, errors, sample };
}

/**
 * Dedupe a credential file to disk in a single pass: parse `srcPath`
 * line-by-line, drop exact duplicates (by {@link credKey}, first-seen wins),
 * and write each surviving line — verbatim, so passwords containing the
 * delimiter round-trip exactly — to `destPath`, one per line. The run can then
 * stream `destPath` with `dedupe: false` and never build a second in-memory
 * `Set` of keys, which at millions of rows is the dominant memory cost.
 *
 * Blank/`#`-comment lines are omitted from the output; an unparseable line is
 * reported via `onError` (if given) and skipped. Returns the deduped count, the
 * number of skipped-as-unparseable lines, and a small sample of records.
 *
 * @param {string} srcPath
 * @param {string} destPath
 * @param {{onError?:(e:{line:number,raw:string,reason:string})=>void}} [opts]
 * @returns {Promise<{count:number, errors:number, sample:import('./parser.js').Credential[]}>}
 */
export async function dedupeFileToDisk(srcPath, destPath, opts = {}) {
  const { onError, maxDedupeKeys = DEFAULT_MAX_DEDUPE_KEYS } = opts;
  const rl = createInterface({
    input: createReadStream(srcPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const out = createWriteStream(destPath, { flags: 'w' });
  const seen = new Set();
  const sample = [];
  let count = 0;
  let errors = 0;
  let lineNo = 0;
  let dedupeTruncated = false;
  try {
    for await (const raw of rl) {
      lineNo++;
      const res = parseDelimitedLine(raw);
      if (!res) continue; // blank or comment
      if (res.error) {
        errors++;
        onError?.({ line: lineNo, raw, reason: res.error });
        continue;
      }
      const key = credKey(res.record);
      if (seen.has(key)) continue;
      // Bound the Set so a 100M-row file can't OOM. Past the cap we stop
      // tracking new keys (never dropping an unseen credential); exact dedup
      // then only holds for the first `maxDedupeKeys` distinct credentials.
      if (seen.size < maxDedupeKeys) seen.add(key);
      else dedupeTruncated = true;
      count++;
      if (sample.length < 5) sample.push(res.record);
      // Write the trimmed source line verbatim so re-parsing is identical.
      if (!out.write(raw.trim() + '\n')) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
    }
  } finally {
    rl.close();
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  }
  return { count, errors, sample, dedupeTruncated };
}
