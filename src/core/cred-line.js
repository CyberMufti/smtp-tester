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

/**
 * The https login URL for a control-panel hit, so the user can open it directly
 * instead of deciphering host:port. cPanel/WHM sit on their own port; cPanel
 * webmail is the portal on :2096/:2095, or /webmail on 443.
 * @param {string} type 'cpanel'|'whm'|'webmail'|...
 * @param {string} host @param {number|string} port
 */
export function panelUrlFor(type, host, port) {
  const p = Number(port) || 0;
  if (type === 'webmail') {
    if (p === 2096 || p === 2095) return `https://${host}:${p}`;                 // cPanel webmail portal
    return p && p !== 443 ? `https://${host}:${p}/webmail` : `https://${host}/webmail`;
  }
  return p && p !== 443 ? `https://${host}:${p}` : `https://${host}`;
}

/**
 * A ready-to-use control-panel login for a VALID panel hit (cpanel/whm/webmail):
 * `<login-url> | <user> | <pass>` — the direct URL plus the credentials, instead
 * of a bare host:port. Null when that panel wasn't valid.
 * @param {object} r a tester Result @param {string} type 'cpanel'|'whm'|'webmail'
 * @returns {string|null}
 */
export function panelLineFor(r, type) {
  const hit = r && r.panels && r.panels[type];
  if (!hit || !hit.valid) return null;
  const c = r.cred || {};
  const host = hit.host || r.usedHost || c.host || (typeof c.user === 'string' && c.user.includes('@') ? c.user.split('@')[1] : '') || '';
  return `${panelUrlFor(type, host, hit.port)} | ${c.user || ''} | ${c.pass || ''}`;
}

/** Mask the password (final ` | ` field) of a panel login line for display. */
export function maskPanelLine(line) {
  const parts = String(line == null ? '' : line).split(' | ');
  if (parts.length < 2) return String(line == null ? '' : line);
  const pass = parts[parts.length - 1];
  parts[parts.length - 1] = pass ? '•'.repeat(Math.min(8, Math.max(4, pass.length))) : '';
  return parts.join(' | ');
}

/** Mask the password (everything after the user) for display: host:port:user:•••• */
export function maskCredLine(line) {
  const parts = String(line == null ? '' : line).split(':');
  if (parts.length < 4) return String(line == null ? '' : line);
  const pass = parts.slice(3).join(':');
  const masked = pass ? '•'.repeat(Math.min(8, Math.max(4, pass.length))) : '';
  return [...parts.slice(0, 3), masked].join(':');
}
