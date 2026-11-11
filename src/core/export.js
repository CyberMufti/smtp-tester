/**
 * Export working (non-dead) credentials to a plain-text file, using the host
 * and port that actually worked (detected/fallback endpoint included), grouped
 * by placement. The output is itself valid input for the parser — comment lines
 * are ignored on re-import — so you can feed a "working list" straight back in.
 *
 * @typedef {import('./tester.js').Result} Result
 */
import { classifyProvider } from './provider-class.js';
import { deliverabilityScore } from './deliverability.js';
import { warmupRecommendation } from './warmup.js';

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
    const host = r.usedHost || r.cred?.host || (r.cred?.user?.split('@')[1] || '');
    const group = safeName(hostGroupKey(host));
    // A throttled/blocked login isn't a working credential (its validity is
    // unproven) — keep it out of the valid files and give it its own retry list.
    if (r.blocked) {
      add(`blocked/${group}.txt`, workingCredLine(r));
    } else if (st !== 'dead') {
      // Working SMTP credential lines — never for a dead SMTP.
      const line = workingCredLine(r);
      if (st === 'unverified') add(`unverified/${group}.txt`, line);
      else if (st === 'limited') add(`limited/${group}.txt`, line);
      else add(`valid/${group}.txt`, line); // valid / inbox / spam / unknown-placement
    }
    // Panel logins that worked are exported regardless of the SMTP status: a dead
    // SMTP (wrong mail password) can still have a valid cPanel/WHM/webmail login.
    if (r.panels) {
      const user = r.cred?.user || '?';
      const pass = r.cred?.pass || '?';
      // Every control-panel / mail-protocol login that worked, grouped under
      // panels/<type>_valid.txt (cpanel, whm, webmail, ssh, plesk, directadmin,
      // cyberpanel, webmin, hestia, imap, pop3). Format: host:port:user:pass,
      // using the port that actually accepted the login when the probe reports it.
      for (const [type, hit] of Object.entries(r.panels)) {
        if (hit?.valid) add(`panels/${safeName(type)}_valid.txt`, panelLine(hit.host || host, hit.port, user, pass));
      }
    }
  }
  return files;
}

/** A control-panel login line: host:port:user:pass, or host:user:pass if no port. */
function panelLine(host, port, user, pass) {
  return port ? `${host}:${port}:${user}:${pass}` : `${host}:${user}:${pass}`;
}

/**
 * A lead is "alive" for the Leads export when the mailbox is provably real: the
 * SMTP worked (any non-dead status), or the server refused the login but
 * confirmed the account exists (dead + userExists === true). A dead result that
 * reports no such user, or that never connected, is not a usable lead.
 */
function isAliveLead(r) {
  // A throttled/blocked login was never evaluated by the server, so it's neither
  // a confirmed-working account nor a proven address — not a lead.
  if (r.blocked) return false;
  return r.status !== 'dead' || r.userExists === true;
}

/**
 * Group VALID verified addresses (from the Email Verifier) into one file per
 * provider + country, for the Desktop result/verified/ folder:
 *   <Provider>_<Country>.txt   e.g. Yahoo_AOL_United_States.txt
 * Only status === 'valid' (confirmed-existing) addresses are written. Returns a
 * map of filename -> email addresses. Pure and unit-tested.
 *
 * @param {Array<{email:string,status:string,provider?:string,country?:string}>} results
 * @returns {Record<string, string[]>}
 */
export function verifiedFolderFiles(results) {
  const files = {};
  for (const r of results || []) {
    if (r.status !== 'valid' || !r.email) continue;
    const name = `${safeName(r.provider || 'Unknown')}_${safeName(r.country || 'Unknown')}.txt`;
    (files[name] ||= []).push(r.email);
  }
  return files;
}

/** Which "SMTP result" status folder a working result belongs in. */
function smtpStatusFolder(status) {
  if (status === 'inbox') return 'inbox';
  if (status === 'spam') return 'spam';
  if (status === 'unverified') return 'unverified';
  return 'unconfirmed'; // valid / unknown / limited — accepted, not confirmed
}

/**
 * Lay out a run for the Desktop `result/` folder as two views:
 *
 *   SMTP result/<status>/<host>.txt   working SMTPs by delivery status
 *                                     (inbox | spam | unverified | unconfirmed),
 *                                     grouped by registrable host domain; dead
 *                                     credentials are excluded here.
 *   Leads/hosts/<Provider>/<Provider>_<Country>.txt   every tested lead (dead
 *   Leads/countries/<Country>/<Provider>.txt          included), by provider
 *                                     bucket and server country (full name) —
 *                                     two cross-sections of the same leads.
 *
 * Panel hits keep their flat cpanel_valid.txt etc. at the top level. Returns a
 * map of relative path -> lines; the caller creates directories. Pure and
 * unit-tested. provider/country come from the tester; absent values fall back
 * to a live classification / "Unknown".
 *
 * @param {Result[]} results
 * @returns {Record<string, string[]>}
 */
