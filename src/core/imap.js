import { ImapFlow } from 'imapflow';

/**
 * IMAP placement lookup for seed mailboxes.
 *
 * @typedef {{
 *   label:string, imapHost:string, imapPort:number,
 *   imapUser:string, imapPassword:string, address:string,
 *   junkFolders?:string[],
 * }} Seed
 */

const INBOX_CANDIDATES = ['inbox'];
const JUNK_PATTERNS = [/spam/i, /junk/i, /bulk/i];

/**
 * Pick the inbox and junk folder names out of a mailbox list.
 * Pure function — unit-tested without a live connection.
 *
 * @param {string[]} mailboxNames
 * @param {{inbox?:string, junk?:string}} overrides
 * @returns {{inbox:string, junk:string|null}}
 */
export function resolveFolders(mailboxNames, overrides = {}) {
  const names = mailboxNames ?? [];

  const inbox =
    overrides.inbox ||
    names.find((n) => INBOX_CANDIDATES.includes(n.toLowerCase())) ||
    'INBOX';

  let junk = overrides.junk || null;
  if (!junk) {
    for (const pattern of JUNK_PATTERNS) {
      const match = names.find((n) => pattern.test(n));
      if (match) {
        junk = match;
        break;
      }
    }
  }

  return { inbox, junk };
}

function makeClient(seed) {
  return new ImapFlow({
    host: seed.imapHost,
    port: seed.imapPort || 993,
    secure: (seed.imapPort || 993) === 993,
    auth: { user: seed.imapUser, pass: seed.imapPassword },
    logger: false,
    // Seed mailboxes are well-known providers with valid certificates; keep
    // certificate verification ON so the user's app-password can't be captured
    // by a man-in-the-middle on the IMAP connection.
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate a seed's IMAP login and list its folders.
 * @param {Seed} seed
 * @returns {Promise<{ok:boolean, folders?:string[], error?:string}>}
 */
export async function verifySeed(seed) {
  const client = makeClient(seed);
  try {
    await client.connect();
    const boxes = await client.list();
    const folders = boxes.map((b) => b.path);
    return { ok: true, folders };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      await client.logout();
    } catch {
      /* already disconnected */
    }
  }
}

/**
 * Poll a seed mailbox for a message whose Subject contains `token`.
 * Searches the inbox first, then the junk folder, repeatedly until found or
 * the timeout elapses. Never throws — IMAP errors become {found:false,error}.
 *
 * @param {Seed} seed
 * @param {string} token
 * @param {{timeoutMs?:number, pollIntervalMs?:number, folders?:{inbox?:string,junk?:string}}} opts
 * @returns {Promise<{found:boolean, folder:('inbox'|'spam'|null), error?:string}>}
 */
export async function findToken(seed, token, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 90000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  const client = makeClient(seed);

  try {
    await client.connect();
    const boxes = await client.list();
    const { inbox, junk } = resolveFolders(
      boxes.map((b) => b.path),
      { inbox: opts.folders?.inbox, junk: opts.folders?.junk ?? seed.junkFolders?.[0] },
    );

    const targets = [
      { path: inbox, result: 'inbox' },
      ...(junk ? [{ path: junk, result: 'spam' }] : []),
    ];

    do {
      for (const target of targets) {
        const uid = await searchFolder(client, target.path, token);
        if (uid) {
          const authResults = await fetchAuthResults(client, target.path, uid);
          return { found: true, folder: /** @type {'inbox'|'spam'} */ (target.result), authResults };
        }
      }
      if (Date.now() + pollIntervalMs < deadline) await sleep(pollIntervalMs);
      else break;
    } while (Date.now() < deadline);

    return { found: false, folder: null };
  } catch (err) {
    return { found: false, folder: null, error: err.message };
  } finally {
    try {
      await client.logout();
    } catch {
      /* already disconnected */
    }
  }
}

/** Open a mailbox read-only and search its Subject lines for the token; returns a matching UID or null. */
async function searchFolder(client, path, token) {
  const lock = await client.getMailboxLock(path, { readonly: true });
  try {
    const uids = await client.search({ header: { subject: token } }, { uid: true });
    return Array.isArray(uids) && uids.length > 0 ? uids[uids.length - 1] : null;
  } finally {
    lock.release();
  }
}

/** Fetch the Authentication-Results header of a delivered message (best-effort). */
async function fetchAuthResults(client, path, uid) {
  const lock = await client.getMailboxLock(path, { readonly: true });
  try {
    const msg = await client.fetchOne(uid, { headers: ['authentication-results'] }, { uid: true });
    if (!msg || !msg.headers) return null;
    const text = msg.headers.toString().trim();
    return text || null;
  } catch {
    return null;
  } finally {
    lock.release();
  }
}
