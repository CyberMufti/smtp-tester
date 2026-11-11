import * as realSmtp from './smtp.js';
import * as realImap from './imap.js';
import { LockoutRegistry, detectLockout } from './lockout.js';
import { generateMutations } from './mutator.js';
import { enumerateUser } from './smtp-enum.js';
import { classify, applyAuthGate, detectLimited, LIMIT_RE } from './classify.js';
import { candidatesFor, detectProvider } from './providers.js';
import { classifyProvider, classifyFromBanner, resolveLeadCountry } from './provider-class.js';
import { grabBanner } from './banner.js';
import { classifyM365Realm } from './ms-realm.js';
import { rdapCountry } from './rdap.js';
import { discoverHosts } from './discovery.js';
import { checkDomain, parseAuthResults } from './authrecords.js';
import { checkIp } from './dnsbl.js';
import { scoreContent } from './spamscore.js';
import { createKeyedLimiter } from './limiter.js';

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
  let sendResponse = null;
  let mxForClass = [];
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
    // Resolve MX for any custom domain (even when the user supplied a host) so
    // provider classification always has the authoritative platform signal —
    // e.g. a vanity host like mail.<domain> carries no emailsrvr token, but the
    // MX does, so Rackspace isn't lost and mislabeled by the banner fallback.
    // The heavier SRV/autoconfig discovery is only needed to FIND a connect
    // endpoint, so it still runs only when no host was supplied.
    if (!detectProvider(cred.user) && dns) {
      const domain = domainOf(cred.user);
      if (domain) {
        // Discover once per domain, not per credential (a bulk list often has
        // many accounts on the same domain).
        if (ctx && !ctx.discoverCache.has(domain)) {
          const fetchFn =
            opts.deps.fetch || ((url) => globalThis.fetch(url, { signal: AbortSignal.timeout(5000) }));
          const needDiscovery = !cred.host && dns.resolveSrv;
          const [mx, disc] = await Promise.all([
            dns.resolveMx ? resolveMxHosts(domain, dns) : [],
            needDiscovery ? discoverHosts(domain, { dns, fetchFn }).catch(() => []) : [],
          ]);
          ctx.discoverCache.set(domain, { mxHosts: mx, discovered: disc });
        }
        ({ mxHosts, discovered } = ctx?.discoverCache.get(domain) || { mxHosts: [], discovered: [] });
      }
    }
    mxForClass = mxHosts;

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
        // Keep the FIRST auth-rejection's user-existence signal: the loop may go
        // on to probe other (guessed) hosts, and a later host's answer must not
        // overwrite the authoritative one — otherwise the "account not found"
        // note can reflect the wrong server.
        if (step.userExists === undefined) step.userExists = v.userExists;
        record.outcome = `auth rejected${v.error ? ` (${v.error})` : ''}`;
        attempts.push(record);
        anyConnected = true;
        authError = v.error;
        // A rejected login on a submission port means this host won't accept it
        // on another port either — skip its other ports. But NOT for port 25:
        // most servers don't offer AUTH on the MTA port, so a failure there says
        // nothing about 587/465, and skipping them would mark a valid credential
        // dead. So a port-25 auth failure never poisons the submission ports.
        if (cand.port !== 25) authFailedHosts.add(cand.host);
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
      // Keep the server's final response line (e.g. "250 2.0.0 OK ..."); some
      // providers reveal a rate/quota condition there even on an accepted send.
      sendResponse = sendRes.response || null;

      if (step.sent && activeSeeds.length > 0) {
        step.seeds = await Promise.all(
          activeSeeds.map(async (seed) => {
            const lookup = () => imap.findToken(seed, token, {
              timeoutMs: opts.placementTimeoutMs,
              pollIntervalMs: opts.pollIntervalMs,
            });
            // Bound concurrent connections to this seed account (see seedLimiter).
            const seedKey = `${seed.imapUser || seed.address || seed.label}@${seed.imapHost || ''}`;
            const found = ctx?.seedLimiter ? await ctx.seedLimiter.run(seedKey, lookup) : await lookup();
            const entry = { label: seed.label, folder: found.folder, error: found.error };
            if (found.authResults) entry.auth = parseAuthResults(found.authResults);
            return entry;
          }),
        );
      }

      // Opt-in deep limit probe: a single accepted send can't reveal an account
      // that is near its cap. Send a few EXTRA self-addressed messages through
      // the same server and watch for throttling/deferral — if later sends start
      // getting rejected or rate-limited, the account is 'limited', not valid.
      // Sends to the account itself so it never floods the user's test inboxes.
      if (step.sent && opts.limitProbe) {
        const n = Math.max(1, Math.min(Number(opts.limitProbeCount) || 3, 10));
        const selfTo = opts.from || cred.from || cred.user;
        for (let k = 0; k < n; k++) {
          if (opts.signal?.aborted) break;
          const probe = await smtp.send(effective, {
            to: selfTo,
            from: opts.from || cred.from || cred.user,
            subject: `${subject} probe ${k + 1}`,
            text: `${text}\n(automated limit probe ${k + 1})`,
            sendTimeout: opts.sendTimeout,
            proxy: opts.proxy,
          });
          const probeText = `${probe.error || ''} ${probe.response || ''}`.trim();
          const probeAccepted = (probe.accepted?.length ?? 0) > 0;
          if (!probeAccepted || LIMIT_RE.test(probeText)) {
            step.limitProbe = { tripped: true, at: k + 1, detail: probeText || 'send not accepted' };
            break;
          }
        }
      }
    }
  } catch (err) {
    // Unexpected failure anywhere in the pipeline: record it so classify -> dead.
    if (!step.connected) step.connectError = err.message;
    else if (!step.authenticated) step.authError = err.message;
    else step.sendError = err.message;
  }

  const { status, reason, perSeed, userExists, selfSendOnly, blocked } = classify(step);

  // Categorize a dead result so the orchestrator can retry transient (connect)
  // failures but never retry a permanent auth/send rejection.
  let deadReason;
  if (status === 'dead') {
    if (!step.connected) deadReason = 'connect';
    else if (!step.authenticated) deadReason = 'auth';
    else deadReason = 'send';
  }

  // Leads-filter classification: which mail provider this lead is on, and the
  // ISO country of the server it resolves to (GeoIP, best-effort — "Unknown"
  // when no database is loaded or the host can't be resolved).
  const classHost = usedHost || cred.host;
  let provider = classifyProvider({ user: cred.user, host: classHost, mxHosts: mxForClass });
  // Domain/MX gave no platform signal: read the server banner to recognize
  // self-hosted software (Zimbra, Exim/cPanel, Postfix, Exchange). Only when we
  // actually reached the server (probing an unreachable host just wastes time),
  // and cached per host so a bulk list probes each server once. The banner
  // grabber is injected via deps so unit tests never touch the network.
  const bannerGrab = opts.deps?.grabBanner || grabBanner;
  if (opts.deps?.grabBanner && (provider === 'Other' || provider === 'Unknown') && step.connected && classHost) {
    const cache = ctx?.bannerCache || (ctx ? (ctx.bannerCache = new Map()) : null);
    try {
      let bucket = cache?.get(classHost);
      if (bucket === undefined) {
        const banner = await bannerGrab(classHost, { timeout: opts.bannerTimeoutMs || 5000 });
        bucket = classifyFromBanner(banner) || null;
        cache?.set(classHost, bucket);
      }
      if (bucket) provider = bucket;
    } catch { /* keep the domain/MX classification */ }
  }

  // Microsoft 365 sub-type: probe Microsoft's realm endpoint to tell how the
  // tenant authenticates (Native Office / DesktopSSO / Federated-by-IdP /
  // GoDaddy). Cached per domain; the prober is injected via deps so unit tests
  // never hit the network. Refines the provider label, e.g. "Microsoft 365 — GoDaddy".
  if (provider === 'Microsoft 365' && typeof opts.deps?.msRealm === 'function') {
    const dom = domainOf(cred.user);
    const cache = ctx?.realmCache || (ctx ? (ctx.realmCache = new Map()) : null);
    try {
      let sub = cache?.get(dom);
      if (sub === undefined) {
        const realm = await opts.deps.msRealm(cred.user);
        sub = classifyM365Realm(realm) || null;
        cache?.set(dom, sub);
      }
      if (sub) provider = `Microsoft 365 — ${sub}`;
    } catch { /* keep base Microsoft 365 */ }
  }

  let country;
  if (typeof opts.geoResolver === 'function') {
    const geoHost = usedHost || cred.host || mxForClass[0] || domainOf(cred.user);
    try { country = geoHost ? await opts.geoResolver(geoHost) : 'Unknown'; } catch { country = 'Unknown'; }
  }

  // Lead country, most-trustworthy signal first (see resolveLeadCountry): domain
  // ccTLD → region-locked provider → per-upload override → RDAP registrant
  // country → self-hosted server GeoIP → Unknown. RDAP is a best-effort network
  // lookup, so it runs ONLY when enabled AND nothing cheaper already resolved the
  // country — and is cached per domain + concurrency-capped so a bulk run stays
  // polite. Any failure returns null and falls through to the server GeoIP step.
  const userDomain = domainOf(cred.user) || '';
  let rdapCode = '';
  // RDAP is a network lookup, so spend it only on LIVE leads — the ones that
  // actually appear in the Leads export (the SMTP worked, or the server confirmed
  // the account exists). Dead/unknown connects aren't exported as leads, so a
  // lookup for them would be wasted latency.
  const worthRdap = status !== 'dead' || userExists === true;
  if (opts.rdapEnabled && userDomain && worthRdap) {
    const pre = resolveLeadCountry({ userDomain, provider, batchCountry: opts.batchCountry });
    if (pre === 'Unknown') {
      const cache = ctx?.rdapCache || (ctx ? (ctx.rdapCache = new Map()) : null);
      let iso = cache ? cache.get(userDomain) : undefined;
      if (iso === undefined) {
        const fetchFn = opts.deps?.fetch || ((u, o) => globalThis.fetch(u, o));
        const run = () => rdapCountry(userDomain, { fetchFn, timeoutMs: opts.rdapTimeoutMs || 6000 });
        try {
          iso = ctx?.rdapLimiter ? await ctx.rdapLimiter.run('rdap', run) : await run();
        } catch { iso = null; }
        cache?.set(userDomain, iso || null);
      }
      rdapCode = iso || '';
    }
  }
  const leadCountry = resolveLeadCountry({
    userDomain,
    provider,
    batchCountry: opts.batchCountry,
    rdapCode,
    serverGeo: country,
  });

  const result = {
    cred,
    status,
    reason,
    deadReason,
    userExists,
    selfSendOnly,
    blocked,
    perSeed,
    latencyMs: Date.now() - start,
    token,
    subject,
    usedHost,
    usedPort,
    triedFallback,
    sendResponse,
    manualRecipients,
    attempts,
    provider,
    country,                                   // server location (GeoIP of the mail server IP)
    domainCountry: leadCountry,                // lead country (see resolveLeadCountry above)
  };

  // Post-classify enrichment is all best-effort refinement layered on top of the
  // core connect/auth/send/placement verdict already in `result`. Guard it as a
  // whole: a throw from any deliverability lookup or gate must never propagate
  // out of testOne (which the orchestrator would turn into a bogus "dead"), so
  // on failure we keep the verdict classify() already produced.
  try {
    const deliverability = await runChecks(cred, usedHost, opts, ctx);
    if (deliverability) result.deliverability = deliverability;
    if (ctx?.spamScore) result.spamScore = ctx.spamScore;

    // A login that works but whose sends are rate/quota-limited is reported
    // "limited" — not "valid" (it won't actually deliver) and not a bare "dead"
    // (the credentials are good). Runs before the auth gate so a limited result
    // is never also relabeled "unverified".
    const lim = detectLimited(result);
    if (lim) {
      result.status = lim.status;
      result.reason = lim.reason;
      result.limited = true;
    }

    // Deep-probe override: if the multi-send probe tripped a limit, the account
    // is 'limited' even though its first send was accepted.
    if (step.limitProbe?.tripped && result.status !== 'dead') {
      result.status = 'limited';
      result.reason = `sending limit reached after ${step.limitProbe.at} extra message(s) — ${step.limitProbe.detail}`.slice(0, 200);
      result.limited = true;
      result.limitProbe = step.limitProbe;
    }

    // Gate "valid" on sending-domain auth: a domain missing SPF or DMARC will
    // have its mail dropped by major providers, so it is reported "unverified"
    // rather than "valid". Runs only when deliverability checks supplied records.
    const gate = applyAuthGate(result.status, result.deliverability);
    if (gate) {
      result.status = gate.status;
      result.reason = gate.reason;
      result.authGated = true;
    }
  } catch (err) {
    result.enrichmentError = err?.message || String(err);
  }

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
    const fromAddr = opts.from || cred.from || cred.user;
    const domain = domainOf(fromAddr);
    if (domain) {
      // Resolve the sending IP (the working SMTP host's address) so the sidecar
      // can evaluate SPF against it. Cached per host; best-effort.
      let ip = null;
      if (dns.resolve4 && usedHost) {
        if (!ctx.ipCache) ctx.ipCache = new Map();
        if (!ctx.ipCache.has(usedHost)) {
          let resolved = null;
          try { resolved = (await dns.resolve4(usedHost))?.[0] || null; } catch { resolved = null; }
          ctx.ipCache.set(usedHost, resolved);
        }
        ip = ctx.ipCache.get(usedHost);
      }
      // Cache by domain+IP: the SPF verdict depends on the sending IP.
      const key = `${domain}|${ip || ''}`;
      if (!ctx.domainCache.has(key)) {
        ctx.domainCache.set(
          key,
          await evaluateDomainAuth({
            domain,
            ip,
            mailfrom: fromAddr,
            helo: usedHost,
            evalAuth: opts.deps?.evalAuth,
            resolveTxt: dns.resolveTxt,
          }),
        );
      }
      const { spf, dmarc, engine } = ctx.domainCache.get(key);
      out.spf = spf;
      out.dmarc = dmarc;
      out.fromDomain = domain;
      out.authEngine = engine;
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

/**
 * Evaluate a sending domain's SPF/DMARC. Prefers the Python sidecar (`evalAuth`,
 * wired in by the main process) for a REAL SPF verdict against the sending IP
 * and DMARC alignment; falls back to JS record parsing when the sidecar is
 * absent or errors. Returns the shape the result and {@link applyAuthGate} use:
 * `{ spf:{found, all, result}, dmarc:{found, policy, aligned}, engine }`.
 */
async function evaluateDomainAuth({ domain, ip, mailfrom, helo, evalAuth, resolveTxt }) {
  if (evalAuth && ip) {
    try {
      const rep = await evalAuth({ domain, ip, helo, mailfrom });
      if (rep && rep.spf && rep.dmarc) {
        return {
          engine: rep.engine || 'python',
          spf: { found: !!rep.spf.found, all: rep.spf.all ?? null, result: rep.spf.result ?? null },
          dmarc: { found: !!rep.dmarc.found, policy: rep.dmarc.policy ?? null, aligned: rep.dmarc.aligned ?? null },
        };
      }
    } catch { /* fall through to the JS record read */ }
  }
  const { spf, dmarc } = await checkDomain(domain, { resolveTxt });
  return { engine: 'js', spf, dmarc };
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
  // Cap simultaneous IMAP connections PER SEED mailbox, independent of send
  // concurrency. Without this, N send workers each open their own placement
  // connection to the same seed account; past the provider's limit (Gmail ~15)
  // the extra connections are rejected, the placement errors, and a delivered
  // message is misclassified as "valid". Keyed per seed so distinct seeds still
  // run in parallel. Default 15 — the practical ceiling for Gmail/Outlook IMAP.
  // `opts.seedConcurrency` can override; 0 disables the cap.
  const seedLimiter = opts.seedConcurrency === 0 ? null : createKeyedLimiter(opts.seedConcurrency ?? 15);
  // RDAP registrant-country lookups (opt-in): cache one result per domain, and
  // cap total concurrency (constant key) so a bulk run never floods the RDAP
  // bootstrap service. Default 4 simultaneous; `opts.rdapConcurrency` overrides.
  const rdapLimiter = createKeyedLimiter(Math.max(1, opts.rdapConcurrency ?? 8));
  const ctx = { domainCache: new Map(), dnsblCache: new Map(), discoverCache: new Map(), seedLimiter, rdapCache: new Map(), rdapLimiter };
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
      // Per-credential proxy fallback chain: manual proxy (opts.proxy) →
      // scraped pool (opts.proxyProvider) → direct. Each tier is tried in
      // order; a connect-level failure advances to the next LIVE tier, so a
      // dead proxy can never hide a live credential. deadReason==='connect'
      // rules out auth/send rejections, so advancing is accurate either way (a
      // down target stays dead at every tier). A pool proxy is RETIRED only
      // when a later tier gets further than it did — i.e. the target was
      // reachable, so that proxy was the culprit; if every tier connect-fails
      // the target is down and no proxy is blamed (a dead-heavy list must not
      // burn down the pool). The manual proxy is never retired — it's the
      // operator's fixed egress, reported but not discarded.
      const tiers = [];
      if (opts.proxy) tiers.push('manual');
      if (opts.proxyProvider || opts.proxyProviderLive) tiers.push('pool');
      tiers.push('direct');

      // Watchdog: cap total wall-clock time on the FIRST tier that actually
      // runs. If testOne hangs (TCP accept but no banner, TLS handshake loop,
      // etc.), abandon it and move on. Prevents silent worker starvation.
      //
      // The budget MUST cover the placement-polling phase too: testOne, when a
      // seed is configured, legitimately waits up to placementTimeoutMs (default
      // 90s) for the tagged mail to appear over IMAP. A flat 25s watchdog shorter
      // than that aborts every slow-but-valid placement as a "watchdog timeout",
      // so valid SMTPs never get classified inbox/spam. Budget = network phase +
      // placement phase. Later fallback tiers only ever run after a fast connect
      // failure, so a plain await is enough for them.
      const networkBudgetMs = Number(opts.credentialTimeoutMs) || 25000;
      const watchdogMs = networkBudgetMs + (Number(opts.placementTimeoutMs) || 0);

      let result;
      let primaryOpts = opts;        // first-run opts, reused by the retry loop below
      let ranPrimary = false;
      let proxyFell = false;         // did we fall through ≥1 proxied tier?
      let lastDeadProxy = null;      // URL of the last proxied tier that connect-failed
      let lastDeadWasPool = false;   // was that dead tier a (retirable) pool proxy?

      for (const kind of tiers) {
        if (signal?.aborted) return;
        let tierProxy;
        if (kind === 'manual') tierProxy = opts.proxy;
        else if (kind === 'pool') {
          // Prefer a validate-on-acquire provider so a dead proxy is never used;
          // fall back to the plain round-robin provider when none is injected.
          try { tierProxy = opts.proxyProviderLive ? await opts.proxyProviderLive() : (opts.proxyProvider?.() ?? null); }
          catch { tierProxy = null; }
        }
        else tierProxy = null;
        // A pool tier that yields nothing (empty pool) or just re-hands the
        // manual proxy adds no new egress — skip straight to the next tier.
        if (kind === 'pool' && (!tierProxy || tierProxy === opts.proxy)) continue;

        const attemptOpts = (tierProxy === opts.proxy && !opts.proxyProvider)
          ? opts
          : { ...opts, proxy: tierProxy, proxyProvider: undefined };

        if (!ranPrimary) {
          ranPrimary = true;
          primaryOpts = attemptOpts;
          let watchdogTimer;
          try {
            result = await Promise.race([
              testOne(cred, index, seeds, attemptOpts, smtp, imap, ctx),
              // Cleared in finally so the timer never outlives the credential — on
              // a long run these would otherwise pile up (each living up to
              // watchdogMs), leaking closures and churning the event loop.
              new Promise((_, reject) => { watchdogTimer = setTimeout(() => reject(new Error('watchdog_timeout')), watchdogMs); }),
            ]);
          } catch (err) {
            result = err.message === 'watchdog_timeout'
              ? { cred, status: 'dead', reason: 'watchdog timeout (' + watchdogMs + 'ms)', deadReason: 'connect', latencyMs: watchdogMs }
              : { cred, status: 'dead', reason: err.message, deadReason: 'connect' };
          } finally {
            clearTimeout(watchdogTimer);
          }
        } else {
          result = await testOne(cred, index, seeds, attemptOpts, smtp, imap, ctx);
        }

        // Got past the connect phase (success, or an auth/send verdict no proxy
        // change would fix): stop here.
        if (result.deadReason !== 'connect') break;
        // This tier connect-failed. Record it (if proxied) and advance.
        if (tierProxy) { proxyFell = true; lastDeadProxy = tierProxy; lastDeadWasPool = kind === 'pool'; }
      }

      // A proxied tier failed before we got a verdict: flag the fallback for the
      // renderer, and retire the dead proxy only if it was a pool proxy AND a
      // later tier actually reached the server.
      if (proxyFell) {
        result.proxyFallback = true;
        result.proxyFallbackReason = 'dead proxy — retried without it';
        result.proxyThatDied = lastDeadProxy;
        if (result.deadReason !== 'connect' && lastDeadWasPool && typeof opts.onProxyFailure === 'function') {
          try { opts.onProxyFailure(lastDeadProxy, String(result.reason || '')); } catch {}
        }
      }
      // Retry transient conditions with backoff:
      //  - a transient CONNECT failure (opts.retries, default 0), and
      //  - a THROTTLED/BLOCKED login (default 2 tries): the server rate-limited
      //    the test IP rather than rejecting the password, so a valid credential
      //    would otherwise read as dead. Blocked retries wait longer (the block
      //    clears with time) and rotate to a fresh pool proxy when one exists, so
      //    the next attempt comes from a different egress IP.
      const connectRetries = opts.retries ?? 0;
      const blockedRetries = opts.blockedRetries ?? 2;
      for (let attempt = 0; attempt < Math.max(connectRetries, blockedRetries) && !signal?.aborted; attempt++) {
        const retryConnect = result.deadReason === 'connect' && attempt < connectRetries;
        const retryBlocked = result.blocked && attempt < blockedRetries;
        if (!retryConnect && !retryBlocked) break;
        await new Promise((r) => setTimeout(r, retryBlocked ? (opts.blockedBackoffMs ?? 8000) : (opts.retryBackoffMs ?? 2000)));
        if (signal?.aborted) break;
        let retryOpts;
        if (retryBlocked && (opts.proxyProviderLive || typeof opts.proxyProvider === 'function')) {
          let fresh = null;
          try { fresh = opts.proxyProviderLive ? await opts.proxyProviderLive() : opts.proxyProvider(); } catch { fresh = null; }
          retryOpts = { ...opts, proxy: fresh || undefined, proxyProvider: undefined, proxyProviderLive: undefined };
        } else {
          retryOpts = result.proxyFallback ? { ...opts, proxy: null, proxyProvider: undefined } : primaryOpts;
        }
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