export function resultFolderFiles(results) {
  const files = {};
  const add = (name, line) => { (files[name] ||= []).push(line); };
  for (const r of results || []) {
    const st = r.status;
    const host = r.usedHost || r.cred?.host || (r.cred?.user?.split('@')[1] || '');
    const line = workingCredLine(r);

    // SMTP result view — working SMTPs by delivery status, then host. A blocked
    // login goes to its own 'blocked' folder (unproven, re-test from another IP),
    // not into an 'unconfirmed'/working bucket.
    if (r.blocked) {
      add(`SMTP result/blocked/${safeName(hostGroupKey(host))}.txt`, line);
    } else if (st !== 'dead') {
      add(`SMTP result/${smtpStatusFolder(st)}/${safeName(hostGroupKey(host))}.txt`, line);
    }

    // Leads view — ALIVE leads only (the SMTP worked, or the server confirmed
    // the account exists even though the password was wrong). Account-not-found
    // and pure connection failures are not provable leads, so they're dropped.
    // By provider bucket and server country (full name), two cross-sections.
    if (isAliveLead(r)) {
      const provider = safeName(r.provider || classifyProvider({ user: r.cred?.user, host }) || 'Unknown');
      // Lead country = the domain's ccTLD country (accurate), NOT the mail
      // server's GeoIP location (which, for cloud providers, is just a datacenter).
      const country = safeName(r.domainCountry || 'Unknown');
      // Leads are an address list — the EMAIL only, nothing attached. (The
      // re-importable host:port:user:pass lives under SMTP result/ and panels/.)
      const email = r.cred?.user || '';
      if (email) {
        add(`Leads/hosts/${provider}/${provider}_${country}.txt`, email);
        add(`Leads/countries/${country}/${provider}.txt`, email);
      }
    }

    if (r.panels) {
      const user = r.cred?.user || '?';
      const pass = r.cred?.pass || '?';
      // Every control-panel / mail-protocol login that worked, grouped under
      // panels/<type>_valid.txt (cpanel, whm, webmail, ssh, plesk, directadmin,
      // cyberpanel, webmin, hestia, imap, pop3). Format: host:port:user:pass.
      for (const [type, hit] of Object.entries(r.panels)) {
        if (hit?.valid) add(`panels/${safeName(type)}_valid.txt`, panelLine(hit.host || host, hit.port, user, pass));
      }
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

/**
 * The statuses that mean a message was *confirmed delivered* to a seed mailbox
 * (found over IMAP), as opposed to merely accepted by the SMTP server. "valid"
 * only proves the server returned 250 OK — the mail may still have been dropped
 * or filtered before any inbox — so it is deliberately excluded here.
 */
export const CONFIRMED_STATUSES = ['inbox', 'spam'];

/** Header lines for a confirmed-only TXT export. */
export function confirmedTxtHeaderLines(generatedAt = '') {
  const lines = ['# SMTP Tester — confirmed delivered (landed in a seed inbox/spam)'];
  if (generatedAt) lines.push(`# generated ${generatedAt}`);
  lines.push('# format: host:port:username:password', '');
  return lines;
}

/**
 * Export only the credentials whose test message was confirmed delivered to a
 * seed mailbox (status inbox or spam), as re-importable host:port:user:pass
 * lines. Unlike {@link toWorkingTxt} this never includes "valid" (accepted but
 * unconfirmed) results — it is the trustworthy set.
 *
 * @param {Result[]} results
 * @param {{generatedAt?:string}} [opts]
 * @returns {string}
 */
export function toConfirmedTxt(results, { generatedAt = '' } = {}) {
  const lines = confirmedTxtHeaderLines(generatedAt);
  for (const r of results || []) {
    if (CONFIRMED_STATUSES.includes(r.status)) lines.push(workingCredLine(r));
  }
  return lines.join('\n') + '\n';
}

const CSV_COLUMNS = ['host', 'port', 'user', 'status', 'grade', 'score', 'warmupDaily', 'provider', 'country', 'userExists', 'usedHost', 'usedPort', 'reason', 'latencyMs', 'placement', 'token'];

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
  const dg = deliverabilityScore(r);
  const wu = warmupRecommendation(r);
  return [
    r.cred.host || '(auto)',
    r.cred.port || '',
    r.cred.user,
    r.status,
    dg ? dg.grade : '',
    dg ? dg.score : '',
    wu ? wu.dailyCap : '',
    r.provider || '',
    r.domainCountry || '',
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
  let s = String(value ?? '');
  // Neutralize spreadsheet formula injection (CWE-1236): a cell starting with
  // = + @ (or a tab/CR) is executed as a formula by Excel/Sheets, and these
  // cells can carry attacker-controlled server text (banners, reject reasons).
  // A leading '-' is only risky when it starts a formula, not a negative number.
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d*\.?\d+$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
