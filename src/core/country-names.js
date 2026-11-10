/**
 * ISO 3166-1 alpha-2 country code → English country name, for human-readable
 * GeoIP labels in the Leads export ("Yahoo_United_States.txt"). An unmapped
 * code returns itself; a missing/"Unknown" code returns "Unknown".
 */
const NAMES = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AQ: 'Antarctica', AR: 'Argentina',
  AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba', AX: 'Aland Islands', AZ: 'Azerbaijan',
  BA: 'Bosnia and Herzegovina', BB: 'Barbados', BD: 'Bangladesh', BE: 'Belgium', BF: 'Burkina Faso',
  BG: 'Bulgaria', BH: 'Bahrain', BI: 'Burundi', BJ: 'Benin', BL: 'Saint Barthelemy', BM: 'Bermuda',
  BN: 'Brunei', BO: 'Bolivia', BQ: 'Bonaire', BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan', BV: 'Bouvet Island',
  BW: 'Botswana', BY: 'Belarus', BZ: 'Belize', CA: 'Canada', CC: 'Cocos Islands', CD: 'DR Congo',
  CF: 'Central African Republic', CG: 'Congo', CH: 'Switzerland', CI: 'Ivory Coast', CK: 'Cook Islands',
  CL: 'Chile', CM: 'Cameroon', CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CV: 'Cape Verde',
  CW: 'Curacao', CX: 'Christmas Island', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DJ: 'Djibouti',
  DK: 'Denmark', DM: 'Dominica', DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia',
  EG: 'Egypt', EH: 'Western Sahara', ER: 'Eritrea', ES: 'Spain', ET: 'Ethiopia', FI: 'Finland', FJ: 'Fiji',
  FK: 'Falkland Islands', FM: 'Micronesia', FO: 'Faroe Islands', FR: 'France', GA: 'Gabon',
  GB: 'United Kingdom', GD: 'Grenada', GE: 'Georgia', GF: 'French Guiana', GG: 'Guernsey', GH: 'Ghana',
  GI: 'Gibraltar', GL: 'Greenland', GM: 'Gambia', GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea',
  GR: 'Greece', GS: 'South Georgia', GT: 'Guatemala', GU: 'Guam', GW: 'Guinea-Bissau', GY: 'Guyana',
  HK: 'Hong Kong', HM: 'Heard Island', HN: 'Honduras', HR: 'Croatia', HT: 'Haiti', HU: 'Hungary',
  ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IM: 'Isle of Man', IN: 'India', IO: 'British Indian Ocean Territory',
  IQ: 'Iraq', IR: 'Iran', IS: 'Iceland', IT: 'Italy', JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan',
  KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros', KN: 'Saint Kitts and Nevis',
  KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait', KY: 'Cayman Islands', KZ: 'Kazakhstan', LA: 'Laos',
  LB: 'Lebanon', LC: 'Saint Lucia', LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia', LS: 'Lesotho',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MC: 'Monaco', MD: 'Moldova',
  ME: 'Montenegro', MF: 'Saint Martin', MG: 'Madagascar', MH: 'Marshall Islands', MK: 'North Macedonia',
  ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia', MO: 'Macao', MP: 'Northern Mariana Islands', MQ: 'Martinique',
  MR: 'Mauritania', MS: 'Montserrat', MT: 'Malta', MU: 'Mauritius', MV: 'Maldives', MW: 'Malawi', MX: 'Mexico',
  MY: 'Malaysia', MZ: 'Mozambique', NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger', NF: 'Norfolk Island',
  NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NR: 'Nauru', NU: 'Niue',
  NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru', PF: 'French Polynesia', PG: 'Papua New Guinea',
  PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PM: 'Saint Pierre and Miquelon', PN: 'Pitcairn',
  PR: 'Puerto Rico', PS: 'Palestine', PT: 'Portugal', PW: 'Palau', PY: 'Paraguay', QA: 'Qatar',
  RE: 'Reunion', RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia',
  SB: 'Solomon Islands', SC: 'Seychelles', SD: 'Sudan', SE: 'Sweden', SG: 'Singapore', SH: 'Saint Helena',
  SI: 'Slovenia', SJ: 'Svalbard and Jan Mayen', SK: 'Slovakia', SL: 'Sierra Leone', SM: 'San Marino',
  SN: 'Senegal', SO: 'Somalia', SR: 'Suriname', SS: 'South Sudan', ST: 'Sao Tome and Principe',
  SV: 'El Salvador', SX: 'Sint Maarten', SY: 'Syria', SZ: 'Eswatini', TC: 'Turks and Caicos Islands',
  TD: 'Chad', TF: 'French Southern Territories', TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan', TK: 'Tokelau',
  TL: 'Timor-Leste', TM: 'Turkmenistan', TN: 'Tunisia', TO: 'Tonga', TR: 'Turkey', TT: 'Trinidad and Tobago',
  TV: 'Tuvalu', TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda', UM: 'U.S. Minor Outlying Islands',
  US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VA: 'Vatican City', VC: 'Saint Vincent and the Grenadines',
  VE: 'Venezuela', VG: 'British Virgin Islands', VI: 'U.S. Virgin Islands', VN: 'Vietnam', VU: 'Vanuatu',
  WF: 'Wallis and Futuna', WS: 'Samoa', YE: 'Yemen', YT: 'Mayotte', ZA: 'South Africa', ZM: 'Zambia',
  ZW: 'Zimbabwe',
};

