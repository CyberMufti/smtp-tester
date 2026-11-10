/**
 * cPanel/WHM/Webmail serve the SAME login form on two ports: a plain-HTTP port
 * and a TLS port. Hitting the plain port with HTTPS (or vice-versa) fails the
 * handshake and the panel is wrongly reported unreachable. This maps a port to
 * the right scheme so each is probed correctly.
 *
 *   cPanel : 2082 http · 2083 https
 *   WHM    : 2086 http · 2087 https
 *   Webmail: 2095 http · 2096 https
 *   plus 80/http, 443·8443/https. Unknown ports default to https (most panels
 *   are TLS).
 */
const PLAIN_PORTS = new Set([2082, 2086, 2095, 2077, 2079, 80, 2080]);
const SSL_PORTS = new Set([2083, 2087, 2096, 2078, 8443, 443]);

/** @param {number} port @returns {'http'|'https'} */
export function panelScheme(port) {
  const p = Number(port);
  if (PLAIN_PORTS.has(p)) return 'http';
  if (SSL_PORTS.has(p)) return 'https';
  return 'https';
}
