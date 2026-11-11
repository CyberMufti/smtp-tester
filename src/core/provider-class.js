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
import { domainCountry, countryName } from './country-names.js';

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
  'Mailjet',
  'Brevo',
  'Intermedia',
  'Naver',
  'Daum',
  'UOL',
  'Terra',
  'Comcast',
  'AT&T',
  'Verizon',
  'Orange',
  'Free',
  'BT',
  'Libero',
  'Seznam',
  // Japan — carriers, ISPs/webmail, and the major domestic hosts.
  'Yahoo! Japan',
  'docomo',
  'au/KDDI',
  'SoftBank',
  'OCN',
  '@nifty',
  'BIGLOBE',
  'So-net',
  'Plala',
  'Rakuten',
  'J:COM',
  'Asahi Net',
  'Sakura Internet',
  'Xserver',
  'Lolipop',
  'GMO',
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
  ['naver.com', 'Naver'], ['daum.net', 'Daum'], ['hanmail.net', 'Daum'],
  ['uol.com.br', 'UOL'], ['bol.com.br', 'UOL'], ['terra.com.br', 'Terra'],
  ['comcast.net', 'Comcast'],
  ['att.net', 'AT&T'], ['sbcglobal.net', 'AT&T'], ['bellsouth.net', 'AT&T'], ['ameritech.net', 'AT&T'],
  ['verizon.net', 'Verizon'],
  ['orange.fr', 'Orange'], ['wanadoo.fr', 'Orange'], ['laposte.net', 'Orange'],
  ['free.fr', 'Free'],
  ['btinternet.com', 'BT'], ['bt.com', 'BT'],
  ['libero.it', 'Libero'], ['virgilio.it', 'Libero'], ['tiscali.it', 'Libero'],
  ['seznam.cz', 'Seznam'],
  // Japan — mobile carriers, ISPs, and webmail portals.
  ['yahoo.co.jp', 'Yahoo! Japan'], ['ybb.ne.jp', 'Yahoo! Japan'],
  ['docomo.ne.jp', 'docomo'],
  ['ezweb.ne.jp', 'au/KDDI'], ['au.com', 'au/KDDI'], ['dion.ne.jp', 'au/KDDI'],
  ['softbank.ne.jp', 'SoftBank'], ['i.softbank.jp', 'SoftBank'], ['vodafone.ne.jp', 'SoftBank'], ['disney.ne.jp', 'SoftBank'],
  ['ocn.ne.jp', 'OCN'],
  ['nifty.com', '@nifty'], ['nifty.ne.jp', '@nifty'],
  ['biglobe.ne.jp', 'BIGLOBE'],
  ['so-net.ne.jp', 'So-net'], ['sonet.ne.jp', 'So-net'],
  ['plala.or.jp', 'Plala'], ['plala.com', 'Plala'],
  ['rakuten.co.jp', 'Rakuten'], ['rakuten.jp', 'Rakuten'],
  ['jcom.home.ne.jp', 'J:COM'], ['jcom.zaq.ne.jp', 'J:COM'], ['zaq.ne.jp', 'J:COM'],
  ['asahi-net.or.jp', 'Asahi Net'],
]);

