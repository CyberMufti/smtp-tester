/**
 * Health-monitor change detection (pure).
 *
 * Compares a previous status map to a fresh batch of results and reports which
 * credentials went from a working state to dead — the transitions worth
 * alerting on.
 *
 * @typedef {import('./tester.js').Result} Result
 */

// Statuses that mean the SMTP currently works (authenticated + accepted a send).
const LIVE = new Set(['valid', 'inbox', 'spam', 'unknown']);

/** Stable per-credential key (matches the dedupe key). */
export function credKey(cred) {
  return `${cred.host || ''}|${cred.port || ''}|${cred.user}|${cred.pass}`.toLowerCase();
}

/**
 * @param {Record<string,string>} prevMap  key -> previous status
 * @param {Result[]} results
 * @returns {{died: Result[], newMap: Record<string,string>}}
 */
export function monitorDiff(prevMap, results) {
  const newMap = { ...(prevMap || {}) };
  const died = [];
  for (const r of results || []) {
    const key = credKey(r.cred);
    const prev = (prevMap || {})[key];
    if (prev && LIVE.has(prev) && r.status === 'dead') died.push(r);
    newMap[key] = r.status;
  }
  return { died, newMap };
}
