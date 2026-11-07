/**
 * Map the raw results of a credential's test pipeline to a final status.
 *
 * @typedef {{label:string, folder:('inbox'|'spam'|null), error?:string}} SeedPlacement
 * @typedef {{
 *   connected:boolean,
 *   authenticated:boolean,
 *   authError?:string,
 *   sent:boolean,
 *   sendError?:string,
 *   seeds:SeedPlacement[],
 * }} StepResults
 * @typedef {{status:('dead'|'valid'|'inbox'|'spam'|'unknown'), reason:string, perSeed:SeedPlacement[]}} Classification
 */

/** @param {StepResults} s @returns {Classification} */
export function classify(s) {
  const seeds = s.seeds ?? [];
  const perSeed = seeds;

  if (!s.connected) {
    return { status: 'dead', reason: s.connectError || 'could not connect to server', perSeed };
  }
  if (!s.authenticated) {
    // The server connected but refused the login. `userExists` (from the SMTP
    // probe) distinguishes "account not recognized" from "account exists, login
    // refused (e.g. wrong password)". It is only meaningful here, so it is only
    // attached on an auth rejection.
    const base = s.authError || 'authentication failed';
    const out = { status: 'dead', reason: base, perSeed };
    if (s.userExists !== undefined) {
      out.userExists = s.userExists;
      if (s.userExists === false) out.reason = `${base} — account not found on server`;
    }
    return out;
  }
  if (!s.sent) {
    return { status: 'dead', reason: s.sendError || 'server rejected the message', perSeed };
  }

  // Authenticated and the message was accepted for delivery.
  if (seeds.length === 0) {
    return { status: 'valid', reason: 'sent; placement not evaluated (no seed mailboxes)', perSeed };
  }

  const resolved = seeds.filter((seed) => seed.folder === 'inbox' || seed.folder === 'spam');
  if (resolved.length === 0) {
    const allErrored = seeds.every((seed) => seed.error);
    const reason = allErrored
      ? 'sent; placement undetermined (all seed mailboxes errored)'
      : 'sent; placement undetermined (not found before timeout)';
    // All-errored means we never got a placement signal at all -> treat as valid+note.
    // Otherwise the mail was sent but never located -> unknown.
    return { status: allErrored ? 'valid' : 'unknown', reason, perSeed };
  }

  if (resolved.some((seed) => seed.folder === 'spam')) {
    return { status: 'spam', reason: 'landed in spam on at least one seed', perSeed };
  }
  return { status: 'inbox', reason: 'landed in inbox on all resolved seeds', perSeed };
}