// Providers whose users are strongly concentrated in one country, used as a
// FALLBACK lead country only when the domain's TLD gives no signal. Global
// mailbox platforms (Gmail/Microsoft/Yahoo/hosting resellers) are intentionally
// absent — their users are everywhere, so guessing a country would mislead.
const PROVIDER_HOME_COUNTRY = {
  'NetEase': 'China', 'Tencent Exmail': 'China', 'Alibaba Mail': 'China',
  'Yandex': 'Russia', 'Mail.ru': 'Russia',
  'Optimum': 'United States', 'Spectrum/RR': 'United States', 'Mailgun': 'United States',
  'Mailjet': 'France', 'Brevo': 'France',
  'GMX/Web.de': 'Germany',
  'Naver': 'South Korea', 'Daum': 'South Korea',
  'UOL': 'Brazil', 'Terra': 'Brazil',
  'Comcast': 'United States', 'AT&T': 'United States', 'Verizon': 'United States',
  'Orange': 'France', 'Free': 'France',
  'BT': 'United Kingdom', 'Libero': 'Italy', 'Seznam': 'Czechia',
  // Japan — carriers/ISPs/hosts whose customers are overwhelmingly domestic, so
  // Japan is a safe lead-country fallback for a .com/.net on one of them (the
  // .jp ccTLD already resolves on its own via domainCountry).
  'Yahoo! Japan': 'Japan', 'docomo': 'Japan', 'au/KDDI': 'Japan', 'SoftBank': 'Japan',
  'OCN': 'Japan', '@nifty': 'Japan', 'BIGLOBE': 'Japan', 'So-net': 'Japan', 'Plala': 'Japan',
  'Rakuten': 'Japan', 'J:COM': 'Japan', 'Asahi Net': 'Japan',
  'Sakura Internet': 'Japan', 'Xserver': 'Japan', 'Lolipop': 'Japan', 'GMO': 'Japan',
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

// Buckets for which the mail server's GeoIP country IS a usable lead-country
// signal — i.e. self-hosted mail software detected from the server banner, where
// the server is plausibly the customer's own machine in their own country
// (an on-prem Exchange, a company cPanel/Exim box, a self-run Postfix/Zimbra).
//
// Every OTHER bucket is excluded on purpose: SaaS mailbox providers and hosting
// resellers (Gmail/Microsoft/Rackspace/IONOS/GoDaddy/Network Solutions/…) run
// shared, centralized — and often foreign — datacenters, so the server IP's
// country is the datacenter's, not the lead's (it reported wrong EU countries
// for US customers). The generic "Other"/"Unknown" buckets are excluded too: if
// we could not even identify the provider, the server could be any reseller's
// datacenter, so its country is not trustworthy as the lead's. In all those
// cases the server location is still surfaced to the user as a separate
// "datacenter" badge — it is just never promoted to the lead's country.
const SELF_HOSTED_BUCKETS = new Set([
  'Postfix', 'cPanel/Exim', 'Zimbra', 'Microsoft Exchange',
]);

/**
 * Whether the mail server's GeoIP country is a meaningful lead-country signal
 * for this provider — true only for self-hosted mail software (the server is
 * likely the customer's own, in their country), false for every SaaS/reseller
 * platform and for unidentified servers (the IP is just a shared datacenter).
 * @param {string} bucket
 * @returns {boolean}
 */
export function serverLocationMeaningful(bucket) {
  return SELF_HOSTED_BUCKETS.has(bucket);
}

/**
 * Resolve a lead's country from all available signals, most-trustworthy first:
 *   1. the domain's country-code TLD (.de/.co.uk — authoritative; beats a bulk tag)
 *   2. a region-locked provider's home country (a 163.com user is in China)
 *   3. the per-upload batch override (the user's assertion for this list)
 *   4. the RDAP registrant country (best-effort, already looked up by the caller)
 *   5. the mail server's GeoIP — ONLY for self-hosted software (likely the
 *      customer's own machine); never for SaaS/reseller or unidentified servers
 *   6. "Unknown"
 *
 * Pure and synchronous: the async RDAP fetch happens in the caller, which passes
 * the resolved ISO code in as `rdapCode`. All code inputs are ISO alpha-2.
 *
 * @param {{userDomain?:string, provider?:string, batchCountry?:string, rdapCode?:string, serverGeo?:string}} input
 * @returns {string} full country name or "Unknown"
 */
export function resolveLeadCountry({ userDomain = '', provider = 'Unknown', batchCountry = '', rdapCode = '', serverGeo = '' } = {}) {
  const base = String(provider).split(' — ')[0];
  let c = domainCountry(userDomain);                                      // 1
  if (c === 'Unknown') c = providerHomeCountry(base);                     // 2
  if (c === 'Unknown' && batchCountry) c = countryName(batchCountry);     // 3
  if (c === 'Unknown' && rdapCode) c = countryName(rdapCode);             // 4
  if (c === 'Unknown' && serverLocationMeaningful(base)) c = countryName(serverGeo); // 5
  return c;                                                               // 6
}

// MX / host hostname patterns → platform bucket, most specific first. For a
// custom domain, Google and Microsoft MX mean the business platforms. Security
// gateways (Mimecast/Proofpoint/Barracuda) are labeled by the gateway since the
// real mailbox is hidden behind them.
const PLATFORM_PATTERNS = [
  { re: /\b(aspmx|googlemail|google)\./i, bucket: 'Google Workspace' },
  { re: /(serverdata\.net|intermedia\.(net|com))/i, bucket: 'Intermedia' }, // before M365: hostnames contain "o365" branding
  { re: /(protection\.outlook|mail\.protection|office365|outlook\.com)/i, bucket: 'Microsoft 365' },
  { re: /(mimecast)\./i, bucket: 'Mimecast' },
  { re: /(pphosted\.com|proofpoint)/i, bucket: 'Proofpoint' },
  { re: /(barracuda(networks)?\.com|cudamail)/i, bucket: 'Barracuda' },
  { re: /zoho\./i, bucket: 'Zoho' },
  { re: /(worldnic|netsol|networksolutions)/i, bucket: 'Network Solutions' },
  { re: /secureserver\.net/i, bucket: 'GoDaddy' },
  { re: /(\bionos\b|1and1|1und1|kundenserver\.de|perfora\.net)/i, bucket: 'IONOS' },
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
  { re: /(awsapps\.com|inbound-smtp\.[^ ]*amazonaws|amazonses\.com)/i, bucket: 'Amazon WorkMail' },
  { re: /(netease\.com|mxmail\.netease|qiye163|163mx|(^|\.)163\.com\b|(^|\.)126\.com\b)/i, bucket: 'NetEase' },
  { re: /(exmail\.qq\.com|mxbiz\d*\.qq\.com|(^|\.)qq\.com\b)/i, bucket: 'Tencent Exmail' },
  { re: /(mxhichina\.com|aliyun|alibaba-inc|alimail)/i, bucket: 'Alibaba Mail' },
  { re: /mailgun\.(org|net|com)/i, bucket: 'Mailgun' },
  { re: /mailjet\.com/i, bucket: 'Mailjet' },
  { re: /(brevo\.com|sendinblue\.com)/i, bucket: 'Brevo' },
  { re: /(optimum\.net|optonline\.net)/i, bucket: 'Optimum' },
  { re: /(\brr\.com|roadrunner|twc\.com|charter\.net|spectrum\.net|rr\.com)/i, bucket: 'Spectrum/RR' },
  { re: /(yandex)\./i, bucket: 'Yandex' },
  { re: /(\.mail\.ru|mxs\.mail\.ru)/i, bucket: 'Mail.ru' },
  { re: /(gmx\.|web\.de)/i, bucket: 'GMX/Web.de' },
  { re: /(mail\.me\.com|icloud)/i, bucket: 'iCloud' },
  // Japan — must precede the generic Yahoo rule so yahoo.co.jp (Yahoo! JAPAN, a
  // separate company) isn't swept into US "Yahoo/AOL". All anchored on (^|\.) so
  // a substring like "notnifty.com" can't match. Mobile carriers, ISPs, then the
  // big domestic hosts (Sakura, Xserver, Lolipop, GMO family).
  { re: /(^|\.)(yahoo\.co\.jp|ybb\.ne\.jp)/i, bucket: 'Yahoo! Japan' },
  { re: /(^|\.)docomo\.ne\.jp/i, bucket: 'docomo' },
  { re: /(^|\.)(ezweb\.ne\.jp|dion\.ne\.jp|kddi\.(com|ne\.jp))/i, bucket: 'au/KDDI' },
  { re: /(^|\.)softbank\.(ne\.jp|jp)/i, bucket: 'SoftBank' },
  { re: /(^|\.)ocn\.ne\.jp/i, bucket: 'OCN' },
  { re: /(^|\.)nifty\.(com|ne\.jp)/i, bucket: '@nifty' },
  { re: /(^|\.)biglobe\.ne\.jp/i, bucket: 'BIGLOBE' },
  { re: /(^|\.)so-?net\.ne\.jp/i, bucket: 'So-net' },
  { re: /(^|\.)plala\.or\.jp/i, bucket: 'Plala' },
  { re: /(^|\.)(jcom\.(home|zaq)\.ne\.jp|zaq\.ne\.jp)/i, bucket: 'J:COM' },
  { re: /(^|\.)asahi-net\.or\.jp/i, bucket: 'Asahi Net' },
  { re: /(^|\.)rakuten\.(co\.jp|ne\.jp|jp)/i, bucket: 'Rakuten' },
  { re: /(^|\.)sakura\.(ne|ad)\.jp/i, bucket: 'Sakura Internet' },
  { re: /(^|\.)(xserver\.jp|xsrv\.jp)/i, bucket: 'Xserver' },
  { re: /(^|\.)lolipop\.jp/i, bucket: 'Lolipop' },
  { re: /(^|\.)(onamae\.com|heteml\.(jp|net)|muumuu\.jp|conoha\.(jp|io)|value-domain\.com|gmoserver\.jp|gmocloud\.com)/i, bucket: 'GMO' },
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

  // 2. The SMTP host the credential actually connected and authenticated to is
  // ground truth for its SENDING provider, so it beats the domain's MX. MX only
  // describes INBOUND routing, which frequently differs: a company that receives
  // its mail on Microsoft/Google/Yahoo can still send through a legacy Rackspace
  // or IONOS SMTP account. Checking MX first mislabeled those live credentials as
  // the inbound platform — a working Rackspace account showed as "Microsoft 365"
  // or "Yahoo/AOL". A host the pattern list does NOT recognize (a vanity CNAME
  // like mail.<domain>) returns null here and falls through to the MX signal
  // below, so the Rackspace-via-vanity-host case still resolves.
  const viaHost = matchPlatform([host]);
  if (viaHost) return viaHost;
  if (host && /gmail\.com$/i.test(host)) return 'Google Workspace'; // smtp.gmail.com, custom domain

  // 3. MX platform of a custom domain (inbound routing) — the fallback used when
  // the host is absent (a dead / host-less cred) or an unrecognized vanity host.
  const viaMx = matchPlatform(mxHosts);
  if (viaMx) return viaMx;

  // Reached a real but unrecognized mail host → generic hosting; otherwise we
  // simply have no signal.
  if (host || domain) return 'Other';
  return 'Unknown';
}
