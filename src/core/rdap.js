/**
 * Best-effort registrant-country lookup over RDAP (the structured, JSON
 * successor to WHOIS — RFC 9083). Used only to FILL a lead country that the
 * domain's ccTLD, a region-locked provider, and the per-upload override all left
 * "Unknown". It is deliberately conservative: it returns a country ONLY when the
 * registrant's country is actually published and the registrant is not a
 * privacy/proxy service (whose country would be the proxy's, not the lead's).
 * Anything else — redacted data (the GDPR norm for gTLDs), a proxy registrant, a
 * network error, a timeout — returns null so the caller falls through to the
 * next signal rather than showing a wrong country.
 *
 * Pure parsing (parseRdapCountry) is unit-tested without the network; the fetch
 * is injected so tests never go online.
 */
import { countryCodeFromName } from './country-names.js';

// Registrant names/orgs that signal a privacy or proxy service rather than the
// real owner — their address country is the service's, so it must be ignored.
const PRIVACY_RE = /privacy|proxy|redact|withheld|not\s*disclosed|data\s*protect|whois\s*?guard|contact\s*privacy|identity\s*protect|gdpr|domains?\s*by\s*proxy|perfect\s*privacy|private\s*by\s*design|registration\s*private|protected\s*domain/i;

/** The jCard property array of an RDAP entity, or [] when absent/malformed. */
function vcardProps(entity) {
  const arr = entity?.vcardArray;
  if (!Array.isArray(arr) || arr[0] !== 'vcard' || !Array.isArray(arr[1])) return [];
  return arr[1].filter((p) => Array.isArray(p) && p.length >= 4);
}

/** One jCard property by name (case-insensitive): {params, value} or null. */
function propValue(props, name) {
  const p = props.find((x) => String(x[0]).toLowerCase() === name);
  return p ? { params: p[1] || {}, value: p[3] } : null;
}

/**
 * Extract the registrant country from a parsed RDAP domain response.
 * @param {any} json
 * @returns {{country:string|null, reason:('ok'|'privacy'|'redacted'|'none')}}
 */
export function parseRdapCountry(json) {
  const entities = Array.isArray(json?.entities) ? json.entities : [];
  const registrant = entities.find(
    (e) => Array.isArray(e?.roles) && e.roles.map(String).includes('registrant'),
  );
  const wasRedacted = () => (Array.isArray(json?.redacted) && json.redacted.length > 0 ? 'redacted' : 'none');

  if (!registrant) return { country: null, reason: wasRedacted() };

  const props = vcardProps(registrant);

  // A privacy/proxy registrant: the address country belongs to the service.
  const label = ['fn', 'org']
    .map((n) => propValue(props, n)?.value)
    .map((v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : ''))
    .join(' ');
  if (label && PRIVACY_RE.test(label)) return { country: null, reason: 'privacy' };

  const adr = propValue(props, 'adr');
  if (adr) {
    // Prefer the ISO `cc` parameter (modern RDAP); fall back to the 7th ADR
    // component, which is the country NAME.
    const cc = adr.params?.cc || adr.params?.CC;
    if (typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc)) return { country: cc.toUpperCase(), reason: 'ok' };
    const val = adr.value;
    const name = Array.isArray(val) ? val[6] : typeof val === 'string' ? val : '';
    const code = name ? countryCodeFromName(name) : null;
    if (code) return { country: code, reason: 'ok' };
  }

  return { country: null, reason: wasRedacted() };
}

/** Fetch one RDAP URL and parse its JSON; null on any failure. Never throws. */
async function fetchRdapJson(url, fetchFn, timeoutMs) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/rdap+json' } });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The registrar's RDAP domain URL from a thin registry response (the rel=related
 * link), or null. Thin registries (.com/.net via Verisign) carry no registrant;
 * the real contact data lives at this registrar endpoint.
 * @param {any} json
 * @returns {string|null}
 */
export function registrarRdapUrl(json) {
  const links = Array.isArray(json?.links) ? json.links : [];
  const hit = links.find(
    (l) => l && l.rel === 'related' && typeof l.href === 'string' && /^https:\/\//i.test(l.href) && /\/domain\//i.test(l.href),
  );
  return hit ? hit.href : null;
}

/**
 * Look up a domain's registrant country over RDAP. Returns an ISO alpha-2 code,
 * or null on any failure / redaction / privacy registrant. Never throws.
 *
 * Two hops: the registry response first; if it carries no usable country (a thin
 * .com/.net registry record is registrar-only), follow its rel=related link to
 * the REGISTRAR's RDAP, where the registrant lives. A privacy/proxy registrant
 * at either hop still yields null (skip-proxy policy — the proxy's country is not
 * reliably the owner's).
 *
 * @param {string} domain registrable domain (e.g. "acme.com")
 * @param {{fetchFn?:Function, timeoutMs?:number, baseUrl?:string}} opts
 * @returns {Promise<string|null>}
 */
export async function rdapCountry(domain, { fetchFn, timeoutMs = 6000, baseUrl = 'https://rdap.org/domain/' } = {}) {
  if (!domain || typeof fetchFn !== 'function') return null;

  const first = await fetchRdapJson(baseUrl + encodeURIComponent(domain), fetchFn, timeoutMs);
  if (!first) return null;
  const direct = parseRdapCountry(first);
  if (direct.country) return direct.country;
  // A proxy was already identified at the registry hop — chasing the registrar
  // would only find the same proxy, so stop.
  if (direct.reason === 'privacy') return null;

  // Thin registry: the registrant country is one hop away, at the registrar.
  const registrar = registrarRdapUrl(first);
  if (!registrar) return null;
  const second = await fetchRdapJson(registrar, fetchFn, timeoutMs);
  if (!second) return null;
  return parseRdapCountry(second).country;
}
