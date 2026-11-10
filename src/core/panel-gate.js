/**
 * Decide whether to run the control-panel fan-out (cPanel/webmail/WHM/SSH/
 * IMAP/POP3/...) for a credential.
 *
 * Panels exist to catch credentials that work on a host's panels even when
 * SMTP does not — so an SMTP *auth* or *send* failure is exactly when panels
 * matter most and must still run. Two cases are worth skipping:
 *
 *   - `deadReason === 'connect'`: after all SMTP retries the host could not be
 *     reached at all. HTTPS/SSH/IMAP panels on that host will only time out —
 *     pure wasted work (and a throughput sink) at scale.
 *   - `lockSkipped`: we deliberately did not test this account to avoid locking
 *     it; firing a dozen panel logins would hammer the account we just spared.
 *
 * @param {{ status?: string, deadReason?: string, lockSkipped?: boolean } | null | undefined} result
 * @returns {boolean}
 */
export function shouldRunPanelChecks(result) {
  if (!result) return false;
  if (result.lockSkipped) return false;
  if (result.status === 'dead' && result.deadReason === 'connect') return false;
  return true;
}
