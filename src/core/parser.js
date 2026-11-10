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
 * A record may omit the host (and port) when the username is an email address
 * at a known provider — the host/port are then resolved at test time. Such
 * records carry `host: null` / `port: null`.
 *
 * @typedef {{host:(string|null),port:(number|null),user:string,pass:string,from?:string}} Credential
 * @typedef {{line:number,raw:string,reason:string}} ParseError
 */

/**
 * Remove exact-duplicate credentials, preserving first occurrence and order.
 * @param {Credential[]} records
 * @returns {{records: Credential[], removed: number}}
 */
export function dedupeCredentials(records) {
  const seen = new Set();
  const out = [];
  for (const r of records || []) {
    const key = credKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return { records: out, removed: (records || []).length - out.length };
}

/**
 * The identity used to dedupe a credential: host, port, user, pass, lowercased.
 * Shared so whole-text and streaming dedupe agree on what counts as a dupe.
 * @param {Credential} r
 */
export function credKey(r) {
  // Host/port/user are case-insensitive, but the PASSWORD is not: lowercasing it
  // would collapse "Secret" and "secret" into one key, silently dropping a
  // distinct credential (and, on resume, skipping it as already-tested).
  return `${(r.host || '').toLowerCase()}|${r.port || ''}|${String(r.user ?? '').toLowerCase()}|${r.pass ?? ''}`;
}

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

/**
 * Treat the input as key-value only when labels are the MAJORITY of the
 * meaningful lines — otherwise a couple of stray `From:`/`Sender:` notes in a
 * delimited bulk dump would wrongly switch modes and silently drop every
 * delimited line.
 */
function hasKeyValueLines(lines) {
  let labels = 0;
  let others = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (labelOf(raw)) labels++;
    else others++;
  }
  return labels >= 2 && labels > others;
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
    // Any repeated field starts a new record. When several user/pass pairs are
    // listed under one host, carry the shared host/port into the new record.
    if (current[field] !== undefined) {
      const carryHost = current.host;
      const carryPort = current.port;
      flush();
      current = {};
      if (field !== 'host' && carryHost !== undefined) current.host = carryHost;
      if (field !== 'port' && carryPort !== undefined) current.port = carryPort;
      startLine = i + 1;
    }
    current[field] = value;
  });
  flush();

  return { records, errors };
}

function finalizeKv(fields, line, errors) {
  for (const required of ['user', 'pass']) {
    if (fields[required] === undefined) {
      errors.push({ line, raw: `block starting at line ${line}`, reason: `missing ${required}` });
      return null;
    }
  }
  // Host is optional when the username is an email — it's discovered at test time.
  if (fields.host === undefined && !EMAIL_RE.test(fields.user || '')) {
    errors.push({
      line,
      raw: `block starting at line ${line}`,
      reason: `missing host (and ${fields.user} is not an email to resolve one from)`,
    });
    return null;
  }
  const port = isPort(fields.port) ? fields.port : null;
  return cred(fields.host, port, fields.user, fields.pass, fields.from);
}

/**
 * Parse a single delimited line into a credential. Returns `null` for a blank
 * or comment line, `{record}` on success, or `{error}` with a reason. This is
 * the per-line core shared by {@link parseDelimited} (whole-text parsing) and
 * the streaming file parser, so both treat a given line identically.
 * @param {string} raw
 * @returns {{record: Credential}|{error: string}|null}
 */
export function parseDelimitedLine(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  // A URL is not a credential. ULP combolists (url:login:pass) and raw scraped
  // URLs otherwise split on ":" into a bogus record — host="https",
  // port=<a path number>, user="//host/path" — that gets tested as a real SMTP
  // endpoint. The "scheme://" marker is unambiguous: no host:port:user:pass line
  // begins with it. Reject with a clear reason so the user sees it was skipped.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { error: 'looks like a URL, not an SMTP credential (expected host:port:user:pass or email:password)' };
  }

  // OAuth2 accounts can't ride the positional format (tokens contain the field
  // delimiters :, |, ,). They use an explicit, whitespace-separated tag line
  // parsed on its own so they still flow through the normal batch.
  if (/^oauth2\b/i.test(trimmed)) return parseOauthLine(trimmed);

  let split;
  try {
    split = splitLine(trimmed);
  } catch (e) {
    return { error: e.message };
  }

  const rec = buildRecord(split.fields, split.delim);
  return rec.error ? { error: rec.error } : { record: rec.record };
}

/**
 * Parse an OAuth2 credential line. Whitespace-separated (tokens never contain
 * spaces), tagged `oauth2` so it's unambiguous against the positional format:
 *
 *   oauth2 <user> <host> <port> <refreshToken> <clientId> <clientSecret> [accessUrl]
 *   oauth2 <user> <host> <port> token=<accessToken>
 *
 * Refresh mode lets the app mint access tokens as needed; token mode uses a
 * ready access token. Returns `{record}` (carrying `.oauth`) or `{error}`.
 * @param {string} trimmed
 * @returns {{record: Credential}|{error: string}}
 */
