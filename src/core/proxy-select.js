/**
 * Decide which proxy tier a batch should start from, given the manual proxy's
 * liveness and whether the scraped pool has any live proxies.
 *
 * Priority: manual proxy → scraped pool → direct. The manual proxy is the
 * primary egress when it's alive; if it's dead we fall through to the pool,
 * and if the pool is empty too we go direct. The returned `usePool` flag tells
 * the caller whether to wire the pool's rotation/retirement callbacks in as the
 * next fallback tier (used as secondary when manual is primary, primary when
 * manual is dead).
 *
 * Pure and dependency-free so it can be unit-tested; the real liveness probe is
 * performed by the caller and passed in as `manualAlive`.
 *
 * @param {object} opts
 * @param {string|null} opts.manualUrl  the configured manual SOCKS URL, or null when none/declined
 * @param {boolean} opts.manualAlive    result of a liveness probe against manualUrl
 * @param {boolean} opts.hasPool        whether the scraped pool has ≥1 live proxy
 * @returns {{ proxy: string|null, tier: 'manual'|'pool'|'direct', usePool: boolean }}
 */
export function selectProxyTier({ manualUrl, manualAlive, hasPool }) {
  if (manualUrl && manualAlive) {
    return { proxy: manualUrl, tier: 'manual', usePool: !!hasPool };
  }
  if (hasPool) {
    return { proxy: null, tier: 'pool', usePool: true };
  }
  return { proxy: null, tier: 'direct', usePool: false };
}

/**
 * Human-readable notice for the renderer describing the chosen tier, or null
 * when the manual proxy is alive (the expected/quiet path).
 * @param {{ proxy: string|null, tier: string }} selection
 * @param {string|null} manualUrl
 * @returns {string|null}
 */
export function proxyTierNotice(selection, manualUrl) {
  if (!manualUrl) return null; // user went direct by choice — nothing to report
  if (selection.tier === 'manual') return null;
  if (selection.tier === 'pool') return 'Manual proxy is dead — routing this run through the scraped proxy pool.';
  return 'Manual proxy is dead and the proxy pool is empty — running this batch directly.';
}
