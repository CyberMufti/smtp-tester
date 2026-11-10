/**
 * Plesk (8443) and DirectAdmin (2222) login checkers.
 * Same return shape as cpanel.js/webmail.js/whm.js/ssh.js/mail-extra.js.
 */
import https from 'node:https';
import { socksHttpsAgent } from './socks-agent.js';
import { detectPanelBlock } from './panel-signals.js';

function post(host, port, path, body, timeout, contentType = 'application/x-www-form-urlencoded', agent = null) {
  return new Promise((resolve) => {
    const url = `https://${host}:${port}${path}`;
    const headers = {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    let req;
    try {
      req = https.request(url, { method: 'POST', headers, rejectUnauthorized: false, timeout, agent: agent || undefined }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (data.length < 65536) data += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      });
    } catch (e) { resolve({ error: e.message }); return; }
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// ============ Plesk ============

export function classifyPleskLogin(res) {
  if (!res || res.error) return { reachable: false, valid: false, status: 'unreachable', detail: res?.error || 'no response' };
  const { statusCode, headers = {}, body = '' } = res;
  const __blk = detectPanelBlock(res); if (__blk) return __blk;
  const location = headers.location || headers.Location || '';

  // Success: 302 redirect away from login, or body has a redirect script
  if ((statusCode === 301 || statusCode === 302 || statusCode === 303) && /(dashboard|admin|home)/i.test(location)) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  if (/window\.location\.href\s*=\s*['"][^'"]*(dashboard|admin)/i.test(body)) {
    return { reachable: true, valid: true, status: 'valid' };
  }
  // Failure: explicit error message
  if (/invalid (username|password|login)|login failed|authentication failed/i.test(body)) {
    return { reachable: true, valid: false, status: 'invalid', detail: body.slice(0, 100) };
  }
  // Redirect back to login = failure
  if (/[?&]error|login_up|login\.php/i.test(location)) {
    return { reachable: true, valid: false, status: 'invalid', detail: 'redirected to login' };
  }
  return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
}

export async function verifyPlesk(target, opts = {}) {
  const { timeout = 5000, port = 8443 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  if (!host || !user) return { host, user, port, reachable: false, valid: false, status: 'unreachable', detail: 'no host/user' };

  const body = `login_name=${encodeURIComponent(user)}&passwd=${encodeURIComponent(pass)}&locale_id=en-US`;
  let res;
  try {
    res = await post(host, port, '/login_up.php', body, timeout, undefined, socksHttpsAgent(opts.proxy));
  } catch (e) { res = { error: e.message }; }
  return { host, user, port, ...classifyPleskLogin(res) };
}

export async function runPleskChecks(targets, opts = {}, onResult) {
  const list = Array.from(targets || []);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Number(opts.concurrency) || 5);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (opts.gate) await opts.gate();
      results[i] = await verifyPlesk(list[i], opts);
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}

// ============ DirectAdmin ============

export function classifyDirectAdminLogin(res) {
  if (!res || res.error) return { reachable: false, valid: false, status: 'unreachable', detail: res?.error || 'no response' };
  const { statusCode, headers = {}, body = '' } = res;
  const __blk = detectPanelBlock(res); if (__blk) return __blk;
  const location = headers.location || headers.Location || '';
  const setCookie = headers['set-cookie'] || [];

  // Success: 302 to `/` or `/CMD_SHOW_RESELLER` or a session cookie
  if ((statusCode === 301 || statusCode === 302) && /^(\/|https?:\/\/)/.test(location) && !/CMD_LOGIN|login/i.test(location)) {
    if (Array.isArray(setCookie) ? setCookie.some((c) => /session/i.test(c)) : /session/i.test(setCookie)) {
      return { reachable: true, valid: true, status: 'valid', detail: location };
    }
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  if (/invalid login|authentication failed|incorrect username/i.test(body)) {
    return { reachable: true, valid: false, status: 'invalid', detail: body.slice(0, 100) };
  }
  return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
}

export async function verifyDirectAdmin(target, opts = {}) {
  const { timeout = 5000, port = 2222 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  if (!host || !user) return { host, user, port, reachable: false, valid: false, status: 'unreachable', detail: 'no host/user' };

  const body = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&json=yes`;
  let res;
  try {
    res = await post(host, port, '/CMD_LOGIN', body, timeout, undefined, socksHttpsAgent(opts.proxy));
  } catch (e) { res = { error: e.message }; }
  return { host, user, port, ...classifyDirectAdminLogin(res) };
}

export async function runDirectAdminChecks(targets, opts = {}, onResult) {
  const list = Array.from(targets || []);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Number(opts.concurrency) || 5);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (opts.gate) await opts.gate();
      results[i] = await verifyDirectAdmin(list[i], opts);
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}

// ============ CyberPanel (8090) / Webmin-Virtualmin (10000) / Hestia-Vesta (8083) ============

function unreachableRes(res) {
  return { reachable: false, valid: false, status: 'unreachable', detail: res?.error || 'no response' };
}
function cookieString(headers = {}) {
  const sc = headers['set-cookie'] || headers['Set-Cookie'] || '';
  return Array.isArray(sc) ? sc.join('; ') : String(sc);
}

export function classifyCyberPanelLogin(res) {
  if (!res || res.error) return unreachableRes(res);
  const { statusCode, body = '' } = res;
  const __blk = detectPanelBlock(res); if (__blk) return __blk;
  let json = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }
  if (json && typeof json === 'object') {
    if (json.loginStatus === 1) return { reachable: true, valid: true, status: 'valid' };
    if (json.loginStatus === 0) return { reachable: true, valid: false, status: 'invalid', detail: json.error_message || 'login rejected' };
  }
  return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
}

export async function verifyCyberPanel(target, opts = {}) {
  const { timeout = 5000, port = 8090 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  if (!host || !user) return { host, user, port, ...unreachableRes({ error: 'no host/user' }) };
  const body = JSON.stringify({ username: user, password: pass });
  let res;
  try { res = await post(host, port, '/verifyLogin', body, timeout, 'application/json', socksHttpsAgent(opts.proxy)); } catch (e) { res = { error: e.message }; }
  return { host, user, port, ...classifyCyberPanelLogin(res) };
}

export function classifyWebminLogin(res) {
  if (!res || res.error) return unreachableRes(res);
  const { statusCode, headers = {}, body = '' } = res;
  const __blk = detectPanelBlock(res); if (__blk) return __blk;
  const location = headers.location || headers.Location || '';
  if (/login failed|password was incorrect|invalid login|incorrect password/i.test(body)) {
    return { reachable: true, valid: false, status: 'invalid', detail: body.slice(0, 100) };
  }
  if ((statusCode === 301 || statusCode === 302) && /(sid|session|webmin)/i.test(cookieString(headers)) && !/login/i.test(location)) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
}

export async function verifyWebmin(target, opts = {}) {
  const { timeout = 5000, port = 10000 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  if (!host || !user) return { host, user, port, ...unreachableRes({ error: 'no host/user' }) };
  const body = `page=%2F&user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
  let res;
  try { res = await post(host, port, '/session_login.cgi', body, timeout, undefined, socksHttpsAgent(opts.proxy)); } catch (e) { res = { error: e.message }; }
  return { host, user, port, ...classifyWebminLogin(res) };
}

export function classifyHestiaLogin(res) {
  if (!res || res.error) return unreachableRes(res);
  const { statusCode, headers = {}, body = '' } = res;
  const __blk = detectPanelBlock(res); if (__blk) return __blk;
  const location = headers.location || headers.Location || '';
  if (/invalid username or password|incorrect|authentication failed/i.test(body)) {
    return { reachable: true, valid: false, status: 'invalid', detail: body.slice(0, 100) };
  }
  if ((statusCode === 301 || statusCode === 302) && /(hestiasid|vestasid|session)/i.test(cookieString(headers))) {
    return { reachable: true, valid: true, status: 'valid', detail: location };
  }
  return { reachable: true, valid: false, status: 'unknown', detail: `HTTP ${statusCode ?? '?'}` };
}

export async function verifyHestia(target, opts = {}) {
  const { timeout = 5000, port = 8083 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  if (!host || !user) return { host, user, port, ...unreachableRes({ error: 'no host/user' }) };
  const body = `user=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  let res;
  try { res = await post(host, port, '/login/', body, timeout, undefined, socksHttpsAgent(opts.proxy)); } catch (e) { res = { error: e.message }; }
  return { host, user, port, ...classifyHestiaLogin(res) };
}
