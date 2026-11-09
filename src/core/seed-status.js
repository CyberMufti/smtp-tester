/**
 * Decide whether Inbox/Spam placement can actually be verified for a run, based
 * on the configured seed mailboxes. Placement needs a mailbox the app can READ
 * back over IMAP, so a seed only counts when it has an address AND full IMAP
 * credentials (host, user, password). With no usable seed the app can still
 * report Dead / Valid (send-only), but a "valid" there only means the SMTP
 * accepted the message — never that it reached an inbox — so the UI warns.
 *
 * Pure and unit-tested; the renderer uses it for both the inline note and the
 * warning banner on the Test screen.
 *
 * @param {Array<{address?:string, imapHost?:string, imapUser?:string, imapPassword?:string}>} seeds
 * @returns {{enabled:boolean, warn:boolean, usableCount:number, message:string}}
 */
export function seedPlacementStatus(seeds) {
  const usable = (seeds || []).filter(
    (s) => s && nonEmpty(s.address) && nonEmpty(s.imapHost) && nonEmpty(s.imapUser) && nonEmpty(s.imapPassword),
  );
  const usableCount = usable.length;
  const enabled = usableCount > 0;
  const message = enabled
    ? `${usableCount} seed mailbox${usableCount === 1 ? '' : 'es'} — Inbox/Spam placement enabled`
    : 'No seed mailbox configured — results show Valid (server accepted) only, not confirmed Inbox/Spam. Add one under Seed Mailboxes to verify delivery.';
  return { enabled, warn: !enabled, usableCount, message };
}

function nonEmpty(v) {
  return typeof v === 'string' ? v.trim() !== '' : v != null && String(v).trim() !== '';
}
