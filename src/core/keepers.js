/**
 * "Keeper" classification: which results are rare and valuable enough that the
 * dashboard must retain EVERY one of them for the tile drawer, rather than only
 * the newest `recent` window. On a large scan the bulk dead/unknown results push
 * early inbox/spam/valid (and control-panel) hits out of the 5000-row window, so
 * the tile count (a cumulative total) and the drawer content (filtered from that
 * window) drift apart — the tile reads "24 inbox" while the drawer shows none.
 * Keepers are a small fraction of any real run, so keeping all of them is cheap.
 *
 * Pure and renderer-safe (no node deps) so the renderer and the run-file reader
 * share one definition of "worth keeping".
 */

/** Statuses whose every hit the drawer must be able to show/copy, scan size aside. */
export const KEEPER_STATUSES = ['inbox', 'spam', 'valid', 'unverified', 'limited'];

const PANEL_TYPES = ['cpanel', 'whm', 'webmail'];

/** @param {object} r a tester Result @returns {boolean} keep every one of these. */
export function isKeeperResult(r) {
  if (!r) return false;
  if (KEEPER_STATUSES.includes(r.status)) return true;
  if (r.panels) {
    for (const t of PANEL_TYPES) if (r.panels[t] && r.panels[t].valid) return true;
  }
  return false;
}
