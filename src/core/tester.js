import * as realSmtp from './smtp.js';
import * as realImap from './imap.js';
import { classify } from './classify.js';
import { candidatesFor } from './providers.js';

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
async function testOne(cred, index, seeds, opts, smtp, imap) {
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

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const effective = { ...cred, host: cand.host, port: cand.port };
      const v = await smtp.verify(effective, { connectTimeout: opts.connectTimeout });
      if (v.connected && v.authenticated) {
        working = cand;
        triedFallback = i > 0;
        break;
      }
      if (v.connected) {
        // Host is reachable but auth was rejected — a credential problem, not a
        // host problem. No point trying other hosts with the same credentials.
        anyConnected = true;
        authError = v.error;
        break;
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
            return { label: seed.label, folder: found.folder, error: found.error };
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
  return {
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

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= creds.length) return;
      const result = await testOne(creds[index], index, seeds, opts, smtp, imap);
      results[index] = result;
      if (onProgress) onProgress(result, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, creds.length) }, () => worker());
  await Promise.all(workers);

  return results.filter(Boolean);
}
