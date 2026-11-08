/**
 * Webmail (Roundcube / Horde / SquirrelMail) login check — mirrors cpanel.js.
 *
 * Default endpoint: https://<host>/webmail (port 443, no explicit port in URL).
 * POSTs form-encoded `_user`, `_pass`, `_task=login` — the shared shape across
 * Roundcube / Horde / SquirrelMail login forms.
 *
 * Success detection:
 *   - 301/302/303 redirect to ?_task=mail or ?_task=show     → valid
 *   - 3xx redirect to any non-login URL                      → valid (best-effort)
 *   - 3xx redirect back to ?_task=login                      → invalid
 *   - body contains "Login failed" / "Invalid request"       → invalid
 *   - body contains "User not found"                         → invalid
 *   - body fingerprints as Roundcube/Horde/SquirrelMail      → unknown (up, unparsed)
 *   - anything else                                          → not-webmail
 *
 * @typedef {{host:string, user:string, pass:string, path?:string, port?:number}} WebmailTarget
 * @typedef {{statusCode?:number, headers?:Record<string,string>, body?:string, error?:string}} HttpResponse
 * @typedef {{reachable:boolean, valid:boolean, status:'valid'|'invalid'|'unknown'|'not-webmail'|'unreachable', detail?:string}} WebmailResult
 */
import https from 'node:https';

export const DEFAULT_WEBMAIL_PORT = 443;
export const DEFAULT_WEBMAIL_PATH = '/webmail';

function looksLikeWebmail(body = '') {
  return /roundcube|horde|squirrelmail|_task=login|_user|_pass|webmail/i.test(String(body));
}

export function classifyWebmailLogin(res) {
  if (!res || res.error) {
    return { reachable: false, valid: false, status: 'unreachable', detail: res?.error || 'no response' };
  }
  const { statusCode, headers = {}, body = '' } = res;
  const location = headers.location || headers.Location || '';

  // Roundcube/Horde redirect to ?_task=mail or ?_task=show after success.
  if (/[?&]_task=(mail|show)/i.test(location)) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  // Redirect back to login = auth failure.
  if (/[?&]_task=login/i.test(location)) {
    return { reachable: true, valid: false, status: 'invalid', detail: 'redirected to login' };
  }
  // Any other redirect (post-login landing page) = success (best-effort).
  if ((statusCode === 301 || statusCode === 302 || statusCode === 303) && location && !/login/i.test(location)) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  if (/login\s*failed|invalid\s*request|authentication\s*failed/i.test(body)) {
    return { reachable: true, valid: false, status: 'invalid', detail: 'login rejected' };
  }
  if (/user\s*not\s*found/i.test(body)) {
    return { reachable: true, valid: false, status: 'invalid', detail: 'user not found' };
  }
  if (looksLikeWebmail(body)) {
    return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
  }
  return { reachable: true, valid: false, status: 'not-webmail', detail: `HTTP ${statusCode ?? '?'}` };
}

function defaultRequest(url, { headers, body, timeout }) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.request(url, { method: 'POST', headers, rejectUnauthorized: false, timeout }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (data.length < 65536) data += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      });
    } catch (err) { resolve({ error: err.message }); return; }
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end(body);
  });
}

export async function verifyWebmail(target, opts = {}) {
  const { request = defaultRequest, timeout = 10000, path = DEFAULT_WEBMAIL_PATH, port = DEFAULT_WEBMAIL_PORT } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  const base = { host, user, port };
  if (!host) return { ...base, reachable: false, valid: false, status: 'unreachable', detail: 'no host' };
  const url = port === 443 ? `https://${host}${path}` : `https://${host}:${port}${path}`;
  const body = `_user=${encodeURIComponent(user)}&_pass=${encodeURIComponent(pass)}&_task=login&_action=login`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) };
  let res;
  try { res = await request(url, { headers, body, timeout }); } catch (err) { res = { error: err.message }; }
  return { ...base, ...classifyWebmailLogin(res) };
}

export async function runWebmailChecks(targets, opts = {}, onResult) {
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
      if (opts.lockoutRegistry && opts.lockoutRegistry.isLocked(_tgt.user, 'webmail')) {
        results[i] = { ..._tgt, reachable: false, valid: false, status: 'unreachable', detail: 'skipped: locked', lockSkipped: true };
        onResult?.(results[i], i);
        continue;
      }
      results[i] = await verifyWebmail(_tgt, opts);
      if (opts.lockoutRegistry) {
        if (results[i].valid) opts.lockoutRegistry.recordSuccess(_tgt.user, 'webmail');
        else if (results[i].reachable && !results[i].valid) {
          const _txt = String(results[i].detail || '');
          if (opts.detectLockout ? opts.detectLockout(_txt) : /too many|locked|blocked|rate.?limit|cphulk|captcha/i.test(_txt)) {
            opts.lockoutRegistry.markLocked(_tgt.user, 'webmail', _txt);
          } else {
            opts.lockoutRegistry.recordFailure(_tgt.user, 'webmail');
          }
        }
      }
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}
