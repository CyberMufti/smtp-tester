/**
 * Legacy-auth / transport-security audit for a mail server you operate.
 *
 * This does NOT test credentials. It opens a connection, runs the opening SMTP
 * dialogue (EHLO, optionally STARTTLS), reads the server's advertised
 * capabilities, and reports transport-security problems you can then fix on the
 * server — chiefly: is password authentication offered over a cleartext channel
 * (before STARTTLS), and is STARTTLS even available on a submission port.
 *
 * The capability parsing and the analysis are pure functions (unit-tested); the
 * socket dialogue is a thin probe around them.
 */
import net from 'node:net';
import tls from 'node:tls';

const BASIC_AUTH_MECHS = new Set(['LOGIN', 'PLAIN']);

/**
 * Parse the capability lines of an EHLO reply.
 * Accepts the raw multiline response (e.g. "250-SIZE 100\r\n250 AUTH LOGIN PLAIN")
 * or an array of already-split lines.
 * @param {string|string[]} linesOrText
 * @returns {{mechs:string[], starttls:boolean, caps:string[]}}
 */
export function parseEhlo(linesOrText) {
  const lines = Array.isArray(linesOrText)
    ? linesOrText
    : String(linesOrText ?? '').split(/\r?\n/);

  const caps = [];
  let mechs = [];
  let starttls = false;

  for (const raw of lines) {
    // Strip a leading "250-" / "250 " reply code if present.
    const line = raw.replace(/^\s*\d{3}[-\s]?/, '').trim();
    if (!line) continue;
    const keyword = line.split(/\s+/)[0].toUpperCase();
    caps.push(line);
    if (keyword === 'STARTTLS') starttls = true;
    if (keyword === 'AUTH' || keyword.startsWith('AUTH=')) {
      // "AUTH LOGIN PLAIN XOAUTH2" — or the rare "AUTH=LOGIN..." form.
      mechs = line
        .slice(4)
        .replace(/^=/, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((m) => m.toUpperCase());
    }
  }

  return { mechs, starttls, caps };
}

/**
 * Turn the observed capabilities into a report with concrete findings.
 *
 * @param {{
 *   host:string, port:number,
 *   implicitTls:boolean,                // true for an implicit-TLS port (465)
 *   plain?:{mechs:string[], starttls:boolean, caps:string[]}|null, // pre-STARTTLS (cleartext) view
 *   secure?:{mechs:string[], starttls:boolean, caps:string[]}|null, // post-STARTTLS or implicit-TLS view
 * }} obs
 * @returns {{host:string, port:number, findings:Array<{id:string,severity:string,message:string}>, mechs:string[], okReasons:string[]}}
 */
export function analyzeAudit(obs) {
  const findings = [];
  const okReasons = [];
  const { plain, secure, implicitTls, port } = obs;

  // Cleartext AUTH exposure: password auth offered on the plaintext channel,
  // before any STARTTLS upgrade. Credentials would travel in the clear.
  if (!implicitTls && plain && plain.mechs.length) {
    const basic = plain.mechs.filter((m) => BASIC_AUTH_MECHS.has(m));
    findings.push({
      id: 'cleartext-auth',
      severity: 'high',
      message:
        `Server offers AUTH (${plain.mechs.join(', ')}) before STARTTLS — ` +
        `${basic.length ? 'basic-auth credentials' : 'credentials'} can be sent in cleartext. ` +
        `Require STARTTLS before advertising AUTH.`,
    });
  } else if (!implicitTls && plain && !plain.mechs.length) {
    okReasons.push('No AUTH advertised on the cleartext channel.');
  }

  // No STARTTLS on a submission/relay port means there is no way to go secure.
  if (!implicitTls && plain && !plain.starttls) {
    findings.push({
      id: 'no-starttls',
      severity: 'high',
      message: `STARTTLS is not advertised on port ${port}. Clients cannot upgrade to TLS.`,
    });
  } else if (!implicitTls && plain && plain.starttls) {
    okReasons.push('STARTTLS is advertised.');
  }

  // Inventory the mechanisms available on the secure channel (informational):
  // flag that basic-auth is enabled so the operator can decide whether to move
  // to modern mechanisms (XOAUTH2 / OAUTHBEARER).
  const secureMechs = (secure || plain || { mechs: [] }).mechs;
  const legacy = secureMechs.filter((m) => BASIC_AUTH_MECHS.has(m));
  if (legacy.length) {
    findings.push({
      id: 'basic-auth-enabled',
      severity: 'info',
      message:
        `Basic auth (${legacy.join(', ')}) is enabled on the secure channel. ` +
        `This is normal over TLS, but if your clients support it, prefer modern mechanisms ` +
        `(XOAUTH2 / OAUTHBEARER) and disable basic auth to reduce credential-stuffing exposure.`,
    });
  }
  if (implicitTls) okReasons.push('Implicit TLS in use (no cleartext channel on this port).');

  return {
    host: obs.host,
    port,
    findings,
    mechs: secureMechs,
    okReasons,
  };
}

// --- Socket probe ---------------------------------------------------------

/** Read one complete SMTP reply (handles multiline "250-" continuations). */
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // A reply is complete when a line is "NNN " (space after the code), i.e.
      // not a "NNN-" continuation.
      const lines = buf.split(/\r?\n/).filter((l) => l.length);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), lines });
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => onErr(new Error('timeout waiting for server reply')), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

function sendLine(socket, line) {
  socket.write(line + '\r\n');
}

/**
 * Connect to a mail server and read its advertised capabilities, over the
 * cleartext channel and (if offered) after STARTTLS. Returns the observation
 * object consumed by {@link analyzeAudit}. Credentials are never sent.
 *
 * @param {{host:string, port:number, connectTimeout?:number, ehloName?:string}} args
 * @returns {Promise<ReturnType<typeof analyzeAudit>>}
 */
export async function auditServer({ host, port, connectTimeout = 10000, ehloName = 'auditor.local' }) {
  const implicitTls = Number(port) === 465;
  let socket;
  const result = { host, port: Number(port), implicitTls, plain: null, secure: null };

  try {
    socket = implicitTls
      ? tls.connect({ host, port, rejectUnauthorized: false, timeout: connectTimeout })
      : net.connect({ host, port, timeout: connectTimeout });

    await new Promise((resolve, reject) => {
      socket.once(implicitTls ? 'secureConnect' : 'connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('connect timeout')));
    });

    await readReply(socket, connectTimeout); // greeting (220)
    sendLine(socket, `EHLO ${ehloName}`);
    const ehlo1 = await readReply(socket, connectTimeout);
    const caps1 = parseEhlo(ehlo1.lines);

    if (implicitTls) {
      result.secure = caps1;
    } else {
      result.plain = caps1;
      if (caps1.starttls) {
        sendLine(socket, 'STARTTLS');
        await readReply(socket, connectTimeout); // 220 ready
        const upgraded = await new Promise((resolve, reject) => {
          const s = tls.connect({ socket, host, servername: host, rejectUnauthorized: false }, () => resolve(s));
          s.once('error', reject);
        });
        socket = upgraded;
        sendLine(socket, `EHLO ${ehloName}`);
        const ehlo2 = await readReply(socket, connectTimeout);
        result.secure = parseEhlo(ehlo2.lines);
      }
    }

    try {
      sendLine(socket, 'QUIT');
    } catch {
      /* best-effort */
    }
    return analyzeAudit(result);
  } finally {
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
  }
}
