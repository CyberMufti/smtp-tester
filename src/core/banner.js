/**
 * Read a mail server's greeting/EHLO (SMTP) and capability line (IMAP) so the
 * provider classifier can recognize self-hosted software (Zimbra, Exim/cPanel,
 * Postfix, Exchange) that domain/MX records can't reveal.
 *
 * The low-level socket probe is injectable, so the orchestration is testable
 * without the network.
 */
import net from 'node:net';
import tls from 'node:tls';

/**
 * Connect to one host:port, read the greeting, send EHLO for SMTP (to pull the
 * software/capability line), and return the text read. Never throws — returns
 * '' on any failure. Submission ports 465/993 are implicit TLS.
 */
function defaultProbe(host, port, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    let data = '';
    const secure = port === 465 || port === 993;
    let s;
    try {
      s = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
    } catch {
      return resolve('');
    }
    const finish = () => { clearTimeout(timer); try { s.destroy(); } catch { /* ignore */ } resolve(data.trim()); };
    const timer = setTimeout(finish, timeout);
    s.once(secure ? 'secureConnect' : 'connect', () => {
      // SMTP: nudge an EHLO after the greeting to surface the software line.
      if (port !== 993) setTimeout(() => { try { s.write('EHLO probe.local\r\n'); } catch { /* ignore */ } }, 250);
    });
    s.on('data', (d) => { data += d.toString(); if (data.length > 600) finish(); });
    s.once('error', () => finish());
  });
}

/**
 * Grab and concatenate banners from a host's submission/IMAP ports (probed in
 * parallel so wall-clock is bounded by one timeout). Returns the combined text,
 * or '' if nothing responded. Never throws.
 *
 * @param {string} host
 * @param {{ timeout?:number, ports?:number[], probe?:(host:string,port:number,opts:object)=>Promise<string> }} [opts]
 * @returns {Promise<string>}
 */
export async function grabBanner(host, { timeout = 5000, ports = [587, 993, 465], probe = defaultProbe } = {}) {
  if (!host) return '';
  const results = await Promise.all(ports.map((p) => Promise.resolve().then(() => probe(host, p, { timeout })).catch(() => '')));
  return results.filter(Boolean).join('\n');
}
