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

const STANDARD_PORTS = [587, 465];

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
  if (!emailOrDomain || typeof emailOrDomain !== 'string') return null;
  const at = emailOrDomain.indexOf('@');
  if (at === -1) return null; // not an email -> cannot detect
  const domain = emailOrDomain.slice(at + 1).trim().toLowerCase();
  return PROVIDERS[domain] || null;
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Build the ordered list of (host, port) endpoints to try for a credential.
 * The user's own input is always tried first; the detected provider endpoint
 * is appended as a fallback. Duplicates are removed.
 * @param {Credential} cred
 * @returns {Candidate[]}
 */
export function candidatesFor(cred) {
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
    else for (const p of STANDARD_PORTS) add(cred.host, p, 'input');
  }

  const prov = detectProvider(cred.user);
  if (prov) for (const p of prov.ports) add(prov.host, p, 'detected');

  return out;
}
