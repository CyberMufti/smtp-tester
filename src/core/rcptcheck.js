/**
 * Mailbox-existence probe via SMTP RCPT TO.
 *
 * The AUTH stage can't tell you whether a login account exists — servers return
 * a generic 535 by design. The reliable existence signal is the RCPT TO verdict
 * against the domain's mail server: connect, EHLO, MAIL FROM a neutral prober,
 * then RCPT TO the address and read the code. A 2xx means the mailbox is
 * accepted; a hard 5xx "user unknown" means it isn't; anything else (accept-all
 * servers, greylisting, policy rejections) is inconclusive.
 *
 * This sends no credentials and delivers no message — it QUITs before DATA.
 * The response classification is pure (unit-tested); the socket is injected so
 * the dialogue is testable.
 *
 * @typedef {{exists:(boolean|null), code:(number|null), reason:string, host?:string}} RcptResult
 */
import net from 'node:net';

/**
 * Classify an RCPT TO reply into an existence verdict. Pure.
 * @param {number} code SMTP reply code
 * @param {string} [text] the reply text (for disambiguating 5xx)
 * @returns {{exists:(boolean|null), reason:string}}
 */
export function classifyRcptResponse(code, text = '') {
  const t = String(text).toLowerCase();
  if (code === 250 || code === 251) return { exists: true, reason: `accepted (${code})` };
  if (code === 252) return { exists: null, reason: 'server will not verify (252)' };

  if (code === 550 || code === 551 || code === 553 || code === 554) {
    // A 5xx can also mean relay/policy refusal, which says nothing about the
    // mailbox — only treat it as "not found" when it isn't that.
    if (/relay|relaying denied|not permitted|policy|spam|blocked|blacklist|access denied|authentication required/.test(t)) {
      return { exists: null, reason: `rejected, inconclusive (${code})` };
    }
    if (/user unknown|no such user|mailbox unavailable|does not exist|invalid recipient|recipient (?:rejected|not found|unknown)|unknown user|no mailbox|user not found|recipient address rejected|account.*disabled/.test(t)) {
      return { exists: false, reason: `recipient rejected (${code})` };
    }
    // A bare 550 on RCPT, with no relay/policy hint, is overwhelmingly an
    // unknown recipient; other 55x without a hint stay inconclusive.
    if (code === 550) return { exists: false, reason: 'recipient rejected (550)' };
    return { exists: null, reason: `rejected, inconclusive (${code})` };
  }

  if (code >= 400 && code < 500) return { exists: null, reason: `temporary failure (${code})` };
  return { exists: null, reason: `inconclusive (${code})` };
}

/**
 * Combine a baseline probe (a definitely-nonexistent address) with the target's
 * reply. If the server accepts the bogus baseline it is a catch-all and tells
 * us nothing about the target (exists:null). Only once the baseline is rejected
 * can the target's reply be trusted. Pure.
 * @param {{code:number,text?:string}} baseline
 * @param {{code:number,text?:string}} target
 * @returns {{exists:(boolean|null), reason:string}}
 */
export function classifyWithBaseline(baseline, target) {
  if (baseline.code === 250 || baseline.code === 251) {
    return { exists: null, reason: 'catch-all server (accepts unknown recipients)' };
  }
  // Baseline wasn't a clean rejection (temp error, policy, etc.) — can't trust
  // the comparison, so fall back to reading the target reply on its own.
  if (!(baseline.code >= 500 && baseline.code < 600)) {
    return classifyRcptResponse(target.code, target.text);
  }
  return classifyRcptResponse(target.code, target.text);
}

/** Read one complete SMTP reply (handles multiline "NNN-" continuations). */
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/).filter((l) => l.length);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: lines.join(' ') });
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

const sendLine = (socket, line) => socket.write(line + '\r\n');

/**
 * Probe whether `address` is an accepted recipient on `host`.
 *
 * @param {string} address recipient to test (e.g. the credential's user)
 * @param {{host:string, port?:number, timeout?:number, ehloName?:string, prober?:string, connect?:Function}} opts
 *   `connect({host,port,timeout})` is injected for testing; defaults to net.connect.
 * @returns {Promise<RcptResult>}
 */
export async function verifyRecipient(address, opts = {}) {
  const { host, port = 25, timeout = 10000, ehloName = 'probe.local', connect } = opts;
  const prober = opts.prober || `postmaster@${ehloName}`;
  if (!host) return { exists: null, code: null, reason: 'no host to probe' };

  const open = connect || ((o) => net.connect({ host: o.host, port: o.port, timeout: o.timeout }));
  let socket;
  try {
    socket = open({ host, port, timeout });
    // Swallow late socket errors (e.g. ECONNRESET when we destroy after QUIT)
    // so they never surface as an unhandled 'error' event.
    socket.on('error', () => {});
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('connect timeout')));
    });

    await readReply(socket, timeout); // 220 greeting
    sendLine(socket, `EHLO ${ehloName}`);
    await readReply(socket, timeout);
    sendLine(socket, `MAIL FROM:<${prober}>`);
    await readReply(socket, timeout);

    // Baseline: a definitely-nonexistent recipient on the same domain. If the
    // server accepts it, it's a catch-all and the target reply is meaningless.
    const domain = String(address).split('@')[1] || ehloName;
    const bogus = `no-such-user-smtptester-probe@${domain}`;
    sendLine(socket, `RCPT TO:<${bogus}>`);
    const baseline = await readReply(socket, timeout);

    sendLine(socket, `RCPT TO:<${address}>`);
    const target = await readReply(socket, timeout);
    sendLine(socket, 'QUIT');
    await readReply(socket, timeout).catch(() => {}); // consume 221; ignore if absent

    const verdict = classifyWithBaseline(baseline, target);
    return { ...verdict, code: target.code, baselineCode: baseline.code, host };
  } catch (err) {
    return { exists: null, code: null, reason: err.message, host };
  } finally {
    // Graceful close so the server doesn't see a reset; destroy as a backstop.
    try {
      socket?.end();
    } catch {
      /* ignore */
    }
    socket?.destroy();
  }
}
