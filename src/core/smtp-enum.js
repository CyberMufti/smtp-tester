/**
 * SMTP User Enumeration.
 * Determines if an email address exists on the target server without needing the password.
 * Uses RCPT TO and VRFY commands.
 */
import net from 'node:net';
import tls from 'node:tls';

class SmtpSocket {
  constructor(socket, timeout) {
    this.socket = socket;
    this.buf = '';
    this.waiters = [];
    this.closed = false;
    this.timeout = timeout;
    socket.on('data', (chunk) => { this.buf += chunk.toString('utf8'); this.drain(); });
    socket.on('error', () => { this.closed = true; this.failAll(); });
    socket.on('close', () => { this.closed = true; this.failAll(); });
  }
  failAll() { for (const w of this.waiters) w.reject(new Error('closed')); this.waiters = []; }
  drain() {
    while (this.waiters.length) {
      const m = this.parse();
      if (!m) return;
      this.buf = this.buf.slice(m.consumed);
      this.waiters.shift().resolve({ code: m.code, text: m.text });
    }
  }
  parse() {
    const parts = this.buf.split('\r\n');
    let finalIdx = -1; let code = null; const texts = [];
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(/^(\d{3})([ -])(.*)$/);
      if (!m) continue;
      texts.push(m[3]);
      if (m[2] === ' ') { finalIdx = i; code = Number(m[1]); break; }
    }
    if (finalIdx === -1) return null;
    const consumed = parts.slice(0, finalIdx + 1).join('\r\n').length + 2;
    return { consumed, code, text: texts.join(' ').trim() };
  }
  read() {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('closed'));
      const timer = setTimeout(() => reject(new Error('timeout')), this.timeout);
      this.waiters.push({
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.drain();
    });
  }
  async cmd(line) {
    if (this.closed) throw new Error('closed');
    this.socket.write(line + '\r\n');
    return this.read();
  }
  close() { if (!this.closed) { this.closed = true; try { this.socket.destroy(); } catch {} } }
}

function connect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const s = port === 465 ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }) : net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeout);
    const event = port === 465 ? 'secureConnect' : 'connect';
    s.once(event, () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export async function enumerateUser(target, opts = {}) {
  const { host, port = 25, timeout = 5000 } = opts;
  const user = String(target.user || '').trim();
  if (!host || !user) return { exists: 'unknown', detail: 'no host/user' };

  let socket = null; let session = null;
  try {
    socket = await connect(host, port, timeout);
    session = new SmtpSocket(socket, timeout);
    
    await session.read(); // Greeting
    let ehlo = await session.cmd('EHLO probe.local');
    if (ehlo.code !== 250) {
      const helo = await session.cmd('HELO probe.local');
      if (helo.code !== 250) throw new Error('HELO failed');
    }

    // 1. Try RCPT TO (MAIL FROM first)
    const mf = await session.cmd('MAIL FROM:<postmaster@' + host + '>');
    if (mf.code === 250) {
      const rcpt = await session.cmd('RCPT TO:<' + user + '>');
      if (rcpt.code === 250 || rcpt.code === 251) {
        session.close(); return { exists: true, method: 'rcpt', detail: rcpt.text };
      }
      if (rcpt.code === 550 || rcpt.code === 551) {
        session.close(); return { exists: false, method: 'rcpt', detail: rcpt.text };
      }
    }

    // 2. Try VRFY (often disabled, but worth trying)
    const vrfy = await session.cmd('VRFY ' + user);
    session.close();
    
    if (vrfy.code === 250 || vrfy.code === 251) return { exists: true, method: 'vrfy', detail: vrfy.text };
    if (vrfy.code === 550 || vrfy.code === 551) return { exists: false, method: 'vrfy', detail: vrfy.text };

    return { exists: 'unknown', detail: 'Server rejected RCPT and VRFY' };

  } catch (err) {
    if (session) session.close(); else if (socket) socket.destroy();
    return { exists: 'unknown', detail: err.message };
  }
}