/**
 * @param {string|null|undefined} code ISO alpha-2 code (any case), 'Unknown', or empty
 * @returns {string} full country name, the code itself if unmapped, or 'Unknown'
 */
export function countryName(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || c === 'UNKNOWN') return 'Unknown';
  return NAMES[c] || c;
}

// Reverse lookup (name -> ISO code), plus a few common aliases/spellings so a
// WHOIS/RDAP country NAME (when no ISO `cc` parameter is present) still maps.
const CODE_BY_NAME = new Map(Object.entries(NAMES).map(([code, name]) => [name.toLowerCase(), code]));
const NAME_ALIASES = {
  'united states of america': 'US', 'usa': 'US', 'u.s.a.': 'US', 'u.s.': 'US', 'america': 'US',
  'uk': 'GB', 'u.k.': 'GB', 'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'republic of korea': 'KR', 'korea, republic of': 'KR', 'south korea': 'KR',
  'russian federation': 'RU', 'czech republic': 'CZ', 'viet nam': 'VN',
  'united arab emirates (the)': 'AE', 'the netherlands': 'NL', 'holland': 'NL',
};

/**
 * ISO alpha-2 code for a full country name (any case), or null if unrecognized.
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function countryCodeFromName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return NAME_ALIASES[n] || CODE_BY_NAME.get(n) || null;
}

/**
 * All known countries as {code, name}, sorted by name — for the UI country
 * dropdown (the per-upload "lead country" override).
 * @returns {{code:string, name:string}[]}
 */
export function countryList() {
  return Object.entries(NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A few ccTLDs whose ISO code differs from the TLD label.
const CCTLD_ALIAS = { uk: 'GB', su: 'RU', ac: 'SH', eu: 'Unknown' };
// ccTLDs sold/used globally as vanity domains — not a reliable country signal.
const VANITY_CCTLD = new Set(['io', 'co', 'me', 'tv', 'ai', 'cc', 'ws', 'fm', 'to', 'ly', 'gg', 'sh', 'nu', 'la', 'vc', 'gd', 'cx', 'st', 'ad', 'is']);

/**
 * The lead's country inferred from the domain's country-code TLD — the accurate
 * signal for where a lead is, independent of where its mail server is hosted.
 * Generic gTLDs (.com/.net/.org/…) and vanity ccTLDs (.io/.co/.me/…) give no
 * country and return "Unknown".
 *
 * @param {string} domain e.g. "acme.co.uk"
 * @returns {string} full country name or "Unknown"
 */
export function domainCountry(domain) {
  const tld = String(domain || '').trim().toLowerCase().split('.').filter(Boolean).pop() || '';
  if (tld.length !== 2 || VANITY_CCTLD.has(tld)) return 'Unknown';
  const code = CCTLD_ALIAS[tld] || tld.toUpperCase();
  if (code === 'Unknown') return 'Unknown';
  return countryName(code);
}