function parseOauthLine(trimmed) {
  const [, user, host, portStr, ...rest] = trimmed.split(/\s+/);
  if (!user || !host || !portStr) {
    return { error: 'oauth2 line needs: oauth2 <user> <host> <port> <refreshToken clientId clientSecret [accessUrl] | token=ACCESS_TOKEN>' };
  }
  if (!isPort(portStr)) return { error: `invalid port "${portStr}"` };
  const port = Number(portStr);
  if (!rest.length) return { error: 'oauth2 line missing token / refresh-token fields' };

  let oauth;
  if (/^token=/i.test(rest[0])) {
    const accessToken = rest[0].slice(rest[0].indexOf('=') + 1);
    if (!accessToken) return { error: 'oauth2 token= is empty' };
    oauth = { accessToken };
  } else {
    const [refreshToken, clientId, clientSecret, accessUrl] = rest;
    if (!refreshToken || !clientId || !clientSecret) {
      return { error: 'oauth2 refresh mode needs <refreshToken> <clientId> <clientSecret> [accessUrl]' };
    }
    oauth = { refreshToken, clientId, clientSecret };
    if (accessUrl) oauth.accessUrl = accessUrl;
  }
  return { record: { host, port, user, oauth } };
}

function parseDelimited(lines) {
  const records = [];
  const errors = [];

  lines.forEach((raw, i) => {
    const res = parseDelimitedLine(raw);
    if (!res) return;
    if (res.error) errors.push({ line: i + 1, raw, reason: res.error });
    else records.push(res.record);
  });

  return { records, errors };
}

/**
 * Split one line into fields. Quoted lines are treated as CSV. Otherwise the
 * delimiter that yields the most fields (>= 4 preferred) is chosen from
 * tab, `;`, `|`, `,`, `:`, then whitespace.
 */
function splitLine(line) {
  // Treat as CSV only when it actually looks like CSV (a comma is present).
  // A bare double-quote with no comma is almost always a character inside a
  // colon/semicolon/pipe-delimited password — routing it to the CSV splitter
  // (which only splits on commas) would collapse it to one field and drop the
  // whole credential as unparseable.
  if (line.includes('"') && line.includes(',')) return { fields: splitCsv(line), delim: ',' };

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
  // Just an email + password: host/port resolved at test time from the provider.
  if (fields.length === 2 && EMAIL_RE.test(fields[0])) {
    return userPassRecord(fields[0], fields[1]);
  }

  if (fields.length < 4) {
    return { error: `expected host, port, user, pass — or just "email password" for a known provider` };
  }

  // Standard order when the first field is a hostname: host, port, user, pass.
  // The port is tolerated even if malformed (resolved/retried at test time).
  if (isHostname(fields[0])) {
    const [host, portRaw, user, ...rest] = fields;
    const { pass, from } = splitPassFrom(rest, delim);
    if (!user || !pass) return { error: `missing username or password` };
    return { record: cred(host, isPort(portRaw) ? portRaw : null, user, pass, from) };
  }

  // Reordered input: find the numeric field (port) and a hostname field. Prefer
  // the LAST port-shaped field: common reordered forms end with the port
  // (user:pass:host:port), and a numeric password earlier in the line must not
  // be mistaken for the port.
  let portIdx = -1;
  for (let idx = fields.length - 1; idx >= 0; idx--) {
    if (isPort(fields[idx])) { portIdx = idx; break; }
  }
  if (portIdx === -1) {
    return { error: `no numeric port field found` };
  }
  const hostIdx = fields.findIndex((f, idx) => idx !== portIdx && HOSTNAME_RE.test(f) && !f.includes('@'));
  // No field looks like a real hostname (dotted, no slash/path). Reject rather
  // than fabricate a host from an arbitrary field — otherwise junk like a URL
  // path ("www.site.com/login.php") or a bare word ("randomword") would be sent
  // off to be tested as a mail server, polluting results with guaranteed-dead
  // rows that were never credentials in the first place.
  if (hostIdx === -1) {
    return { error: `no valid hostname field found (expected a dotted host like smtp.example.com)` };
  }

  const rest = fields.filter((_, idx) => idx !== portIdx && idx !== hostIdx);
  if (rest.length < 2) {
    return { error: `could not identify both username and password` };
  }
  const user = rest[0];
  const { pass, from } = splitPassFrom(rest.slice(1), delim);
  return { record: cred(fields[hostIdx], fields[portIdx], user, pass, from) };
}

function isHostname(field) {
  return HOSTNAME_RE.test(field) && !field.includes('@');
}

/**
 * Build a host-less record from an email + password. The host/port are left
 * null and discovered at test time (known provider, then guessed smtp./mail.
 * and MX hosts). Only callable when the first field is a valid email.
 */
function userPassRecord(user, pass) {
  if (!pass) return { error: `missing password` };
  return { record: cred(null, null, user, pass) };
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
  const record = {
    host: host || null,
    port: port === null || port === undefined || port === '' ? null : Number(port),
    user,
    pass,
  };
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
