/**
 * Detect when a panel login response is a BLOCK (not a real login verdict) —
 * a WAF/Cloudflare challenge, a rate-limit, or a brute-force/IP lockout. These
 * otherwise get misread as "unknown" or "invalid", which is misleading: the
 * credentials weren't actually rejected, the request was blocked. With the proxy
 * pool, a "blocked" verdict means "rotate proxy and retry".
 *
 * Shared by the cPanel/WHM/Webmail/Plesk classifiers, which call it first.
 * Returns a classification override, or null when nothing blocking is present.
 *
 * @param {{statusCode?:number, headers?:object, body?:string}} res
 * @returns {{reachable:boolean, valid:boolean, status:'blocked', detail:string}|null}
 */
export function detectPanelBlock(res) {
  if (!res) return null;
  const { statusCode, headers = {}, body = '' } = res;
  const h = JSON.stringify(headers).toLowerCase();
  const b = String(body);

  // Cloudflare / generic WAF challenge.
  if (
    /"cf-ray"|"cf-mitigated"|"x-sucuri|"x-akamai|"server":"cloudflare/.test(h) ||
    /challenge-platform|__cf_chl|just a moment|attention required|cloudflare|access denied.*(waf|firewall)|request blocked/i.test(b)
  ) {
    return { reachable: true, valid: false, status: 'blocked', detail: 'WAF / Cloudflare challenge' };
  }

  // Rate limiting.
  if (statusCode === 429 || /too many (requests|attempts|login|connections)|rate.?limit|slow down|try again (later|in a)/i.test(b)) {
    return { reachable: true, valid: false, status: 'blocked', detail: 'rate-limited' };
  }

  // cPHulk / brute-force / IP lockout.
  if (/cphulk|brute.?force|temporarily (locked|blocked|disabled|suspended)|account.{0,25}(is )?(locked|suspended|blocked)|login.{0,20}(blocked|denied|blacklisted)|ip.{0,15}(blocked|banned|blacklisted)/i.test(b)) {
    return { reachable: true, valid: false, status: 'blocked', detail: 'brute-force / IP lockout' };
  }

  return null;
}
