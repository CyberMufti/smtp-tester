/**
 * SSH login check — mirrors cpanel.js/webmail.js/whm.js shape.
 *
 * Default port 22. Username is derived from the credential:
 *   - if `target.username` is provided, use it directly
 *   - else if `target.user` looks like an email, use the local part
 *     (SSH usernames are almost never full email addresses)
 *   - else use `target.user` as-is
 *
 * Supports optional SOCKS5 proxy routing via `opts.proxyUrl`, so SSH can
 * share the same proxy pool as SMTP (nodemailer) and the HTTP panels.
 *
 * Success = auth accepted (server sends a `ready` event).
 * Invalid = auth rejected (server sends a level=client-authentication error).
 * Unreachable = connect error / timeout / DNS failure.
 *
 * @typedef {{host:string, user:string, pass:string, username?:string, port?:number}} SSHTarget
 * @typedef {{reachable:boolean, valid:boolean, status:'valid'|'invalid'|'unreachable', detail?:string}} SSHResult
 */
import { Client } from 'ssh2';
import { SocksClient } from 'socks';

export const DEFAULT_SSH_PORT = 22;

export function classifySSHResult(err) {
  if (!err) {
    return { reachable: true, valid: true, status: 'valid' };
  }
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  const level = String(err.level || '').toLowerCase();

  // Auth rejection — server is reachable, credentials rejected.
  if (
    level === 'client-authentication' ||
    msg.includes('authentication') ||
    msg.includes('permission denied') ||
    msg.includes('all configured authentication methods failed')
  ) {
    return { reachable: true, valid: false, status: 'invalid', detail: err.message };
  }

  // Network-level failures — server is not reachable.
  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    msg.includes('timeout') ||
    msg.includes('connect etimedout')
  ) {
    return { reachable: false, valid: false, status: 'unreachable', detail: err.message };
  }

  // Unknown error — treat as unreachable (conservative).
  return { reachable: false, valid: false, status: 'unreachable', detail: err.message || 'unknown' };
}

function parseSocksUrl(proxyUrl) {
  const u = new URL(proxyUrl);
  const type = u.protocol.startsWith('socks4') ? 4 : 5;
  return {
    proxy: {
      host: u.hostname,
      port: Number(u.port) || 1080,
      type,
      userId: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    },
  };
}

async function createSocksSocket(proxyUrl, targetHost, targetPort, timeout) {
  const { proxy } = parseSocksUrl(proxyUrl);
  const { socket } = await SocksClient.createConnection({
    proxy,
    command: 'connect',
    destination: { host: targetHost, port: targetPort },
    timeout,
  });
  return socket;
}

function defaultConnector({ host, port, username, password, timeout, proxyUrl }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      resolve(err || null);
    };
    const timer = setTimeout(() => done(new Error('timeout')), timeout);

    conn.on('ready', () => { clearTimeout(timer); done(null); });
    conn.on('error', (err) => { clearTimeout(timer); done(err); });
    conn.on('close', () => { if (!settled) { clearTimeout(timer); done(new Error('connection closed before ready')); } });

    (async () => {
      try {
        if (proxyUrl) {
          const sock = await createSocksSocket(proxyUrl, host, port, timeout);
          conn.connect({ sock, username, password, readyTimeout: timeout });
        } else {
          conn.connect({ host, port, username, password, readyTimeout: timeout });
        }
      } catch (err) {
        clearTimeout(timer);
        done(err);
      }
    })();
  });
}

export async function verifySSH(target, opts = {}) {
  const { connect = defaultConnector, timeout = 10000, port = DEFAULT_SSH_PORT, proxyUrl } = opts;
  const host = String(target.host || '').trim();
  const user = String(target.user || '');
  const password = String(target.pass || '');

  let username;
  if (target.username) username = String(target.username);
  else if (user.includes('@')) username = user.split('@')[0];
  else username = user;

  const base = { host, user, username, port };

  if (!host) return { ...base, ...classifySSHResult(new Error('no host')) };
  if (!username) return { ...base, ...classifySSHResult(new Error('no username')) };
  if (!password) return { ...base, ...classifySSHResult(new Error('no password')) };

  let err = null;
  try {
    err = await connect({ host, port, username, password, timeout, proxyUrl });
  } catch (e) {
    err = e;
  }
  return { ...base, ...classifySSHResult(err) };
}

export async function runSSHChecks(targets, opts = {}, onResult) {
  const list = Array.from(targets || []);
  const results = new Array(list.length);
  const concurrency = Math.max(1, Number(opts.concurrency) || 5);
  let next = 0;

  async function worker() {
    while (next < list.length) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (opts.gate) await opts.gate();
      const _sshTgt = list[i];
      if (opts.lockoutRegistry && opts.lockoutRegistry.isLocked(_sshTgt.user, 'ssh')) {
        const skipped = { ..._sshTgt, reachable: false, valid: false, status: 'unreachable', detail: 'skipped: locked', lockSkipped: true };
        results[i] = skipped;
        onResult?.(skipped, i);
        continue;
      }
      // Per-target proxy rotation via opts.proxyProvider (falls back to opts.proxyUrl).
      let proxyUrlForTarget = opts.proxyUrl;
      if (opts.proxyProvider) {
        try { proxyUrlForTarget = opts.proxyProvider() ?? opts.proxyUrl; } catch { proxyUrlForTarget = opts.proxyUrl; }
      }
      const usedPoolProxy = !!proxyUrlForTarget && proxyUrlForTarget !== opts.proxyUrl;
      const attemptOpts = usedPoolProxy ? { ...opts, proxyUrl: proxyUrlForTarget } : opts;
      let result = await verifySSH(list[i], attemptOpts);
      // Dead-proxy fallback: retry once DIRECT if the pool proxy failed.
      if (usedPoolProxy && result.status === 'unreachable' && !opts.signal?.aborted) {
        const reasonText = String(result.detail || '');
        if (/timeout|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|socket|tunnel|proxy/i.test(reasonText)) {
          if (typeof opts.onProxyFailure === 'function') {
            try { opts.onProxyFailure(proxyUrlForTarget, reasonText); } catch {}
          }
          const directOpts = { ...opts, proxyUrl: null, proxyProvider: undefined };
          const retried = await verifySSH(list[i], directOpts);
          retried.proxyFallback = true;
          retried.proxyFallbackReason = 'dead proxy — retried direct';
          retried.proxyThatDied = proxyUrlForTarget;
          result = retried;
        }
      }
      results[i] = result;
      if (opts.lockoutRegistry) {
        if (result.valid) opts.lockoutRegistry.recordSuccess(_sshTgt.user, 'ssh');
        else if (result.reachable && !result.valid) {
          const _txt = String(result.detail || '');
          if (/too many|locked|blocked|rate.?limit|cphulk|captcha/i.test(_txt)) {
            opts.lockoutRegistry.markLocked(_sshTgt.user, 'ssh', _txt);
          } else {
            opts.lockoutRegistry.recordFailure(_sshTgt.user, 'ssh');
          }
        }
      }
      onResult?.(results[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
}
