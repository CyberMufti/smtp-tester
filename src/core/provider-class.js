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
  'IONOS',
  'OVH',
  'Rackspace',
  'Namecheap',
  'Proton Mail',
  'Fastmail',
  'iCloud',
  'Yandex',
  'Mail.ru',
  'GMX/Web.de',
  'Titan',
  'HostGator',
  'Bluehost',
  'Hostinger',
  'SiteGround',
  'Amazon WorkMail',
  'NetEase',
  'Tencent Exmail',
  'Alibaba Mail',
  'Optimum',
  'Spectrum/RR',
  'Mailgun',
  'Intermedia',
  // Security gateways (the real mailbox sits behind them).
  'Mimecast',
  'Proofpoint',
  'Barracuda',
  // Self-hosted mail software, detected from the server banner (see
  // classifyFromBanner) when domain/MX give no platform signal.
  'Zimbra',
  'cPanel/Exim',
  'Postfix',
  'Microsoft Exchange',
  'Other',
  'Unknown',
];

// Server-banner signatures, highest-priority first. Zimbra ships a customized
// Postfix, so its marker must beat the generic Postfix one.
const BANNER_PATTERNS = [
  { re: /zimbra/i, bucket: 'Zimbra' },
  { re: /(microsoft esmtp|exchange)/i, bucket: 'Microsoft Exchange' },
  { re: /\bexim\b/i, bucket: 'cPanel/Exim' },
  { re: /\bpostfix\b/i, bucket: 'Postfix' },
];

/**
 * Classify self-hosted mail software from an SMTP/IMAP server banner (the
 * greeting + EHLO response, or an IMAP capability line). Returns a provider
 * bucket, or null when nothing recognizable is present.
 * @param {string} bannerText
 * @returns {string|null}
 */
export function classifyFromBanner(bannerText) {
  const t = String(bannerText || '');
  if (!t) return null;
  const hit = BANNER_PATTERNS.find((p) => p.re.test(t));
  return hit ? hit.bucket : null;
}

// Consumer email domains → bucket (the domain alone is authoritative).
const CONSUMER_DOMAINS = new Map([
  ['gmail.com', 'Gmail'], ['googlemail.com', 'Gmail'],
  ['outlook.com', 'Outlook/Hotmail'], ['hotmail.com', 'Outlook/Hotmail'],
  ['live.com', 'Outlook/Hotmail'], ['msn.com', 'Outlook/Hotmail'],
  ['yahoo.com', 'Yahoo/AOL'], ['ymail.com', 'Yahoo/AOL'], ['rocketmail.com', 'Yahoo/AOL'], ['aol.com', 'Yahoo/AOL'],
  ['zoho.com', 'Zoho'],
  ['gmx.com', 'GMX/Web.de'], ['gmx.net', 'GMX/Web.de'], ['gmx.de', 'GMX/Web.de'], ['web.de', 'GMX/Web.de'],
  ['proton.me', 'Proton Mail'], ['protonmail.com', 'Proton Mail'], ['pm.me', 'Proton Mail'],
  ['icloud.com', 'iCloud'], ['me.com', 'iCloud'], ['mac.com', 'iCloud'],
  ['yandex.com', 'Yandex'], ['yandex.ru', 'Yandex'], ['ya.ru', 'Yandex'],
  ['mail.ru', 'Mail.ru'], ['bk.ru', 'Mail.ru'], ['inbox.ru', 'Mail.ru'], ['list.ru', 'Mail.ru'],
  ['fastmail.com', 'Fastmail'],
  ['163.com', 'NetEase'], ['126.com', 'NetEase'], ['yeah.net', 'NetEase'],
  ['qq.com', 'Tencent Exmail'], ['foxmail.com', 'Tencent Exmail'],
  ['aliyun.com', 'Alibaba Mail'],
  ['optimum.net', 'Optimum'], ['optonline.net', 'Optimum'],
  ['rr.com', 'Spectrum/RR'], ['roadrunner.com', 'Spectrum/RR'], ['twc.com', 'Spectrum/RR'],
  ['charter.net', 'Spectrum/RR'], ['spectrum.net', 'Spectrum/RR'], ['cfl.rr.com', 'Spectrum/RR'],
]);

// Providers whose users are strongly concentrated in one country, used as a
// FALLBACK lead country only when the domain's TLD gives no signal. Global
// mailbox platforms (Gmail/Microsoft/Yahoo/hosting resellers) are intentionally
// absent — their users are everywhere, so guessing a country would mislead.
const PROVIDER_HOME_COUNTRY = {
  'NetEase': 'China', 'Tencent Exmail': 'China', 'Alibaba Mail': 'China',
  'Yandex': 'Russia', 'Mail.ru': 'Russia',
  'Optimum': 'United States', 'Spectrum/RR': 'United States', 'Mailgun': 'United States',
  'GMX/Web.de': 'Germany',
};

