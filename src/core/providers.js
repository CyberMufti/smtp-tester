/**
 * Known SMTP provider detection and connection-candidate building.
 *
 * When a credential is missing a host (or has a host/port that may be wrong),
 * we derive the correct SMTP endpoint from the username's email domain so the
 * tester can fall back to it before declaring a credential dead.
 *
 * @typedef {import('./parser.js').Credential} Credential
 * @typedef {{host:string, port:number, source:('input'|'detected')}} Candidate
 */

// Submission ports first, then 25 as a fallback: a minority of misconfigured
// relays / open relays accept AUTH and sending on the MTA port, so a credential
// that only works on 25 isn't missed. Tried last so normal servers still match
// on 587/465 first.
const STANDARD_PORTS = [587, 465, 25];
const GUESS_PORTS = [587, 465, 2525, 25];
const GUESS_PREFIXES = ['smtp.', 'mail.', 'send.', 'mta.', 'outgoing.'];

/** Email domain -> SMTP endpoint. Ports listed most-likely first. */
const PROVIDERS = {
  'gmail.com': { host: 'smtp.gmail.com', ports: [587, 465] },
  'googlemail.com': { host: 'smtp.gmail.com', ports: [587, 465] },
  'outlook.com': { host: 'smtp-mail.outlook.com', ports: [587] },
  'hotmail.com': { host: 'smtp-mail.outlook.com', ports: [587] },
  'live.com': { host: 'smtp-mail.outlook.com', ports: [587] },
  'msn.com': { host: 'smtp-mail.outlook.com', ports: [587] },
  'office365.com': { host: 'smtp.office365.com', ports: [587] },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', ports: [587, 465] },
  'ymail.com': { host: 'smtp.mail.yahoo.com', ports: [587, 465] },
  'aol.com': { host: 'smtp.aol.com', ports: [587, 465] },
  'zoho.com': { host: 'smtp.zoho.com', ports: [587, 465] },
  'icloud.com': { host: 'smtp.mail.me.com', ports: [587] },
  'me.com': { host: 'smtp.mail.me.com', ports: [587] },
  'gmx.com': { host: 'mail.gmx.com', ports: [587, 465] },
  'gmx.net': { host: 'mail.gmx.net', ports: [587, 465] },
  'yandex.com': { host: 'smtp.yandex.com', ports: [465, 587] },
  'mail.com': { host: 'smtp.mail.com', ports: [587, 465] },
};

/**
 * Detect the SMTP endpoint for an email address.
 * @param {string} emailOrDomain
 * @returns {{host:string, ports:number[]}|null}
 */
export function detectProvider(emailOrDomain) {
  const domain = domainOf(emailOrDomain);
  return domain ? PROVIDERS[domain] || null : null;
}

/** Extract the lowercased domain from an email address, or null. */
export function domainOf(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Map a domain's MX hosts to the mail platform's real SMTP submission endpoint. */
const MX_PLATFORMS = [
  { re: /zoho\./i, host: 'smtp.zoho.com', ports: [587, 465] },
  { re: /(aspmx|google|googlemail)\./i, host: 'smtp.gmail.com', ports: [587, 465] },
  { re: /(protection\.outlook|office365|outlook)\./i, host: 'smtp.office365.com', ports: [587] },
  { re: /secureserver\.net/i, host: 'smtpout.secureserver.net', ports: [587, 465] },
  { re: /(mimecast)\./i, host: 'smtp.mailhop.net', ports: [587] },
];

export function submissionFromMx(mxHosts = []) {
  for (const mx of mxHosts) {
    const hit = MX_PLATFORMS.find((p) => p.re.test(mx));
    if (hit) return { host: hit.host, ports: hit.ports };
  }
  return null;
}

/**
 * Build the ordered list of (host, port) endpoints to try for a credential.
 *
 * Order of preference:
 *   1. the user's typed host (its port first, then standard ports as fallback)
 *   2. a known provider's authoritative endpoint (if the email matches one)
 *   3. MX hosts supplied by the caller (resolved via DNS) — host-less, unknown domain
 *   4. guessed `smtp.<domain>` / `mail.<domain>` — host-less, unknown domain
 *
 * Steps 3–4 only apply when there's no typed host and no known provider, i.e.
 * a custom-domain `email:password` whose server must be discovered.
 *
 * @param {Credential} cred
 * @param {{mxHosts?:string[], discovered?:{host:string,port:number,source?:string}[]}} [opts]
 * @returns {Candidate[]}
 */
export function candidatesFor(cred, { mxHosts = [], discovered = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (host, port, source) => {
    if (!host || !validPort(port)) return;
    const key = `${host.toLowerCase()}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ host, port, source });
  };

  if (cred.host) {
    if (validPort(cred.port)) add(cred.host, cred.port, 'input');
    // Always offer the standard ports on the input host as a fallback: a
    // valid-but-wrong port (e.g. 25 when the relay listens on 587) shouldn't
    // make a live credential read as dead.
    for (const p of STANDARD_PORTS) add(cred.host, p, 'input');
  }

  const prov = detectProvider(cred.user);
  if (prov) {
    for (const p of prov.ports) add(prov.host, p, 'detected');
    return out; // provider endpoint is authoritative; don't guess
  }

  // Custom domain with no typed host: discover the server. Try MX hosts first
  // (actual mail servers), then conventional submission hostnames.
  const domain = domainOf(cred.user);
  if (domain && !cred.host) {
    // Authoritative discovery first (SRV / autoconfig), exactly as advertised.
    for (const d of discovered) add(d.host, d.port, d.source || 'discovered');
    // Then MX records mapped to a known platform's submission host (Zoho, …).
    const viaMx = submissionFromMx(mxHosts);
    if (viaMx) for (const p of viaMx.ports) add(viaMx.host, p, 'detected');
    // Then the raw MX hosts, then conventional submission hostnames.
    for (const mx of mxHosts) for (const p of STANDARD_PORTS) add(mx, p, 'mx');
    for (const prefix of GUESS_PREFIXES) for (const p of GUESS_PORTS) add(`${prefix}${domain}`, p, 'guessed');
    // Finally the bare domain itself.
    for (const p of STANDARD_PORTS) add(domain, p, 'guessed');
  }

  return out;
}
