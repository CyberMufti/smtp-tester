/**
 * Export working (non-dead) credentials to a plain-text file, using the host
 * and port that actually worked (detected/fallback endpoint included), grouped
 * by placement. The output is itself valid input for the parser — comment lines
 * are ignored on re-import — so you can feed a "working list" straight back in.
 *
 * @typedef {import('./tester.js').Result} Result
 */

export const WORKING_GROUPS = [
  ['inbox', 'INBOX'],
  ['spam', 'SPAM'],
  ['valid', 'VALID / SENT'],
  ['unverified', 'UNVERIFIED (sending domain missing SPF/DMARC)'],
  ['limited', 'LIMITED (login works but rate/quota-limited)'],
  ['unknown', 'UNKNOWN PLACEMENT'],
];
const GROUPS = WORKING_GROUPS;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Emit one credential line. Normally `host:port:user:pass`, but if the password
 * ends in a segment that looks like an email, that would be misread as a `from`
 * field on re-import — so quote the whole line as CSV, where the password stays
 * a single field.
 */
function credLine(host, port, user, pass) {
  const tail = pass.includes(':') ? pass.slice(pass.lastIndexOf(':') + 1) : '';
  if (tail && EMAIL_RE.test(tail)) {
    return `${host},${port},${user},"${pass.replace(/"/g, '""')}"`;
  }
  return `${host}:${port}:${user}:${pass}`;
}

/** The `# ...` header lines for a working-credentials TXT export. */
export function workingTxtHeaderLines(generatedAt = '') {
  const lines = ['# SMTP Tester — working credentials'];
  if (generatedAt) lines.push(`# generated ${generatedAt}`);
  lines.push('# format: host:port:username:password', '');
  return lines;
}

/** The re-importable `host:port:user:pass` line for one working result. */
export function workingCredLine(r) {
  const host = r.usedHost || r.cred.host || '';
  const port = r.usedPort || r.cred.port || '';
  return credLine(host, port, r.cred.user, r.cred.pass);
}

// Multi-label public suffixes we care about, so host "mail.acme.co.uk" groups
// as "acme.co.uk" rather than "co.uk". Not exhaustive — a pragmatic subset.
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'co.jp', 'co.nz', 'co.za', 'co.in', 'co.kr',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.tr', 'com.sg', 'com.hk',
]);

/**
 * Group key for a sending host: its registrable domain, so every host that
 * belongs to one provider lands together — smtp.gmail.com / smtp-relay.gmail.com
 * -> "gmail.com", smtp.mail.yahoo.com -> "yahoo.com". A bare IP groups under
 * itself; a missing/unusable host groups under "unknown".
 * @param {string} host
 * @returns {string}
 */
export function hostGroupKey(host) {
  const h = String(host || '').toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (!h) return 'unknown';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return h; // IPv4/IPv6 -> itself
  const labels = h.split('.').filter(Boolean);
  if (labels.length < 2) return 'unknown';
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

/** Filesystem-safe version of a group key (no path separators / traversal). */
function safeName(key) {
  return String(key).replace(/[^a-z0-9._-]/gi, '_') || 'unknown';
}

/**
 * Split working results into per-host download files for the "Save by Host"
 * action. Returns a map of relative path -> lines (the caller creates any
 * subdirectories). SMTPs are grouped by their host's registrable domain:
 *   valid/gmail.com.txt, valid/yahoo.com.txt, valid/unknown.txt, ...
 * Auth-gated ('unverified') SMTPs are kept wholly separate from deliverable
 * ones, under unverified/<host>.txt, so a valid-by-host file never contains an
 * unverified credential. Panel hits stay grouped by their protocol. Each SMTP
 * line is the re-importable host:port:user:pass. Pure and unit-testable.
 *
 * @param {Result[]} results
 * @returns {Record<string, string[]>}
 */
export function hostGroupedExportFiles(results) {
  const files = {};
  const add = (name, line) => { (files[name] ||= []).push(line); };
  for (const r of results || []) {
    const st = r.status;
    if (st === 'dead') continue;
    const host = r.usedHost || r.cred?.host || (r.cred?.user?.split('@')[1] || '');
    const group = safeName(hostGroupKey(host));
    const line = workingCredLine(r);
    if (st === 'unverified') add(`unverified/${group}.txt`, line);
    else if (st === 'limited') add(`limited/${group}.txt`, line);
    else add(`valid/${group}.txt`, line); // valid / inbox / spam / unknown-placement
    if (r.panels) {
      const user = r.cred?.user || '?';
      const pass = r.cred?.pass || '?';
      const pLine = `${host}:${user}:${pass}`;
      if (r.panels.cpanel?.valid) add('cpanel_valid.txt', pLine);
      if (r.panels.webmail?.valid) add('webmail_valid.txt', pLine);
      if (r.panels.whm?.valid) add('whm_valid.txt', pLine);
      if (r.panels.ssh?.valid) add('ssh_valid.txt', pLine);
    }
  }
  return files;
}

/**
 * @param {Result[]} results
 * @param {{generatedAt?:string}} [opts]
 * @returns {string}
 */
export function toWorkingTxt(results, { generatedAt = '' } = {}) {
  const working = (results || []).filter((r) => r.status !== 'dead');

  const lines = workingTxtHeaderLines(generatedAt);

  for (const [key, label] of GROUPS) {
    const rows = working.filter((r) => r.status === key);
    if (!rows.length) continue;
    lines.push(`# === ${label} (${rows.length}) ===`);
    for (const r of rows) lines.push(workingCredLine(r));
    lines.push('');
  }

  return lines.join('\n');
}

const CSV_COLUMNS = ['host', 'port', 'user', 'status', 'userExists', 'usedHost', 'usedPort', 'reason', 'latencyMs', 'placement', 'token'];

/** 'yes'/'no' when the account-existence probe had a verdict, else blank. */
function userExistsCell(r) {
  if (r.userExists === true) return 'yes';
  if (r.userExists === false) return 'no';
  return '';
}

/** Header row for the CSV export. */
export function csvHeaderLine() {
  return CSV_COLUMNS.join(',');
}

/** One CSV row for a result. */
export function csvRowLine(r) {
  const placement = (r.perSeed || [])
    .map((s) => `${s.label}=${s.error ? 'error' : s.folder || 'not found'}`)
    .join('; ');
  return [
    r.cred.host || '(auto)',
    r.cred.port || '',
    r.cred.user,
    r.status,
    userExistsCell(r),
    r.usedHost || '',
    r.usedPort || '',
    r.reason,
    r.latencyMs,
    placement,
    r.token || '',
  ]
    .map(csvCell)
    .join(',');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
