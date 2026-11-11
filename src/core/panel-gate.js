/**
 * Decide whether to run the control-panel fan-out (cPanel/webmail/WHM/SSH/
 * IMAP/POP3/...) for a credential.
 *
 * Panels exist to catch credentials that work on a host's panels even when
 * SMTP does not — so an SMTP *auth* or *send* failure is exactly when panels
 * matter most and must still run. Two cases are worth skipping:
 *
 *   - `deadReason === 'connect'`: after all SMTP retries the host could not be
 *     reached at all. HTTPS/SSH/IMAP panels on that host will only time out —
 *     pure wasted work (and a throughput sink) at scale.
 *   - `lockSkipped`: we deliberately did not test this account to avoid locking
 *     it; firing a dozen panel logins would hammer the account we just spared.
 *
 * Also skipped: consumer / SaaS mailbox providers, transactional ESPs, and
 * security gateways — their domains are the provider's own (gmail.com,
 * yahoo.com, …) or a hosted mail platform, so they NEVER expose a customer
 * cPanel/WHM/webmail. Probing them is pure waste and produced false positives
 * (e.g. yahoo.com 302-redirecting an unknown /webmail path read as a "valid"
 * webmail login). Custom-domain business platforms (Google Workspace / Microsoft
 * 365) and "Other"/"Unknown" are NOT skipped — those domains may still have
 * separate cPanel web hosting worth checking.
 *
 * @param {{ status?: string, deadReason?: string, lockSkipped?: boolean, provider?: string } | null | undefined} result
 * @returns {boolean}
 */
const NO_PANEL_PROVIDERS = new Set([
  // Consumer webmail (the domain is the provider's own).
  'Gmail', 'Outlook/Hotmail', 'Yahoo/AOL', 'iCloud', 'Proton Mail', 'Fastmail', 'Zoho',
  'GMX/Web.de', 'Yandex', 'Mail.ru', 'NetEase', 'Tencent Exmail', 'Alibaba Mail', 'Amazon WorkMail',
  // Consumer ISPs / portals.
  'Optimum', 'Spectrum/RR', 'Comcast', 'AT&T', 'Verizon', 'Cox', 'CenturyLink', 'Frontier', 'Earthlink',
  'Sky', 'Virgin Media', 'TalkTalk', 'Telstra', 'Rogers', 'Bell', 'Telus', 'Shaw', 'T-Online',
  'Orange', 'Free', 'BT', 'Libero', 'Seznam', 'Naver', 'Daum', 'UOL', 'Terra',
  'Yahoo! Japan', 'docomo', 'au/KDDI', 'SoftBank', 'OCN', '@nifty', 'BIGLOBE', 'So-net', 'Plala', 'Rakuten', 'J:COM', 'Asahi Net',
  // Transactional ESPs and security gateways (hosted platforms, no customer panel).
  'Mailgun', 'Mailjet', 'Brevo', 'SendGrid', 'Amazon SES', 'Postmark', 'SparkPost', 'Mandrill',
  'Mailchimp', 'SMTP2GO', 'Elastic Email', 'MailerSend',
  'Mimecast', 'Proofpoint', 'Barracuda', 'Cisco IronPort', 'TrendMicro', 'Forcepoint', 'Sophos',
]);

export function shouldRunPanelChecks(result) {
  if (!result) return false;
  if (result.lockSkipped) return false;
  if (result.status === 'dead' && result.deadReason === 'connect') return false;
  if (result.provider && NO_PANEL_PROVIDERS.has(String(result.provider).split(' — ')[0])) return false;
  return true;
}
