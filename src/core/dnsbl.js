/**
 * DNS blocklist (DNSBL) lookup for a sending IP.
 *
 * A DNSBL is queried by reversing the IP octets, appending the zone, and doing
 * an A lookup: if it resolves (to a 127.0.0.x code), the IP is listed. The DNS
 * resolver is injected so this is unit-testable and network-free in CI.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const DEFAULT_ZONES = [
  'zen.spamhaus.org',
  'b.barracudacentral.org',
  'bl.spamcop.net',
  'dnsbl.sorbs.net',
];

/** @param {string} ip @returns {string} */
export function reverseIp(ip) {
  return ip.split('.').reverse().join('.');
}

/** @param {string} ip @param {string} zone @returns {string} */
export function queryName(ip, zone) {
  return `${reverseIp(ip)}.${zone}`;
}

function isIpv4(ip) {
  const m = IPV4_RE.exec(ip);
  return !!m && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

/**
 * Check an IPv4 address against a set of DNSBL zones.
 * @param {string} ip
 * @param {{resolve4:(name:string)=>Promise<string[]>}} deps
 * @param {string[]} [zones]
 * @returns {Promise<{ip:string, listed:boolean, lists:string[], error?:string}>}
 */
export async function checkIp(ip, { resolve4 }, zones = DEFAULT_ZONES) {
  if (!isIpv4(ip)) {
    return { ip, listed: false, lists: [], error: `not an IPv4 address: ${ip}` };
  }
  const results = await Promise.all(
    zones.map(async (zone) => {
      try {
        const answers = await resolve4(queryName(ip, zone));
        return Array.isArray(answers) && answers.length > 0 ? zone : null;
      } catch {
        return null; // NXDOMAIN / not listed
      }
    }),
  );
  const lists = results.filter(Boolean);
  return { ip, listed: lists.length > 0, lists };
}
