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
 * @typedef {{status:('dead'|'valid'|'inbox'|'spam'|'unverified'|'unknown'), reason:string, perSeed:SeedPlacement[]}} Classification
 */

/**
 * Downgrade an authenticated-and-sent "valid" result to "unverified" when the
 * sending domain's published auth records can't carry mail to external inboxes:
 * a missing SPF record or a missing DMARC record. Such a domain's mail is
 * routinely dropped or quarantined by major providers, so a bare "valid" (which
 * only proves the SMTP accepted the message) would overstate deliverability.
 *
 * Only gates "valid". "inbox"/"spam" already have proof the mail landed, and the
 * other states aren't a positive signal to soften. Returns an override
 * `{status, reason}` when the gate applies, otherwise null (leave the result
 * unchanged). A published DMARC policy of any strength (none/quarantine/reject)
 * counts as present — enforcement is not a problem; absence is.
 *
 * @param {string} status  the status from {@link classify}
 * @param {{spf?:{found:boolean}, dmarc?:{found:boolean}}|undefined} deliverability
 * @returns {{status:'unverified', reason:string}|null}
 */
export function applyAuthGate(status, deliverability) {
  if (status !== 'valid' || !deliverability) return null;
  const { spf, dmarc } = deliverability;
  // Only gate when the SPF/DMARC lookup actually ran (records were resolved);
  // with deliverability checks off there is nothing to judge.
  if (spf === undefined || dmarc === undefined) return null;

  const reasons = [];
  // SPF. `found` comes from either the JS record read or the sidecar. `result`
  // is only present when the Python sidecar evaluated SPF against the real
  // sending IP — a 'fail' there means the IP the SMTP sends from is explicitly
  // NOT authorized (-all), so strict receivers reject. (softfail/neutral/none
  // stay lenient, matching record-presence behavior.)
  if (!spf.found) reasons.push('no SPF record');
  else if (spf.result === 'fail') reasons.push('SPF rejects the sending IP (-all)');

  // DMARC. Missing record always gates. With the sidecar, an explicit
  // non-alignment under an enforcing policy (quarantine/reject) means the mail
  // is quarantined/rejected; p=none is monitor-only, so it does not gate.
  if (!dmarc.found) reasons.push('no DMARC record');
  else if (dmarc.aligned === false && (dmarc.policy === 'reject' || dmarc.policy === 'quarantine')) {
    reasons.push(`DMARC ${dmarc.policy} with no alignment`);
  }

  if (reasons.length === 0) return null;
  return {
    status: 'unverified',
    reason: `sent, but ${reasons.join(' and ')} — external inbox delivery will likely be blocked`,
  };
}

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
    // No seed mailboxes AND no manual recipients: the message could only be
    // sent back to the account itself. A server accepting mail to its own local
    // user does NOT prove it can relay to external inboxes, so don't let a bare
    // "valid" imply deliverability it never tested.
    if (s.selfSendOnly) {
      return {
        status: 'valid',
        reason: 'sent to self only — external delivery not verified (add a seed mailbox or manual recipient)',
        selfSendOnly: true,
        perSeed,
      };
    }
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
