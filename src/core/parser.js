/**
 * Parse bulk SMTP credentials from pasted text or an uploaded file.
 *
 * Accepted per-line formats (delimiter auto-detected per line):
 *   host:port:user:pass[:from]
 *   host,port,user,pass[,from]   (CSV; fields may be double-quoted)
 *   host|port|user|pass[|from]
 *
 * Blank lines and lines beginning with `#` are ignored.
 *
 * For colon and pipe formats the split caps at 5 fields so a password may
 * itself contain the delimiter: everything after the user, up to an optional
 * trailing `from`, is the password. Because a bare delimiter in the password
 * is indistinguishable from a `from` field, colon/pipe lines never auto-detect
 * `from` beyond the 5th split — the 4th field absorbs remaining delimiters.
 * Use CSV with quoting when you need an explicit `from` alongside a tricky pass.
 */

/**
 * @typedef {{host:string,port:number,user:string,pass:string,from?:string}} Credential
 * @typedef {{line:number,raw:string,reason:string}} ParseError
 */

/** @returns {{records: Credential[], errors: ParseError[]}} */
export function parse(text) {
  const records = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    let fields;
    try {
      fields = splitLine(trimmed);
    } catch (e) {
      errors.push({ line: lineNo, raw, reason: e.message });
      return;
    }

    if (fields.length < 4) {
      errors.push({
        line: lineNo,
        raw,
        reason: `expected at least 4 fields (host, port, user, pass), got ${fields.length}`,
      });
      return;
    }

    const [host, portRaw, user, pass, from] = fields;
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) {
      errors.push({ line: lineNo, raw, reason: `invalid port "${portRaw}"` });
      return;
    }

    /** @type {Credential} */
    const record = { host, port, user, pass };
    if (from) record.from = from;
    records.push(record);
  });

  return { records, errors };
}

/**
 * Split one line into at most 5 fields.
 * - If the line contains a double quote, treat it as CSV and honor quoting.
 * - Otherwise pick the first delimiter present among `, : |`.
 */
function splitLine(line) {
  if (line.includes('"')) return splitCsv(line, 5);

  const delimiter = [',', ':', '|'].find((d) => line.includes(d));
  if (!delimiter) throw new Error('no recognized delimiter (expected : , or |)');

  const parts = line.split(delimiter);
  if (parts.length <= 5) return parts.map((p) => p.trim());

  // Cap at 5: fields 1-4 are host/port/user, then the rest rejoin as pass.
  // (host, port, user, pass-with-delimiters). No `from` in this overflow case.
  const [host, port, user, ...rest] = parts;
  return [host.trim(), port.trim(), user.trim(), rest.join(delimiter)];
}

/** Minimal RFC-4180-ish CSV splitter honoring double quotes, capped at `max` fields. */
function splitCsv(line, max) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields.slice(0, max);
}
