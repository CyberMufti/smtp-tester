/**
 * cPanel login check for hosting accounts you operate.
 *
 * For a batch of your own cPanel accounts (host + username + password), confirm
 * which logins still work and which panels are up — so you can audit 50 sites at
 * once instead of signing into each by hand (e.g. after a contractor leaves).
 *
 * It uses cPanel's own login endpoint with `login_only=1`, which answers with a
 * small JSON object (`status`, `security_token`) instead of a full dashboard —
 * so the result is parsed, not scraped. The classification is a pure, unit-
 * tested function; the HTTPS request is injected so the logic is network-free in
 * tests and so a SOCKS variant can be supplied later.
 *
 * @typedef {{host:string, user:string, pass:string, port?:number}} CpanelTarget
 * @typedef {{statusCode?:number, headers?:Record<string,string>, body?:string, error?:string}} HttpResponse
 * @typedef {{reachable:boolean, valid:boolean, status:'valid'|'invalid'|'unknown'|'not-cpanel'|'unreachable', detail?:string}} CpanelResult
 */
import https from 'node:https';
import { getRandomUA } from './user-agents.js';

export const DEFAULT_CPANEL_PORT = 2083;

/** Does this response body look like it came from a cPanel/WHM service at all? */
function looksLikeCpanel(body = '') {
  return /cpanel|cpsess|whostmgr|login_only|securitypolicy|resetpass/i.test(String(body));
}

/**
 * Classify a cPanel `login_only=1` response into a login outcome. Pure.
 *
 * - A JSON `status:1` (or a `security_token`/redirect carrying a `cpsess`
 *   session) means the credentials authenticated — the panel is up and the
 *   login works.
 * - A JSON `status:0` (or an HTTP 401) means the panel answered but rejected the
 *   credentials — up, but this login is stale.
 * - A cPanel-looking page we can't parse is `unknown` (up, inconclusive).
 * - A non-cPanel response is `not-cpanel` (something else on that port).
 * - No response at all (refused/timeout/TLS error) is `unreachable` (site down).
 *
 * @param {HttpResponse} res
 * @returns {CpanelResult}
 */
export function classifyCpanelLogin(res) {
  if (!res || res.error) {
    return { reachable: false, valid: false, status: 'unreachable', detail: res?.error || 'no response' };
  }
  const { statusCode, headers = {}, body = '' } = res;
  const location = headers.location || headers.Location || '';

  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* not JSON — fall through to the heuristics below */
  }

  if (json && typeof json === 'object') {
    const token = json.security_token || '';
    const redirect = json.redirect || '';
    if (json.status === 1 || /cpsess/i.test(token) || /cpsess/i.test(redirect)) {
      return { reachable: true, valid: true, status: 'valid', detail: token || undefined };
    }
    if (json.status === 0) {
      return { reachable: true, valid: false, status: 'invalid', detail: json.message || 'login rejected' };
    }
  }

  // Non-JSON success path: cPanel redirects a good login to a /cpsessXXX/ URL.
  if (/cpsess/i.test(location)) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  if (statusCode === 401) {
    return { reachable: true, valid: false, status: 'invalid', detail: 'HTTP 401' };
  }
  if (looksLikeCpanel(body)) {
    return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
  }
  return { reachable: true, valid: false, status: 'not-cpanel', detail: `HTTP ${statusCode ?? '?'}` };
}

/**
 * Default HTTPS POST to a cPanel login endpoint. cPanel panels frequently serve
 * a self-signed or hostname-mismatched certificate on :2083, so TLS
 * verification is disabled — these are your own servers and we authenticate
 * nothing beyond the login form. Redirects are NOT followed (a 302 to a cpsess
 * URL is itself the success signal).
 */
function defaultRequest(url, { headers, body, timeout }) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(
        url,
        { method: 'POST', headers, rejectUnauthorized: false, timeout },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            // Cap the buffered body — the JSON answer is tiny; a full dashboard
            // page is not worth holding. Enough to fingerprint and parse.
            if (data.length < 65536) data += c;
          });
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        },
      );
    } catch (err) {
      resolve({ error: err.message });
      return;
    }
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end(body);
  });
}

