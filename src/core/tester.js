import * as realSmtp from './smtp.js';
import * as realImap from './imap.js';
import { classify } from './classify.js';
import { candidatesFor } from './providers.js';
import { checkDomain, parseAuthResults } from './authrecords.js';
import { checkIp } from './dnsbl.js';
import { scoreContent } from './spamscore.js';

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
 * @typedef {{cred:Credential, status:string, reason:string, perSeed:any[], latencyMs:number}} Result
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
  const subject = (opts.subjectTemplate || 'SMTP Tester {token}').replace('{token}', token);
  const text = (opts.bodyTemplate || 'SMTP deliverability test. Token: {token}').replace('{token}', token);

  const step = { connected: false, authenticated: false, sent: false, seeds: [] };
  const manualRecipients = (opts.manualRecipients || []).map((r) => String(r).trim()).filter(Boolean);
  let usedHost = null;
  let usedPort = null;
  let triedFallback = false;

  try {
    // Build the ordered list of (host, port) endpoints to try: the user's
    // input first, then the detected provider endpoint as a fallback.
    const candidates = candidatesFor(cred);
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
      const v = await smtp.verify(effective, { connectTimeout: opts.connectTimeout });
      if (v.connected && v.authenticated) {
        working = cand;
        triedFallback = i > 0;
        break;
      }
      if (v.connected) {
        anyConnected = true;
        authError = v.error;
        authFailedHosts.add(cand.host);
        continue;
      }
      lastConnectError = v.error;
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
      const to = recipients.length > 0 ? recipients : [opts.from || cred.from || cred.user];

      const sendRes = await smtp.send(effective, {
        to: to.join(', '),
        from: opts.from || cred.from || cred.user,
        subject,
        text,
        sendTimeout: opts.sendTimeout,
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

  const { status, reason, perSeed } = classify(step);

  const result = {
    cred,
    status,
    reason,
    perSeed,
    latencyMs: Date.now() - start,
    token,
    subject,
    usedHost,
    usedPort,
    triedFallback,
    manualRecipients,
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
export async function runBatch(creds, seeds = [], opts = {}, onProgress) {
  const smtp = opts.deps?.smtp ?? realSmtp;
  const imap = opts.deps?.imap ?? realImap;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const signal = opts.signal;

  const results = new Array(creds.length);
  let next = 0;

  // Shared per-batch context: the content spam score (same for every message)
  // is computed once; DNS lookups are cached by domain and host.
  const ctx = { domainCache: new Map(), dnsblCache: new Map() };
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
      const index = next++;
      if (index >= creds.length) return;
      const result = await testOne(creds[index], index, seeds, opts, smtp, imap, ctx);
      results[index] = result;
      if (onProgress) onProgress(result, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, creds.length) }, () => worker());
  await Promise.all(workers);

  return results.filter(Boolean);
}
