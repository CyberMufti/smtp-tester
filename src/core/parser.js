/**
 * Parse bulk SMTP credentials from pasted text or an uploaded file, in
 * whatever shape the source hands them out.
 *
 * Two input styles are auto-detected:
 *
 * 1. **Delimited lines** — one credential per line, fields separated by any of
 *    `: ; , |`, a tab, or whitespace:
 *      host:port:user:pass[:from]
 *      host,port,user,pass        host 587 user pass        host|port|user|pass
 *    Fields do not have to be in order: the numeric field is taken as the port
 *    and the hostname-looking field as the host, so `user pass host port` also
 *    works. A password may contain the delimiter; a trailing field is treated
 *    as `from` only when it is a recognizable email.
 *
 * 2. **Labeled key-value blocks** — when lines look like `Label: value` or
 *    `Label = value`, each blank-line-separated block becomes one credential.
 *    Labels are matched by synonym (Host/Server/SMTP, Port, User/Login/Email,
 *    Password/Pwd/Key, From/Sender), case-insensitively.
 *
 * Blank lines and lines beginning with `#` are ignored (outside KV blocks a
 * blank line is just a separator).
 *
 * @typedef {{host:string,port:number,user:string,pass:string,from?:string}} Credential
 * @typedef {{line:number,raw:string,reason:string}} ParseError
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOSTNAME_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/i;

const LABELS = {
  host: ['host', 'hostname', 'server', 'smtp', 'smtphost', 'smtp host', 'smtp server', 'mail server', 'mailserver', 'outgoing server', 'outgoing mail server'],
  port: ['port', 'smtp port', 'smtpport', 'server port'],
  user: ['user', 'username', 'user name', 'login', 'account', 'email', 'e-mail', 'smtp user', 'smtp username', 'smtp login', 'user/email'],
  pass: ['pass', 'password', 'passwd', 'pwd', 'secret', 'smtp password', 'smtp pass', 'key', 'api key', 'apikey', 'api_key', 'access key'],
  from: ['from', 'from address', 'from email', 'sender', 'sender address'],
};

/** Reverse-lookup: normalized label text -> field name. */
const LABEL_TO_FIELD = (() => {
  const map = new Map();
  for (const [field, synonyms] of Object.entries(LABELS)) {
    for (const s of synonyms) map.set(s, field);
  }
  return map;
})();

function isPort(value) {
  if (!/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/** @param {string} text @returns {{records: Credential[], errors: ParseError[]}} */
export function parse(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  return hasKeyValueLines(lines) ? parseKeyValue(lines) : parseDelimited(lines);
}

/** True when enough lines look like `Label: value` to treat the input as KV. */
function hasKeyValueLines(lines) {
  let kv = 0;
  for (const raw of lines) {
    const field = labelOf(raw);
    if (field) kv++;
  }
  return kv >= 2;
}

/** If a line is `Label: value` / `Label = value` with a known label, return its field name. */
function labelOf(raw) {
  const m = String(raw).match(/^\s*([a-z][a-z /_-]*?)\s*[:=]\s*(.+?)\s*$/i);
  if (!m) return null;
  const key = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  return LABEL_TO_FIELD.get(key) || null;
}

function labelValueOf(raw) {
  const m = String(raw).match(/^\s*([a-z][a-z /_-]*?)\s*[:=]\s*(.+?)\s*$/i);
  return m ? m[2].trim() : null;
}

function parseKeyValue(lines) {
  const records = [];
  const errors = [];
  let current = null;
  let startLine = 0;

  const flush = () => {
    if (!current) return;
    const rec = finalizeKv(current, startLine, errors);
    if (rec) records.push(rec);
    current = null;
  };

  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      flush();
      return;
    }
    const field = labelOf(raw);
    if (!field) return; // ignore stray non-label lines inside KV input
    const value = labelValueOf(raw);
    if (!current) {
      current = {};
      startLine = i + 1;
    }
    // A repeated host label starts a new record.
    if (field === 'host' && current.host !== undefined) {
      flush();
      current = {};
      startLine = i + 1;
    }
    current[field] = value;
  });
  flush();

  return { records, errors };
}

