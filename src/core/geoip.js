/**
 * Server-location GeoIP: map an SMTP host to the ISO country of the IP it
 * resolves to. Country-level only, offline — the actual IP→country database is
 * injected (so this module is network- and DB-free for tests, and degrades to
 * "Unknown" when no database is loaded).
 *
 * @typedef {{ resolve4:(host:string)=>Promise<string[]>, lookup:(ip:string)=>(string|null) }} GeoDeps
 */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /:/;

/**
 * Resolve one host to an ISO country code, or "Unknown". Never throws.
 * An IP literal is looked up directly (no DNS).
 * @param {string} host
 * @param {GeoDeps} deps
 * @returns {Promise<string>}
 */
export async function countryOf(host, deps) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return 'Unknown';
  try {
    let ips;
    if (IPV4_RE.test(h) || IPV6_RE.test(h)) ips = [h];
    else ips = await deps.resolve4(h);
    for (const ip of ips || []) {
      const cc = deps.lookup(ip);
      if (cc) return String(cc).toUpperCase();
    }
  } catch {
    /* fall through to Unknown */
  }
  return 'Unknown';
}

/**
 * Wrap {@link countryOf} with a per-host cache, so a bulk run resolves each
 * mail host at most once. Returns an async `(host) => countryCode` function.
 * @param {GeoDeps} deps
 */
export function makeGeoResolver(deps) {
  const cache = new Map();
  return async function resolveCountry(host) {
    const key = String(host || '').trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const cc = await countryOf(key, deps);
    cache.set(key, cc);
    return cc;
  };
}

/**
 * Build a `lookup(ip)->countryCode|null` backed by a MaxMind/DB-IP `.mmdb`
 * database at `dbPath`, using the optional `maxmind` reader. Best-effort: if the
 * package or file is missing/unreadable, returns a lookup that always yields
 * null, so GeoIP silently degrades to "Unknown" instead of breaking a run.
 *
 * @param {string} dbPath
 * @param {{ open?: (p:string)=>Promise<any> }} [opts] — injectable reader for tests
 * @returns {Promise<(ip:string)=>(string|null)>}
 */
export async function loadCountryLookup(dbPath, opts = {}) {
  try {
    let open = opts.open;
    if (!open) {
      const maxmind = await import('maxmind').then((m) => m.default || m).catch(() => null);
      if (!maxmind) return () => null;
      open = (p) => maxmind.open(p);
    }
    const reader = await open(dbPath);
    return (ip) => {
      try {
        const rec = reader.get(ip);
        return rec?.country?.iso_code || rec?.registered_country?.iso_code || null;
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
}
