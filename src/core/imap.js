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
// Junk/spam folder names across the common providers and locales. Name matching
// is the fallback; the reliable signal is the IMAP \Junk special-use attribute
// (RFC 6154), which is checked first.
const JUNK_PATTERNS = [
  /spam/i, /junk/i, /bulk/i, /quarantine/i,
  /pourriel/i, /ind[eé]sirable/i,            // French
  /no\s*deseado/i, /correo\s*no\s*deseado/i, // Spanish
  /indesiderat/i,                            // Italian
  /unerw[uü]nscht/i, /spamverdacht/i,        // German
  /ongewenst/i,                              // Dutch
  /lixo\s*eletr[oô]nico/i,                   // Portuguese
  /skr[aä]ppost/i,                           // Swedish/Norwegian/Danish
  /roskaposti/i,                             // Finnish
  /спам/i, /нежелательн/i,                   // Russian
  /垃圾/,                                     // Chinese (垃圾邮件)
  /迷惑/,                                     // Japanese (迷惑メール)
  /스팸/,                                     // Korean
];

/** Normalize a mailbox entry (string path or {path, specialUse}) to an object. */
function asBox(m) {
  return typeof m === 'string' ? { path: m, specialUse: null } : { path: m?.path, specialUse: m?.specialUse || null };
}

/**
 * Pick the inbox and junk folders out of a mailbox list. Accepts plain name
 * strings or richer `{path, specialUse}` entries; when special-use attributes
 * are present, the \Inbox / \Junk folders are used directly (locale-proof),
 * falling back to name matching otherwise. Pure — unit-tested without a live
 * connection.
 *
 * @param {(string|{path:string, specialUse?:string})[]} mailboxes
 * @param {{inbox?:string, junk?:string}} overrides
 * @returns {{inbox:string, junk:string|null}}
 */
export function resolveFolders(mailboxes, overrides = {}) {
  const list = (mailboxes ?? []).map(asBox).filter((m) => m.path);
  const names = list.map((m) => m.path);

  const inbox =
    overrides.inbox ||
    list.find((m) => m.specialUse === '\\Inbox')?.path ||
    names.find((n) => INBOX_CANDIDATES.includes(String(n).toLowerCase())) ||
    'INBOX';

  let junk = overrides.junk || null;
  if (!junk) junk = list.find((m) => m.specialUse === '\\Junk')?.path || null;
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
    // Bound every phase so a stalled seed connection can't hang indefinitely.
    // This matters because placement runs under a per-seed concurrency cap
    // (see tester.js): a connection that never resolves would hold its slot and
    // block all further placement for that seed. ImapFlow's default
    // socketTimeout is 5 minutes — far longer than the placement window — so we
    // tighten it, while staying well above the 5s poll interval so an idle
    // connection between polls is never killed.
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
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
      boxes.map((b) => ({ path: b.path, specialUse: b.specialUse || null })),
      { inbox: opts.folders?.inbox, junk: opts.folders?.junk ?? seed.junkFolders?.[0] },
    );

    const targets = [
      { path: inbox, result: 'inbox' },
      ...(junk ? [{ path: junk, result: 'spam' }] : []),
    ];

    do {
      let anyOk = false;
      let roundErr = null;
      for (const target of targets) {
        try {
          const uid = await searchFolder(client, target.path, token);
          anyOk = true;
          if (uid) {
            const authResults = await fetchAuthResults(client, target.path, uid);
            return { found: true, folder: /** @type {'inbox'|'spam'} */ (target.result), authResults };
          }
        } catch (err) {
          // A single folder failing (e.g. junk can't be opened) shouldn't abort
          // the inbox check; remember the error and keep going. Only if EVERY
          // folder fails this round do we treat the connection as dead (below).
          roundErr = err;
        }
      }
      if (!anyOk && roundErr) return { found: false, folder: null, error: roundErr.message };
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
