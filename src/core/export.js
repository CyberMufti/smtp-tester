/**
 * Export working (non-dead) credentials to a plain-text file, using the host
 * and port that actually worked (detected/fallback endpoint included), grouped
 * by placement. The output is itself valid input for the parser — comment lines
 * are ignored on re-import — so you can feed a "working list" straight back in.
 *
 * @typedef {import('./tester.js').Result} Result
 */

const GROUPS = [
  ['inbox', 'INBOX'],
  ['spam', 'SPAM'],
  ['valid', 'VALID / SENT'],
  ['unknown', 'UNKNOWN PLACEMENT'],
];

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

/**
 * @param {Result[]} results
 * @param {{generatedAt?:string}} [opts]
 * @returns {string}
 */
export function toWorkingTxt(results, { generatedAt = '' } = {}) {
  const working = (results || []).filter((r) => r.status !== 'dead');

  const lines = ['# SMTP Tester — working credentials'];
  if (generatedAt) lines.push(`# generated ${generatedAt}`);
  lines.push('# format: host:port:username:password', '');

  for (const [key, label] of GROUPS) {
    const rows = working.filter((r) => r.status === key);
    if (!rows.length) continue;
    lines.push(`# === ${label} (${rows.length}) ===`);
    for (const r of rows) {
      const host = r.usedHost || r.cred.host || '';
      const port = r.usedPort || r.cred.port || '';
      lines.push(credLine(host, port, r.cred.user, r.cred.pass));
    }
    lines.push('');
  }

  return lines.join('\n');
}
