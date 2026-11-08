/**
 * WHM (Web Host Manager) login check — mirrors cpanel.js shape exactly.
 *
 * Differences from cpanel.js:
 *   - Default port 2087 (WHM) instead of 2083 (cPanel).
 *   - Endpoint /login/?login_only=1 responds with the same JSON shape
 *     (`security_token`, `status:1`), so classifyWhmLogin is nearly a copy.
 *   - A cPanel-looking response on port 2087 is classified as `not-whm`
 *     (panel up, wrong server) rather than `invalid` (wrong password), so
 *     callers can distinguish the two.
 *
 * @typedef {{host:string, user:string, pass:string, port?:number}} WhmTarget
 * @typedef {{statusCode?:number, headers?:Record<string,string>, body?:string, error?:string}} HttpResponse
 * @typedef {{reachable:boolean, valid:boolean, status:'valid'|'invalid'|'not-whm'|'unreachable', detail?:string}} WhmResult
 */
import https from 'node:https';

export const DEFAULT_WHM_PORT = 2087;

function looksLikeWhm(body = '', headers = {}) {
  const text = String(body);
  const server = String(headers.server || '');
  return /whostmgr|cpsession|WHM Login|root@/i.test(text) || /cpsrvd/i.test(server);
}

export function classifyWhmLogin(res) {
  if (!res || res.error) {
    return { reachable: false, valid: false, status: 'unreachable', detail: res?.error || 'no response' };
  }
  const { statusCode, headers = {}, body = '' } = res;
  const location = headers.location || headers.Location || '';

  let json = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }

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
  if (/cpsess/i.test(location)) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  if (statusCode === 401) {
    return { reachable: true, valid: false, status: 'invalid', detail: 'HTTP 401' };
  }
  if (looksLikeWhm(body, headers)) {
    return { reachable: true, valid: false, status: 'invalid', detail: `HTTP ${statusCode ?? '?'}` };
  }
  return { reachable: true, valid: false, status: 'not-whm', detail: `HTTP ${statusCode ?? '?'}` };
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

export async function verifyWhm(target, opts = {}) {
  const { request = defaultRequest, timeout = 10000 } = opts;
  const port = Number(target.port) || opts.port || DEFAULT_WHM_PORT;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  const base = { host, user, port };
  if (!host) return { ...base, reachable: false, valid: false, status: 'unreachable', detail: 'no host' };
  const url = `https://${host}:${port}/login/?login_only=1`;
  const body = `user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) };
  let res;
  try { res = await request(url, { headers, body, timeout }); } catch (err) { res = { error: err.message }; }
  return { ...base, ...classifyWhmLogin(res) };
}

export async function runWhmChecks(targets, opts = {}, onResult) {
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
      if (opts.lockoutRegistry && opts.lockoutRegistry.isLocked(_tgt.user, 'whm')) {
        results[i] = { ..._tgt, reachable: false, valid: false, status: 'unreachable', detail: 'skipped: locked', lockSkipped: true };
        onResult?.(results[i], i);
        continue;
      }
      results[i] = await verifyWhm(_tgt, opts);
      if (opts.lockoutRegistry) {
        if (results[i].valid) opts.lockoutRegistry.recordSuccess(_tgt.user, 'whm');
        else if (results[i].reachable && !results[i].valid) {
          const _txt = String(results[i].detail || '');
          if (opts.detectLockout ? opts.detectLockout(_txt) : /too many|locked|blocked|rate.?limit|cphulk|captcha/i.test(_txt)) {
            opts.lockoutRegistry.markLocked(_tgt.user, 'whm', _txt);
          } else {
            opts.lockoutRegistry.recordFailure(_tgt.user, 'whm');
          }
        }
      }
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}
