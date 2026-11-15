/**
 * Passwordless email verification: given an address (no credential), determine
 * whether the mailbox exists, using an SMTP RCPT-TO probe (needs outbound port
 * 25) or — for Microsoft 365 tenants — Microsoft's IfExistsResult over HTTP.
 * Also flags catch-all domains, disposable domains, and role addresses, and
 * attaches the provider + country classification.
 *
 * All I/O is injected via deps so the orchestration is unit-testable offline.
 *
 * @typedef {{
 *   resolveMx:(domain:string)=>Promise<string[]>,
 *   enumerate:(email:string, opts:{host:string,port:number})=>Promise<{exists:boolean|'unknown'}>,
 *   msRealm:(email:string)=>Promise<{nameSpaceType:string, ifExists?:string}>,
 *   geoResolver?:(host:string)=>Promise<string>,
 * }} VerifyDeps
 */
import { classifyProvider, providerHomeCountry, serverLocationMeaningful, usesMicrosoftRealm, rcptProbeReliable } from './provider-class.js';
import { domainCountry, countryName } from './country-names.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Common disposable / throwaway mail domains (a pragmatic subset — matched on
// the domain or any parent domain, so subdomains are covered too).
const DISPOSABLE = new Set([
  'mailinator.com', 'temp-mail.org', 'tempmail.com', 'guerrillamail.com', 'guerrillamail.info',
  '10minutemail.com', 'yopmail.com', 'throwawaymail.com', 'getnada.com', 'sharklasers.com',
  'trashmail.com', 'fakeinbox.com', 'maildrop.cc', 'dispostable.com', 'mintemail.com',
  'mailnesia.com', 'tempinbox.com', 'spam4.me', 'mohmal.com', 'emailondeck.com', 'tempr.email',
  'moakt.com', 'luxusmail.org', 'inboxbear.com', 'tmpmail.org', 'tmail.ws',
]);

const ROLE_PREFIXES = new Set([
  'admin', 'administrator', 'info', 'support', 'sales', 'contact', 'help', 'office', 'billing',
  'noreply', 'no-reply', 'postmaster', 'webmaster', 'hostmaster', 'abuse', 'marketing', 'hr',
  'jobs', 'careers', 'enquiries', 'enquiry', 'team', 'service', 'services', 'mail', 'hello',
]);

/** Is a domain (or a parent of it) a known disposable mail provider? */
export function isDisposable(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return false;
  const parts = d.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/** Is an address a generic role mailbox (info@, admin@, …) rather than a person? */
export function isRoleBased(email) {
  const local = String(email || '').split('@')[0].trim().toLowerCase();
  return ROLE_PREFIXES.has(local);
}

/** Map the gathered signals to a final verification verdict. */
export function verificationStatus({ syntaxValid, hasMx, catchAll, exists }) {
  if (!syntaxValid) return 'invalid-syntax';
  if (!hasMx) return 'no-mx';
  if (catchAll) return 'catch-all';
  if (exists === 'yes') return 'valid';
  if (exists === 'no') return 'invalid';
  return 'unknown';
}

const RANDOM_LOCAL = () => 'zz' + Math.abs(Date.now() % 100000) + 'verifyprobe';

function toExists(v) {
  if (v === true || v === 'yes') return 'yes';
  if (v === false || v === 'no') return 'no';
  return 'unknown';
}

/**
 * Verify one email address. Never throws — any probe failure degrades to
 * exists:'unknown'. Returns a structured result.
 * @param {string} email
 * @param {VerifyDeps} deps
 */
export async function verifyEmail(email, deps) {
  const addr = String(email || '').trim();
  const base = { email: addr, exists: 'unknown', catchAll: false, hasMx: false, provider: 'Unknown', country: 'Unknown', disposable: false, roleBased: false };

  if (!EMAIL_RE.test(addr)) return { ...base, syntaxValid: false, status: 'invalid-syntax' };
  base.syntaxValid = true;

  const domain = addr.split('@')[1].toLowerCase();
  base.disposable = isDisposable(domain);
  base.roleBased = isRoleBased(addr);

  let mx = [];
  try { mx = (await deps.resolveMx(domain)) || []; } catch { mx = []; }
  base.hasMx = mx.length > 0;
  base.provider = classifyProvider({ user: addr, host: mx[0], mxHosts: mx });

  if (!base.hasMx) return { ...base, status: 'no-mx' };

  // Existence probe. Microsoft webmail (org M365 AND consumer Outlook/Hotmail)
  // is checked over Microsoft's HTTPS endpoint, which needs no port 25 and is
  // the most reliable signal available for those addresses.
  if (usesMicrosoftRealm(base.provider) && typeof deps.msRealm === 'function') {
    try {
      const realm = await deps.msRealm(addr);
      base.exists = toExists(realm?.ifExists);
    } catch { /* unknown */ }
  } else if (typeof deps.enumerate === 'function') {
    try {
      // Catch-all first: if a random address is accepted, individual existence
      // can't be trusted.
      const probe = await deps.enumerate(`${RANDOM_LOCAL()}@${domain}`, { host: mx[0], port: 25 });
      if (probe?.exists === true) {
        base.catchAll = true;
      } else {
        const res = await deps.enumerate(addr, { host: mx[0], port: 25 });
        // Consumer webmail that defeats RCPT probing returns the same code for
        // real and fake mailboxes, so a "no" here is not a real non-existence —
        // report unknown instead of a misleading "invalid".
        base.exists = rcptProbeReliable(base.provider) ? toExists(res?.exists) : 'unknown';
      }
    } catch { /* unknown */ }
  }

  // Country (same model as the tester).
  let c = domainCountry(domain);
  if (c === 'Unknown') c = providerHomeCountry(base.provider);
  if (c === 'Unknown' && serverLocationMeaningful(base.provider) && typeof deps.geoResolver === 'function') {
    try { c = countryName(await deps.geoResolver(mx[0])); } catch { /* Unknown */ }
  }
  base.country = c;

  base.status = verificationStatus(base);
  return base;
}
