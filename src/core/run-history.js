/**
 * Run history: compact per-run summaries persisted locally so runs can be
 * compared over time. Pure helpers — the store I/O lives in the main process.
 *
 * @typedef {{
 *   at:string|null, source:string, total:number,
 *   counts:Record<string,number>, grades:Record<string,number>,
 *   topProviders:{name:string,count:number}[], topCountries:{name:string,count:number}[]
 * }} RunSummary
 */

function topN(map, n) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Build a compact, storable summary of a run from the tallies the UI already
 * keeps. Pure.
 * @returns {RunSummary}
 */
export function summarizeRun({ at = null, total = 0, source = 'test', counts = {}, providers = {}, countries = {}, grades = {} } = {}) {
  return {
    at,
    source,
    total: total || 0,
    counts: { ...counts },
    grades: { ...grades },
    topProviders: topN(providers, 5),
    topCountries: topN(countries, 5),
  };
}

/**
 * Prepend a summary to the history list (newest first) and cap the length.
 * Pure — returns a new array.
 * @param {RunSummary[]} history
 * @param {RunSummary} summary
 * @param {number} [cap=50]
 * @returns {RunSummary[]}
 */
export function pushHistory(history, summary, cap = 50) {
  return [summary, ...(history || [])].slice(0, Math.max(1, cap));
}
