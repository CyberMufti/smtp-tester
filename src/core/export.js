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
