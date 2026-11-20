/**
 * Office 365 credential check — confirm that an email + password actually logs
 * in, for accounts you operate, WITHOUT needing outbound port 25.
 *
 * Microsoft 365 disables basic SMTP AUTH on most tenants, so the normal SMTP
 * tester cannot judge these accounts. Instead we:
 *   1. Attempt an IMAP login to outlook.office365.com:993 (IMAPS, port 993).
 *      A clean login proves the password; a clear credential rejection is
 *      "invalid".
 *   2. Only when IMAP fails in a way that signals basic/legacy auth is DISABLED
 *      (not a wrong password), fall back to Microsoft's OAuth2 token endpoint
 *      (ROPC password grant over HTTPS, port 443). A token proves the password;
 *      AADSTS50126 is a wrong password; MFA / conditional-access / locked /
 *      expired codes mean the password may be right but cannot be confirmed
 *      passwordlessly ("unknown").
 *
 * Neither path uses port 25. The two classifiers are pure and unit-tested; all
 * network I/O is injected so the logic runs offline in tests.
 *
 * @typedef {{user:string, pass:string}} O365Target
 * @typedef {('valid'|'invalid'|'not-o365'|'unknown'|'unreachable')} O365Status
 * @typedef {{user:string, pass:string, status:O365Status, method:(''|'imap'|'oauth'), detail:string}} O365Result
 *
 * 'invalid'  = a real Microsoft 365 account, password confirmed WRONG (AADSTS50126).
 * 'not-o365' = the address has no Microsoft 365 mailbox at all (AADSTS50034 /
 *              tenant-not-found). This is NOT a wrong password — it's a
 *              non-Microsoft domain (proton.me, gmail, …) or a typo. Kept
 *              separate so a non-Microsoft account is never reported "invalid".
 */
import { ImapFlow } from 'imapflow';

export const O365_IMAP_HOST = 'outlook.office365.com';
export const O365_IMAP_PORT = 993;

// Microsoft first-party public client ("Microsoft Office"), commonly accepted
// for the ROPC password grant. The token endpoint still enforces the tenant's
// MFA / conditional-access policy, so this only confirms accounts that allow it.
const ROPC_CLIENT_ID = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
// The ROPC password grant is NOT supported over /common or /consumers — those
// return AADSTS9001023. /organizations is the correct endpoint for work/school
// (Office 365 org) accounts, which is what this checker targets. Personal
// consumer accounts can't do ROPC at all and surface as "unknown".
const TOKEN_URL = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token';
const ROPC_SCOPE = 'https://outlook.office365.com/.default openid';

/**
 * Classify an IMAP login outcome into a verdict and whether to fall back to
 * OAuth2. A clean login is valid; an unambiguous bad-password rejection is
 * invalid; anything else (basic auth disabled, throttling, connection trouble)
 * is inconclusive and defers to OAuth2. Pure.
 * @param {{ok:boolean, error?:string}} outcome
 * @returns {{status:O365Status, method:'imap', fallback:boolean}}
 */
export function classifyImapLogin({ ok, error, authFailed } = {}) {
  if (ok) return { status: 'valid', method: 'imap', fallback: false };
  const msg = String(error || '').toLowerCase();
  // IMAP/basic auth turned off for this account or tenant (Microsoft replies
  // "Login is disabled", "basic authentication is disabled", etc.). The password
  // can't be judged by IMAP, so defer to OAuth2.
  if (/login is disabled|basic authentication is disabled|not enabled for the user|disabled for the (user|account|tenant)|authenticationfailed.*disabled|modern auth/.test(msg)) {
    return { status: 'unknown', method: 'imap', fallback: true };
  }
  // Throttling / smart lockout / temporary server conditions must NOT be read as
  // a wrong password — the account may be fine. Defer to OAuth2 (and the caller
  // surfaces throttling so the user can slow down).
  if (/throttl|too many|temporar|try again|server unavailable|service unavailable|server busy|rate.?limit|\[unavailable\]|account is locked|locked/.test(msg)) {
    return { status: 'unknown', method: 'imap', fallback: true };
  }
  // A clean authentication rejection that is NOT an "auth disabled"/throttle case
  // is a genuine wrong password. ImapFlow sets authenticationFailed on these.
  if (authFailed || /invalid credentials|authentication failed|login failed|logindenied|logon denied|incorrect password|user ?name or password/.test(msg)) {
    return { status: 'invalid', method: 'imap', fallback: false };
  }
  // Connection/timeout/other — inconclusive, let OAuth2 decide.
  return { status: 'unreachable', method: 'imap', fallback: true };
}

