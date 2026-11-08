/**
 * IMAP and POP3 authentication checkers.
 * Same shape as cpanel.js/webmail.js/ssh.js.
 *
 * Uses native tls sockets — no imapflow dependency, no buffering the entire
 * mailbox. Just connect, greet, AUTH, disconnect. Fast.
 */
import tls from 'node:tls';

// ============ IMAP ============

export function classifyImapReply(text) {
  const s = String(text || '');
  if (/^a1 OK/im.test(s)) return { reachable: true, valid: true, status: 'valid' };
  if (/^a1 (NO|BAD)/im.test(s)) return { reachable: true, valid: false, status: 'invalid', detail: s.slice(0, 100) };
  if (/\* BYE|too many|locked|blocked/i.test(s)) return { reachable: true, valid: false, status: 'invalid', detail: 'lockout: ' + s.slice(0, 80) };
  return { reachable: true, valid: false, status: 'unknown', detail: s.slice(0, 100) };
}

function defaultImapConnect({ host, port, user, pass, timeout }) {
  return new Promise((resolve) => {
    let socket;
    let buf = '';
    let step = 0;
    let done = false;
    const finish = (result) => {
      if (done) return; done = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ reachable: false, valid: false, status: 'unreachable', detail: 'timeout' }), timeout);

    try {
      socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    } catch (e) {
      clearTimeout(timer); return finish({ reachable: false, valid: false, status: 'unreachable', detail: e.message });
    }

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (step === 0 && /\* OK/i.test(buf)) {
        step = 1;
        // Escape quotes in user/pass
        const u = user.replace(/"/g, '\\"');
        const p = pass.replace(/"/g, '\\"');
        socket.write(`a1 LOGIN "${u}" "${p}"\r\n`);
      } else if (step === 1 && /^a1 (OK|NO|BAD)/im.test(buf)) {
        clearTimeout(timer);
        finish(classifyImapReply(buf));
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); finish({ reachable: false, valid: false, status: 'unreachable', detail: e.message }); });
    socket.on('close', () => { if (!done) { clearTimeout(timer); finish({ reachable: false, valid: false, status: 'unreachable', detail: 'closed' }); } });
  });
}

export async function verifyImap(target, opts = {}) {
  const { connect = defaultImapConnect, timeout = 5000, port = 993 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  const base = { host, user, port };
  if (!host || !user) return { ...base, reachable: false, valid: false, status: 'unreachable', detail: 'no host/user' };
  return { ...base, ...(await connect({ host, port, user, pass, timeout })) };
}

// ============ POP3 ============

export function classifyPop3Reply(text) {
  const s = String(text || '');
  if (/^\+OK/m.test(s) && !/-ERR/i.test(s)) return { reachable: true, valid: true, status: 'valid' };
  if (/-ERR/i.test(s)) return { reachable: true, valid: false, status: 'invalid', detail: s.slice(0, 100) };
  if (/too many|locked|blocked/i.test(s)) return { reachable: true, valid: false, status: 'invalid', detail: 'lockout: ' + s.slice(0, 80) };
  return { reachable: true, valid: false, status: 'unknown', detail: s.slice(0, 100) };
}

function defaultPop3Connect({ host, port, user, pass, timeout }) {
  return new Promise((resolve) => {
    let socket;
    let buf = '';
    let step = 0;
    let done = false;
    const finish = (result) => {
      if (done) return; done = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ reachable: false, valid: false, status: 'unreachable', detail: 'timeout' }), timeout);

    try {
      socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    } catch (e) {
      clearTimeout(timer); return finish({ reachable: false, valid: false, status: 'unreachable', detail: e.message });
    }

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (step === 0 && /^\+OK/i.test(buf)) { step = 1; socket.write(`USER ${user}\r\n`); }
      else if (step === 1 && /^\+OK/i.test(buf)) { step = 2; socket.write(`PASS ${pass}\r\n`); }
      else if (step === 2 && /^(\+OK|-ERR)/im.test(buf)) {
        clearTimeout(timer);
        // +OK after PASS = valid
        if (/^\+OK/m.test(buf)) finish({ reachable: true, valid: true, status: 'valid' });
        else finish({ reachable: true, valid: false, status: 'invalid', detail: buf.slice(0, 100) });
      } else if (/-ERR/i.test(buf) && step === 1) {
        // -ERR after USER (invalid username)
        clearTimeout(timer);
        finish({ reachable: true, valid: false, status: 'invalid', detail: 'user not found' });
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); finish({ reachable: false, valid: false, status: 'unreachable', detail: e.message }); });
    socket.on('close', () => { if (!done) { clearTimeout(timer); finish({ reachable: false, valid: false, status: 'unreachable', detail: 'closed' }); } });
  });
}

export async function verifyPop3(target, opts = {}) {
  const { connect = defaultPop3Connect, timeout = 5000, port = 995 } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const pass = String(target.pass || '');
  const base = { host, user, port };
  if (!host || !user) return { ...base, reachable: false, valid: false, status: 'unreachable', detail: 'no host/user' };
  return { ...base, ...(await connect({ host, port, user, pass, timeout })) };
}