/**
 * The home country for a provider bucket, or "Unknown" for global providers.
 * Used only as a fallback after the domain's country TLD.
 * @param {string} bucket
 * @returns {string}
 */
export function providerHomeCountry(bucket) {
  return PROVIDER_HOME_COUNTRY[bucket] || 'Unknown';
}

// Global/anycast platforms whose MX geolocates to an edge datacenter, so the
// server's country says nothing about where the lead is. For every OTHER
// provider (regional hosts, self-hosted servers), the mailbox lives in a real
// datacenter the customer chose, so the server country is a usable fallback.
const GLOBAL_EDGE_PROVIDERS = new Set([
  'Gmail', 'Google Workspace', 'Microsoft 365', 'Outlook/Hotmail', 'Yahoo/AOL',
  'Zoho', 'iCloud', 'Proton Mail', 'Fastmail', 'Yandex', 'Mail.ru', 'GMX/Web.de',
  'NetEase', 'Tencent Exmail', 'Alibaba Mail', 'Amazon WorkMail',
  'Mimecast', 'Proofpoint', 'Barracuda',
]);

/**
 * Whether the mail server's GeoIP country is a meaningful lead-country signal
 * for this provider — true for regional/self-hosted servers, false for global
 * anycast platforms where the IP is just the nearest edge.
 * @param {string} bucket
 * @returns {boolean}
 */
export function serverLocationMeaningful(bucket) {
  return !GLOBAL_EDGE_PROVIDERS.has(bucket);
}

// MX / host hostname patterns → platform bucket, most specific first. For a
// custom domain, Google and Microsoft MX mean the business platforms. Security
// gateways (Mimecast/Proofpoint/Barracuda) are labeled by the gateway since the
// real mailbox is hidden behind them.
const PLATFORM_PATTERNS = [
  { re: /(aspmx|googlemail|google)\./i, bucket: 'Google Workspace' },
  { re: /(serverdata\.net|intermedia\.(net|com))/i, bucket: 'Intermedia' }, // before M365: hostnames contain "o365" branding
  { re: /(protection\.outlook|mail\.protection|office365|outlook\.com)/i, bucket: 'Microsoft 365' },
  { re: /(mimecast)\./i, bucket: 'Mimecast' },
  { re: /(pphosted\.com|proofpoint)/i, bucket: 'Proofpoint' },
  { re: /(barracuda(networks)?\.com|cudamail)/i, bucket: 'Barracuda' },
  { re: /zoho\./i, bucket: 'Zoho' },
  { re: /(worldnic|netsol|networksolutions)/i, bucket: 'Network Solutions' },
  { re: /secureserver\.net/i, bucket: 'GoDaddy' },
  { re: /(\bionos\b|1and1|1und1|kundenserver\.de|perfora\.net|\bonline\.de)/i, bucket: 'IONOS' },
  { re: /\bovh\.(net|com|ca|us|co\.uk)\b/i, bucket: 'OVH' },
  { re: /emailsrvr\.com/i, bucket: 'Rackspace' },
  { re: /(privateemail\.com|registrar-servers\.com)/i, bucket: 'Namecheap' },
  { re: /(protonmail|proton\.me)/i, bucket: 'Proton Mail' },
  { re: /(messagingengine\.com|fastmail)/i, bucket: 'Fastmail' },
  { re: /titan\.email/i, bucket: 'Titan' },
  { re: /(hostgator|websitewelcome\.com|launchpad.*hostgator)/i, bucket: 'HostGator' },
  { re: /bluehost/i, bucket: 'Bluehost' },
  { re: /hostinger/i, bucket: 'Hostinger' },
  { re: /siteground/i, bucket: 'SiteGround' },
  { re: /(amazonaws\.com|awsapps\.com)/i, bucket: 'Amazon WorkMail' },
  { re: /(netease\.com|mxmail\.netease|qiye163|163mx|\b163\.com|126\.com)/i, bucket: 'NetEase' },
  { re: /(exmail\.qq\.com|mxbiz\d*\.qq\.com|\bqq\.com)/i, bucket: 'Tencent Exmail' },
  { re: /(mxhichina\.com|aliyun|alibaba-inc|alimail)/i, bucket: 'Alibaba Mail' },
  { re: /mailgun\.(org|net)/i, bucket: 'Mailgun' },
  { re: /(optimum\.net|optonline\.net)/i, bucket: 'Optimum' },
  { re: /(\brr\.com|roadrunner|twc\.com|charter\.net|spectrum\.net|rr\.com)/i, bucket: 'Spectrum/RR' },
  { re: /(yandex)\./i, bucket: 'Yandex' },
  { re: /(\.mail\.ru|mxs\.mail\.ru)/i, bucket: 'Mail.ru' },
  { re: /(gmx\.|web\.de)/i, bucket: 'GMX/Web.de' },
  { re: /(mail\.me\.com|icloud)/i, bucket: 'iCloud' },
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
