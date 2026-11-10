/**
 * An https.Agent that tunnels HTTPS requests through a SOCKS proxy, so the
 * control-panel login checks (cPanel/WHM/Webmail/Plesk/…) can route through the
 * rotating proxy pool like SMTP does — hiding the operator's IP and spreading
 * requests across many egress addresses.
 *
 * Each connection opens a SOCKS tunnel to the destination, then completes the
 * TLS handshake over it. Certificate verification is off (panels frequently use
 * self-signed certs). Returns null for a missing/invalid proxy URL so callers
 * fall back to a direct connection.
 */
import { Agent } from 'node:https';
import tls from 'node:tls';
import { SocksClient } from 'socks';

/**
 * @param {string} proxyUrl socks5://[user:pass@]host:port (or socks4://)
 * @returns {import('node:https').Agent|null}
 */
export function socksHttpsAgent(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return null;
  let u;
  try { u = new URL(proxyUrl); } catch { return null; }
  if (!/^socks[45]?:$/i.test(u.protocol) || !u.hostname) return null;

  const proxy = {
    host: u.hostname,
    port: Number(u.port) || 1080,
    type: u.protocol.toLowerCase().startsWith('socks4') ? 4 : 5,
    userId: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };

  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (options, callback) => {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;
    SocksClient.createConnection({
      proxy,
      command: 'connect',
      destination: { host, port },
      timeout: options.timeout || 8000,
    }).then(({ socket }) => {
      const tlsSocket = tls.connect(
        { socket, servername: host, rejectUnauthorized: false },
        () => callback(null, tlsSocket),
      );
      tlsSocket.once('error', (err) => {
        // Tear down both the TLS wrapper and the underlying SOCKS tunnel so a
        // failed handshake (common with dead/half-open free proxies) can't leak
        // an open socket/FD — at the per-credential panel scale that exhausts FDs.
        try { tlsSocket.destroy(); } catch { /* already gone */ }
        try { socket.destroy(); } catch { /* already gone */ }
        callback(err);
      });
    }).catch((err) => callback(err));
  };
  return agent;
}
