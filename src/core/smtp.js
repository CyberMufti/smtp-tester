import nodemailer from 'nodemailer';
import { SocksClient } from 'socks';

// nodemailer needs a reference to a socks module to use SOCKS proxies.
const socksModule = { SocksClient };

/**
 * Build a SOCKS proxy URL from parts, or null if no host/port.
 * @param {{host:string, port:(number|string), user?:string, pass?:string, type?:string}} p
 * @returns {string|null}
 */
export function buildProxyUrl(p) {
  if (!p || !p.host || !p.port) return null;
  const type = p.type || 'socks5';
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass || '')}@` : '';
  return `${type}://${auth}${p.host}:${p.port}`;
}

/** Attach SOCKS proxy routing to a nodemailer transport when a proxy URL is given. */
function applyProxy(transport, proxyUrl) {
  if (proxyUrl) transport.set('proxy_socks_module', socksModule);
  return transport;
}

/**
 * SMTP connectivity + send, built on nodemailer.
 *
 * A credential authenticates either with a password or with OAuth 2.0 (XOAUTH2)
 * — the latter is required for Gmail / Microsoft 365 accounts that have basic
 * SMTP AUTH disabled. OAuth can be a ready access token, or a
 * clientId/clientSecret/refreshToken set that nodemailer exchanges for one.
 *
 * @typedef {{accessToken?:string, clientId?:string, clientSecret?:string, refreshToken?:string, accessUrl?:string, expires?:number}} OAuth2
 * @typedef {{host:string, port:number, user:string, pass?:string, from?:string, oauth?:OAuth2}} Credential
 */

/**
 * Build the nodemailer `auth` object for a credential. Pure — chooses OAuth2
 * when the credential carries a usable OAuth payload (an access token, or a
 * refresh token to mint one), otherwise plain user/password.
 * @param {Credential} cred
 * @returns {object}
 */
export function buildAuth(cred) {
  const o = cred.oauth;
  if (o && (o.accessToken || o.refreshToken)) {
    const auth = { type: 'OAuth2', user: cred.user };
    for (const k of ['accessToken', 'clientId', 'clientSecret', 'refreshToken', 'accessUrl', 'expires']) {
      if (o[k] != null) auth[k] = o[k];
    }
    return auth;
  }
  return { user: cred.user, pass: cred.pass };
}

function buildTransport(cred, { connectTimeout = 10000, sendTimeout, proxy } = {}) {
  const transport = nodemailer.createTransport({
    host: cred.host,
    port: cred.port,
    secure: cred.port === 465,
    auth: buildAuth(cred),
    connectionTimeout: connectTimeout,
    greetingTimeout: connectTimeout,
    socketTimeout: sendTimeout ?? connectTimeout,
    // These are test/relay credentials; don't fail on self-signed certs.
    tls: { rejectUnauthorized: false },
    proxy: proxy || undefined, // route via SOCKS proxy so the egress IP is the proxy's
  });
  return applyProxy(transport, proxy);
}

/**
 * nodemailer sets err.code === 'EAUTH' when the connection succeeded but
 * authentication was rejected. Anything else means we never got far enough
 * to authenticate (refused, timeout, TLS/socket error, bad host).
 */
function isAuthError(err) {
  if (!err) return false;
  if (err.code === 'EAUTH') return true;
  if (typeof err.responseCode === 'number' && (err.responseCode === 535 || err.responseCode === 534)) {
    return true;
  }
  return false;
}

/**
 * Check whether a credential can connect and authenticate.
 * @returns {Promise<{connected:boolean, authenticated:boolean, error?:string}>}
 */
export async function verify(cred, opts = {}) {
  const transport = buildTransport(cred, opts);
  try {
    await transport.verify();
    return { connected: true, authenticated: true };
  } catch (err) {
    if (isAuthError(err)) {
      const msg = String(err.message || '').toLowerCase();
      const userExists = !msg.includes('550') && !msg.includes('user unknown') && !msg.includes('no such user');
      return { connected: true, authenticated: false, userExists, error: err.message };
    }
    return { connected: false, authenticated: false, error: err.message };
  } finally {
    transport.close();
  }
}

/**
 * Send a message through the credential's SMTP server.
 * @returns {Promise<{accepted:string[], messageId?:string, error?:string}>}
 */
export async function send(cred, { to, from, subject, text, html, sendTimeout = 15000, proxy } = {}) {
  const transport = buildTransport(cred, { connectTimeout: sendTimeout, sendTimeout, proxy });
  try {
    const info = await transport.sendMail({
      from: from || cred.from || cred.user,
      to,
      subject,
      text,
      html,
    });
    return { accepted: info.accepted ?? [], messageId: info.messageId };
  } catch (err) {
    return { accepted: [], error: err.message };
  } finally {
    transport.close();
  }
}
