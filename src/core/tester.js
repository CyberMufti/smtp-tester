import * as realSmtp from './smtp.js';
import * as realImap from './imap.js';
import { classify } from './classify.js';

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

  try {
    const v = await smtp.verify(cred, { connectTimeout: opts.connectTimeout });
    step.connected = v.connected;
    step.authenticated = v.authenticated;
    if (!v.connected) step.connectError = v.error;
    else if (!v.authenticated) step.authError = v.error;

    if (v.connected && v.authenticated) {
      const recipients = seeds.length > 0 ? seeds.map((s) => s.address) : [opts.from || cred.from || cred.user];
      const sendRes = await smtp.send(cred, {
        to: recipients.join(', '),
        from: opts.from || cred.from || cred.user,
        subject,
        text,
        sendTimeout: opts.sendTimeout,
      });
      step.sent = (sendRes.accepted?.length ?? 0) > 0;
      if (!step.sent) step.sendError = sendRes.error || 'message not accepted by server';

      if (step.sent && seeds.length > 0) {
        step.seeds = await Promise.all(
          seeds.map(async (seed) => {
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
  return { cred, status, reason, perSeed, latencyMs: Date.now() - start };
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
