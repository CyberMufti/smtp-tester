/**
 * Classify a credential's mail provider into a coarse, user-facing bucket for
 * the leads filter ("Gmail", "Microsoft 365", "Network Solutions", ...).
 *
 * Signal priority, strongest first:
 *   1. a consumer email domain (gmail.com, outlook.com, ...) — unambiguous
 *   2. the domain's MX platform (custom domain on Google/Microsoft/Zoho/...)
 *   3. the SMTP host actually used
 * When a custom domain rides Google/Microsoft infrastructure it is "Google
 * Workspace" / "Microsoft 365" rather than the consumer "Gmail" / "Outlook".
 *
 * Pure and unit-tested — the MX/host data is resolved elsewhere and passed in.
 */
import { domainOf } from './providers.js';

export const PROVIDER_BUCKETS = [
  'Gmail',
  'Google Workspace',
  'Microsoft 365',
  'Outlook/Hotmail',
  'Yahoo/AOL',
  'Zoho',
  'GoDaddy',
  'Network Solutions',
  'Other',
  'Unknown',
];

// Consumer email domains → bucket (the domain alone is authoritative).
const CONSUMER_DOMAINS = new Map([
  ['gmail.com', 'Gmail'], ['googlemail.com', 'Gmail'],
  ['outlook.com', 'Outlook/Hotmail'], ['hotmail.com', 'Outlook/Hotmail'],
  ['live.com', 'Outlook/Hotmail'], ['msn.com', 'Outlook/Hotmail'],
  ['yahoo.com', 'Yahoo/AOL'], ['ymail.com', 'Yahoo/AOL'], ['aol.com', 'Yahoo/AOL'],
  ['zoho.com', 'Zoho'],
]);

// MX / host hostname patterns → platform bucket. For a custom domain, Google and
// Microsoft MX mean the business platforms, not the consumer mailbox.
const PLATFORM_PATTERNS = [
  { re: /(aspmx|googlemail|google)\./i, bucket: 'Google Workspace' },
  { re: /(protection\.outlook|mail\.protection|office365|outlook\.com)/i, bucket: 'Microsoft 365' },
  { re: /zoho\./i, bucket: 'Zoho' },
  { re: /(worldnic|netsol|networksolutions)\./i, bucket: 'Network Solutions' },
  { re: /secureserver\.net/i, bucket: 'GoDaddy' },
  { re: /(yahoodns|yahoo)\./i, bucket: 'Yahoo/AOL' },
];

function matchPlatform(hostnames) {
  for (const h of hostnames) {
    if (!h) continue;
    const hit = PLATFORM_PATTERNS.find((p) => p.re.test(h));
    if (hit) return hit.bucket;
  }
  return null;
}

/**
 * @param {{ user?:string, host?:string, mxHosts?:string[] }} input
 * @returns {string} one of PROVIDER_BUCKETS
 */
export function classifyProvider({ user, host, mxHosts = [] } = {}) {
  const domain = domainOf(user || '');

  // 1. Consumer domain is unambiguous.
  if (domain && CONSUMER_DOMAINS.has(domain)) return CONSUMER_DOMAINS.get(domain);

  // 2. MX platform of a custom domain.
  const viaMx = matchPlatform(mxHosts);
  if (viaMx) return viaMx;

  // 3. The SMTP host actually used. A Google/Microsoft host on a non-consumer
  // domain is the business platform.
  const viaHost = matchPlatform([host]);
  if (viaHost) return viaHost;
  if (host && /gmail\.com$/i.test(host)) return 'Google Workspace'; // smtp.gmail.com, custom domain

  // Reached a real but unrecognized mail host → generic hosting; otherwise we
  // simply have no signal.
  if (host || domain) return 'Other';
  return 'Unknown';
}