function finalizeKv(fields, line, errors) {
  for (const required of ['host', 'port', 'user', 'pass']) {
    if (fields[required] === undefined) {
      errors.push({ line, raw: `block starting at line ${line}`, reason: `missing ${required}` });
      return null;
    }
  }
  if (!isPort(fields.port)) {
    errors.push({ line, raw: `block starting at line ${line}`, reason: `invalid port "${fields.port}"` });
    return null;
  }
  /** @type {Credential} */
  const rec = { host: fields.host, port: Number(fields.port), user: fields.user, pass: fields.pass };
  if (fields.from) rec.from = fields.from;
  return rec;
}

function parseDelimited(lines) {
  const records = [];
  const errors = [];

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    let split;
    try {
      split = splitLine(trimmed);
    } catch (e) {
      errors.push({ line: lineNo, raw, reason: e.message });
      return;
    }

    const rec = buildRecord(split.fields, split.delim);
    if (rec.error) {
      errors.push({ line: lineNo, raw, reason: rec.error });
    } else {
      records.push(rec.record);
    }
  });

  return { records, errors };
}

/**
 * Split one line into fields. Quoted lines are treated as CSV. Otherwise the
 * delimiter that yields the most fields (>= 4 preferred) is chosen from
 * tab, `;`, `|`, `,`, `:`, then whitespace.
 */
function splitLine(line) {
  if (line.includes('"')) return { fields: splitCsv(line), delim: ',' };

  const candidates = ['\t', ';', '|', ',', ':'];
  let best = null;
  for (const d of candidates) {
    if (!line.includes(d)) continue;
    const parts = line.split(d).map((p) => p.trim());
    if (parts.length >= 4) return { fields: parts, delim: d }; // first explicit delimiter giving a full record wins
    if (!best || parts.length > best.fields.length) best = { fields: parts, delim: d };
  }

  const ws = line.split(/\s+/).map((p) => p.trim()).filter(Boolean);
  if (ws.length >= 4) return { fields: ws, delim: ' ' };
  if (best && best.fields.length >= ws.length) return best;
  if (ws.length) return { fields: ws, delim: ' ' };
  throw new Error('no recognized delimiter (expected : ; , | tab or spaces)');
}

/**
 * Turn an array of fields into a Credential, detecting roles.
 * Prefers the standard order (host, port, user, pass) when field[1] is a port;
 * otherwise finds the numeric field as the port and a hostname-looking field
 * as the host, with the rest becoming user/pass in order.
 */
function buildRecord(fields, delim) {
  if (fields.length < 4) {
    return { error: `expected at least 4 fields (host, port, user, pass), got ${fields.length}` };
  }

  // Standard positional order: host : port : user : pass [: from]
  if (isPort(fields[1])) {
    const [host, port, user, ...rest] = fields;
    const { pass, from } = splitPassFrom(rest, delim);
    return { record: cred(host, port, user, pass, from) };
  }

  // Role detection for reordered input.
  const portIdx = fields.findIndex(isPort);
  if (portIdx === -1) {
    return { error: `no numeric port field found` };
  }
  let hostIdx = fields.findIndex((f, idx) => idx !== portIdx && HOSTNAME_RE.test(f) && !f.includes('@'));
  if (hostIdx === -1) hostIdx = fields.findIndex((_, idx) => idx !== portIdx);

  const rest = fields.filter((_, idx) => idx !== portIdx && idx !== hostIdx);
  if (rest.length < 2) {
    return { error: `could not identify both username and password` };
  }
  const user = rest[0];
  const { pass, from } = splitPassFrom(rest.slice(1), delim);
  return { record: cred(fields[hostIdx], fields[portIdx], user, pass, from) };
}

/**
 * A trailing email in the leftover fields is `from`; otherwise all of it is the
 * password, rejoined with the delimiter it was split on so embedded delimiters
 * survive (a whitespace-split password rejoins with a single space).
 */
function splitPassFrom(rest, delim) {
  const glue = delim === ' ' ? ' ' : delim;
  if (rest.length >= 2 && EMAIL_RE.test(rest[rest.length - 1])) {
    return { pass: rest.slice(0, -1).join(glue), from: rest[rest.length - 1] };
  }
  return { pass: rest.join(glue), from: undefined };
}

function cred(host, port, user, pass, from) {
  /** @type {Credential} */
  const record = { host, port: Number(port), user, pass };
  if (from) record.from = from;
  return record;
}

/** Minimal RFC-4180-ish CSV splitter honoring double quotes. */
function splitCsv(line) {
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
  return fields;
}
