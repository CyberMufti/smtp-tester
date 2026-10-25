/**
 * SPF / DMARC DNS policy checks and parsing of a delivered message's
 * Authentication-Results header.
 *
 * The DNS functions take an injected resolver so they are unit-testable and so
 * the app can supply `node:dns/promises`. Parsing functions are pure.
 *
 * @typedef {{found:boolean, record:(string|null), all:(string|null)}} SpfResult
 * @typedef {{found:boolean, record:(string|null), policy:(string|null), pct:(number|null)}} DmarcResult
 */

/** @param {string[]} records @returns {SpfResult} */
export function parseSpf(records) {
  const record = (records || []).find((r) => /^v=spf1\b/i.test(r.trim()));
  if (!record) return { found: false, record: null, all: null };
  const m = record.match(/([-~?+])all\b/i);
  return { found: true, record, all: m ? `${m[1]}all` : null };
}

/** @param {string[]} records @returns {DmarcResult} */
export function parseDmarc(records) {
  const record = (records || []).find((r) => /^v=DMARC1\b/i.test(r.trim()));
  if (!record) return { found: false, record: null, policy: null, pct: null };
  const policy = record.match(/\bp\s*=\s*(none|quarantine|reject)\b/i);
  const pct = record.match(/\bpct\s*=\s*(\d{1,3})\b/i);
  return {
    found: true,
    record,
    policy: policy ? policy[1].toLowerCase() : null,
    pct: pct ? Number(pct[1]) : null,
  };
}

/**
 * Look up SPF (TXT on the domain) and DMARC (TXT on _dmarc.<domain>).
 * @param {string} domain
 * @param {{resolveTxt:(name:string)=>Promise<string[][]|string[]>}} deps
 * @returns {Promise<{domain:string, spf:SpfResult, dmarc:DmarcResult}>}
 */
export async function checkDomain(domain, { resolveTxt }) {
  const spf = parseSpf(await safeTxt(resolveTxt, domain));
  const dmarc = parseDmarc(await safeTxt(resolveTxt, `_dmarc.${domain}`));
  return { domain, spf, dmarc };
}

async function safeTxt(resolveTxt, name) {
  try {
    const raw = await resolveTxt(name);
    // node:dns returns string[][] (each record is an array of chunks); join them.
    return (raw || []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));
  } catch {
    return [];
  }
}

/**
 * Parse an Authentication-Results header value into spf/dkim/dmarc verdicts as
 * the receiving provider evaluated them — the most reliable auth signal.
 * @param {string} header
 * @returns {{spf:(string|null), dkim:(string|null), dmarc:(string|null)}}
 */
export function parseAuthResults(header) {
  const h = String(header || '');
  const grab = (method) => {
    const m = h.match(new RegExp(`\\b${method}\\s*=\\s*(\\w+)`, 'i'));
    return m ? m[1].toLowerCase() : null;
  };
  return { spf: grab('spf'), dkim: grab('dkim'), dmarc: grab('dmarc') };
}
