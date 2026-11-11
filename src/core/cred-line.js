/**
 * Display helpers for the dashboard tile drawer: turn a tester Result into a
 * `host:port:user:pass` line (for any status, including dead — falling back to
 * the credential's own host / the email domain when no endpoint was used), and
 * mask the password for on-screen display. Pure and unit-tested.
 */

/** @param {object} r a tester Result @returns {string} host:port:user:pass */
export function credLineFor(r) {
  const c = (r && r.cred) || {};
  const emailDomain = typeof c.user === 'string' && c.user.includes('@') ? c.user.split('@')[1] : '';
  const host = r?.usedHost || c.host || emailDomain || '';
  const port = r?.usedPort || c.port || '';
  return [host, port, c.user || '', c.pass || ''].join(':');
}

/** Mask the password (everything after the user) for display: host:port:user:•••• */
export function maskCredLine(line) {
  const parts = String(line == null ? '' : line).split(':');
  if (parts.length < 4) return String(line == null ? '' : line);
  const pass = parts.slice(3).join(':');
  const masked = pass ? '•'.repeat(Math.min(8, Math.max(4, pass.length))) : '';
  return [...parts.slice(0, 3), masked].join(':');
}
