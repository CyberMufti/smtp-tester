/**
 * Unified email-authentication check: SPF / DKIM / DMARC.
 *
 * Prefers the Python sidecar (`pyauth.js` -> `python/authcheck.py`) for accurate
 * SPF evaluation, real DKIM verification, and DMARC alignment. When Python or
 * its libraries aren't present, it falls back to the built-in JS record parsing
 * in `authrecords.js` — which still reports SPF/DMARC records and the final
 * qualifier/policy, but can't evaluate SPF against an IP or verify DKIM.
 *
 * Both paths return the same shape, with `engine` naming which ran, so the UI
 * can be honest about what was and wasn't checked.
 *
 * @typedef {{
 *   engine:('python'|'js-fallback'),
 *   domain:string,
 *   spf:{found:boolean, record:(string|null), all:(string|null), result?:(string|null), explanation?:(string|null)},
 *   dkim:{verified:(boolean|null), domains:string[], detail:(string|null)},
 *   dmarc:{found:boolean, record:(string|null), policy:(string|null), pct:(number|null), aligned?:(boolean|null)},
 *   missing?:string[]
 * }} AuthReport
 */
import { checkDomain } from './authrecords.js';
import { sidecarAvailable, runAuthSidecar } from './pyauth.js';

/** JS-only report: records parsed, but no SPF evaluation and no DKIM verification. */
async function jsFallback(domain, { resolveTxt }) {
  const { spf, dmarc } = await checkDomain(domain, { resolveTxt });
  return {
    engine: 'js-fallback',
    domain,
    spf: { ...spf, result: null, explanation: 'SPF evaluation requires the Python sidecar' },
    dkim: { verified: null, domains: [], detail: 'DKIM verification requires the Python sidecar' },
    dmarc: { ...dmarc, aligned: null },
  };
}

/**
 * @param {{domain:string, ip?:string, helo?:string, mailfrom?:string, message?:string}} request
 * @param {{resolveTxt:Function, exec?:Function}} deps
 * @returns {Promise<AuthReport>}
 */
export async function checkEmailAuth(request, { resolveTxt, exec } = {}) {
  const domain = String(request?.domain || '').trim();

  const avail = await sidecarAvailable({ exec });
  if (avail.available || avail.partial) {
    const res = await runAuthSidecar(request, { exec });
    if (res && res.ok) {
      return {
        engine: 'python',
        domain,
        spf: res.spf,
        dkim: res.dkim,
        dmarc: res.dmarc,
        missing: res.missing,
      };
    }
    // Sidecar was present but errored on this request — degrade to JS rather
    // than fail the whole check.
  }
  return jsFallback(domain, { resolveTxt });
}
