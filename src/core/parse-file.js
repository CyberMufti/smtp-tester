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
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseDelimitedLine, credKey } from './parser.js';

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
  const { dedupe = true, onError } = opts;
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
        seen.add(key);
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