// AADSTS codes that CONFIRM the password is correct but block completion — the
// login was accepted, MFA / further auth is simply required. These are valuable:
// the credential pair is right.
const OAUTH_MFA_CODES = new Set([
  '50076', '50079', '50072', '50074', // MFA required (password was accepted)
  '50055',                            // password is correct but EXPIRED
]);
// Policy / state codes: the password MIGHT be right but we can't confirm it
// (conditional access, device policy, locked, disabled).
const OAUTH_UNKNOWN_CODES = new Set([
  '50158', '53000', '53001', '53003', '53004', // conditional access / device
  '50053',                                     // account locked (smart lockout)
  '50057',                                     // account disabled
  '700016', '7000218', '7000215',              // ROPC client not allowed / needs secret
  '90002', '90072', '500011',                  // tenant / resource issues
]);
// Throttling — results are unreliable; definitely not a wrong password.
const OAUTH_THROTTLE_CODES = new Set(['50053', '80049', '90056', '16000']);
// The address has NO Microsoft 365 mailbox: account/tenant doesn't exist. This
// is a non-Microsoft domain (proton.me, gmail, …) or a typo — NOT a wrong
// password. Reported as 'not-o365', never 'invalid'.
const OAUTH_NOT_O365_CODES = new Set(['50034', '90002', '90072', '50128', '500212']);
// Definitive bad credential ON a real Microsoft 365 account.
const OAUTH_INVALID_CODES = new Set(['50126']);

/**
 * Classify Microsoft's token response into a verdict. Pure.
 * @param {{ok:boolean, data?:object}} resp
 * @returns {{status:O365Status, method:'oauth', detail:string, throttled?:boolean, passwordValid?:boolean}}
 */
export function classifyTokenResponse({ ok, data } = {}) {
  if (ok && data && data.access_token) return { status: 'valid', method: 'oauth', detail: 'token issued', passwordValid: true };
  const text = String((data && (data.error_description || data.error)) || '');
  const code = (text.match(/AADSTS(\d+)/) || [])[1] || '';
  if (OAUTH_MFA_CODES.has(code)) {
    return { status: 'unknown', method: 'oauth', detail: `AADSTS${code} — password is VALID, MFA/extra auth required`, passwordValid: true };
  }
  if (OAUTH_THROTTLE_CODES.has(code)) {
    return { status: 'unknown', method: 'oauth', detail: `AADSTS${code} — throttled/locked, retry later`, throttled: true };
  }
  if (OAUTH_NOT_O365_CODES.has(code)) {
    return { status: 'not-o365', method: 'oauth', detail: `AADSTS${code} — no Microsoft 365 mailbox for this address` };
  }
  if (OAUTH_INVALID_CODES.has(code)) return { status: 'invalid', method: 'oauth', detail: `AADSTS${code} — wrong password` };
  if (OAUTH_UNKNOWN_CODES.has(code)) return { status: 'unknown', method: 'oauth', detail: `AADSTS${code} — cannot confirm (policy/tenant)` };
  return { status: 'unknown', method: 'oauth', detail: code ? `AADSTS${code}` : (text.slice(0, 140) || 'login not confirmed') };
}

/** Default IMAP login probe (injectable). Returns {ok, error?, authFailed?}. */
async function defaultImapLogin(user, pass, opts = {}) {
  const t = Number(opts.timeout) || 15000;
  const client = new ImapFlow({
    host: O365_IMAP_HOST, port: O365_IMAP_PORT, secure: true,
    auth: { user, pass }, logger: false, disableAutoIdle: true,
    connectionTimeout: t, greetingTimeout: t, socketTimeout: t + 5000,
  });
  // ImapFlow is an EventEmitter: a socket reset mid-session (Microsoft throttling
  // a batch) emits an 'error' event, and an 'error' with no listener is thrown as
  // an unhandled exception that can take the whole process down. Swallow it — the
  // connect() promise already carries the verdict we act on.
  client.on('error', () => {});
  try { await client.connect(); return { ok: true }; }
  catch (err) {
    return { ok: false, error: err?.responseText || err?.message || String(err), authFailed: !!err?.authenticationFailed };
  } finally {
    // close() tears the socket down immediately; logout() does a graceful round
    // trip that can hang on a half-open/throttled connection and stall the batch.
    try { client.close(); } catch { /* already closed */ }
  }
}