/**
 * Check one cPanel login.
 *
 * @param {CpanelTarget} target
 * @param {{request?:Function, port?:number, timeout?:number}} [opts]
 *   `request(url, {headers, body, timeout})` is injectable for testing.
 * @returns {Promise<CpanelResult & {host:string, user:string, port:number}>}
 */
export async function verifyCpanel(target, opts = {}) {
  const { request = defaultRequest, timeout = 10000 } = opts;
  const port = Number(target.port) || opts.port || DEFAULT_CPANEL_PORT;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');

  const base = { host, user, port };
  if (!host) return { ...base, reachable: false, valid: false, status: 'unreachable', detail: 'no host' };

  const url = `https://${host}:${port}/login/?login_only=1`;
  const body = `user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': getRandomUA(),
    'Content-Length': Buffer.byteLength(body),
  };

  let res;
  try {
    res = await request(url, { headers, body, timeout });
  } catch (err) {
    res = { error: err.message };
  }
  const result = classifyCpanelLogin(res);

  // If login succeeded, fetch domains to prove account is active
  if (result.valid && result._cpsess) {
    try {
      const sessMatch = result._cpsess.match(/(cpsess[0-9]+)/);
      const sess = sessMatch ? sessMatch[0] : '';
      const domainUrl = `https://${host}:${port}/${sess}/execute/DomainInfo/list_domains`;
      const dRes = await request(domainUrl, { headers: { 'User-Agent': getRandomUA() }, body: '', timeout });
      if (dRes && dRes.body) {
        const dJson = JSON.parse(dRes.body);
        if (dJson.data && Array.isArray(dJson.data)) {
          result.domains = dJson.data.map(d => d.domain).filter(Boolean);
        }
      }
    } catch { /* ignore domain fetch errors */ }
    delete result._cpsess;
  }

  return { ...base, ...result };
}

/**
 * Check a list of cPanel accounts with bounded concurrency, invoking `onResult`
 * as each completes (for live progress). Resolves to the array of all results.
 *
 * @param {CpanelTarget[]} targets
 * @param {{concurrency?:number, port?:number, timeout?:number, request?:Function, signal?:AbortSignal}} [opts]
 * @param {(r:CpanelResult & {host:string,user:string,port:number}, index:number)=>void} [onResult]
 * @returns {Promise<Array<CpanelResult & {host:string,user:string,port:number}>>}
 */
async function _verifyCpanelMultiPort(target, opts, ports) {
  if (ports.length === 1) return verifyCpanel(target, { ...opts, port: ports[0] });
  let last = null;
  for (const port of ports) {
    const { port: _ignored, ...targetNoPort } = target;
    const r = await verifyCpanel(targetNoPort, { ...opts, port });
    last = r;
    if (r.reachable) return r;
  }
  return last;
}

export async function runCpanelChecks(targets, opts = {}, onResult) {
  const list = Array.from(targets || []);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Number(opts.concurrency) || 10);
  let next = 0;

  async function worker() {
    while (next < list.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (opts.gate) await opts.gate();
      const _tgt = list[i];
      const _ports = Array.isArray(opts.ports) && opts.ports.length > 0
        ? opts.ports
        : [Number(list[i].port) || Number(opts.port) || 0];

      if (opts.lockoutRegistry && opts.lockoutRegistry.isLocked(_tgt.user, 'cpanel')) {
        const skipped = { ..._tgt, reachable: false, valid: false, status: 'unreachable', detail: 'skipped: locked', lockSkipped: true };
        results[i] = skipped;
        onResult?.(skipped, i);
        continue;
      }
      const r = await _verifyCpanelMultiPort(_tgt, opts, _ports);
      results[i] = r;
      if (opts.lockoutRegistry) {
        if (r.valid) opts.lockoutRegistry.recordSuccess(_tgt.user, 'cpanel');
        else if (r.reachable && !r.valid) {
          const _txt = String(r.detail || '');
          if (/too many|locked|blocked|rate.?limit|cphulk|captcha/i.test(_txt)) {
            opts.lockoutRegistry.markLocked(_tgt.user, 'cpanel', _txt);
          } else {
            opts.lockoutRegistry.recordFailure(_tgt.user, 'cpanel');
          }
        }
      }
      onResult?.(r, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}