/** Default OAuth2 ROPC token request (injectable). Returns {ok, data}. */
async function defaultTokenRequest(user, pass, opts = {}) {
  const body = new URLSearchParams({
    grant_type: 'password', client_id: ROPC_CLIENT_ID,
    username: user, password: pass, scope: ROPC_SCOPE,
  });
  let signal;
  try { signal = AbortSignal.timeout(Number(opts.timeout) || 15000); } catch { /* no timeout */ }
  const fetchFn = opts.fetchFn || ((u, o) => fetch(u, o));
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: !!res.ok, data };
}

/**
 * Validate one Office 365 credential: IMAP first, OAuth2 only as a fallback when
 * IMAP was inconclusive (basic auth disabled / connection issue). Never throws.
 * @param {O365Target} target
 * @param {{timeout?:number, imapLogin?:Function, tokenRequest?:Function, fetchFn?:Function, signal?:AbortSignal}} [opts]
 * @returns {Promise<O365Result>}
 */
export async function verifyOffice365(target, opts = {}) {
  const user = String(target?.user || '').trim();
  const pass = target?.pass ?? '';
  const base = { user, pass, status: 'unknown', method: '', detail: '' };
  if (!user || !pass) return { ...base, status: 'invalid', detail: 'missing email or password' };

  const imapFn = opts.imapLogin || defaultImapLogin;
  let imap;
  try { imap = await imapFn(user, pass, opts); }
  catch (err) { imap = { ok: false, error: err?.message || String(err) }; }

  const v = classifyImapLogin(imap);
  if (!v.fallback) {
    return { ...base, status: v.status, method: v.method, detail: v.status === 'valid' ? 'IMAP login ok' : (imap.error || '') };
  }

  const tokenFn = opts.tokenRequest || defaultTokenRequest;
  let tok;
  try { tok = await tokenFn(user, pass, opts); }
  catch (err) { tok = { ok: false, data: { error_description: err?.message || String(err) } }; }
  const o = classifyTokenResponse(tok);
  return {
    ...base,
    status: o.status,
    method: o.method,
    detail: o.detail || imap.error || '',
    ...(o.throttled ? { throttled: true } : {}),
    ...(o.passwordValid ? { passwordValid: true } : {}),
  };
}

/**
 * Check a batch of O365 credentials with bounded concurrency (low by default —
 * Microsoft throttles and locks accounts under rapid failed logins), invoking
 * `onResult(result, index)` as each completes. Returns results in input order.
 * @param {O365Target[]} targets
 * @param {{concurrency?:number, timeout?:number, gate?:Function, signal?:AbortSignal, imapLogin?:Function, tokenRequest?:Function, fetchFn?:Function}} [opts]
 * @param {(r:O365Result, i:number)=>void} [onResult]
 * @returns {Promise<O365Result[]>}
 */
export async function runOffice365Checks(targets, opts = {}, onResult) {
  const list = Array.from(targets || []);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Number(opts.concurrency) || 5);
  let next = 0;

  async function worker() {
    while (next < list.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (opts.gate) await opts.gate();
      let r;
      try { r = await verifyOffice365(list[i], opts); }
      catch (err) { r = { user: list[i]?.user || '', pass: list[i]?.pass || '', status: 'unknown', method: '', detail: err?.message || String(err) }; }
      results[i] = r;
      onResult?.(r, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}

/**
 * Parse `email:password` lines (also tolerating `email password` and trailing
 * host:port fields where the first two tokens are the email + password). Blank
 * and `#` comment lines are skipped. Pure.
 * @param {string} text
 * @returns {O365Target[]}
 */
export function parseOffice365Lines(text) {
  return String(text || '').split(/\r?\n/).map(parseOffice365Line).filter(Boolean);
}

/**
 * Parse ONE `email<sep>password` line. The email is taken up to the first
 * separator (`:`, `;`, `,`, tab, or spaces); EVERYTHING after that separator is
 * the password, trimmed — so passwords that themselves contain `:`/`;`/`,`/
 * spaces are not truncated (which would otherwise fail a real login as a wrong
 * password). Blank and `#` comment lines yield null. Pure.
 * @param {string} raw
 * @returns {O365Target|null}
 */
export function parseOffice365Line(raw) {
  const line = String(raw || '').trim();
  if (!line || line.startsWith('#')) return null;
  const m = line.match(/^(\S+?@\S+?)[\s:;,|]+(.+)$/);
  if (!m) return null;
  const pass = m[2].trim();
  if (!pass) return null;
  return { user: m[1], pass };
}
