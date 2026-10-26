import nodemailer from 'nodemailer';

/**
 * SMTP connectivity + send, built on nodemailer.
 *
 * @typedef {{host:string, port:number, user:string, pass:string, from?:string}} Credential
 */

function buildTransport(cred, { connectTimeout = 10000, sendTimeout } = {}) {
  return nodemailer.createTransport({
    host: cred.host,
    port: cred.port,
    secure: cred.port === 465,
    auth: { user: cred.user, pass: cred.pass },
    connectionTimeout: connectTimeout,
    greetingTimeout: connectTimeout,
    socketTimeout: sendTimeout ?? connectTimeout,
    // These are test/relay credentials; don't fail on self-signed certs.
    tls: { rejectUnauthorized: false },
  });
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
      return { connected: true, authenticated: false, error: err.message };
    }
    return { connected: false, authenticated: false, error: err.message };
  } finally {
    transport.close();
  }
}

/**
 * Send through an IP-authorized relay with NO authentication — for a relay you
 * control (your Google Workspace / Microsoft 365 relay from an allow-listed IP).
 * @returns {Promise<{accepted:string[], response?:string, messageId?:string, error?:string}>}
 */
export async function sendViaRelay(host, port, { to, from, subject, text, html, connectTimeout = 15000 } = {}) {
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    connectionTimeout: connectTimeout,
    greetingTimeout: connectTimeout,
    socketTimeout: connectTimeout,
    tls: { rejectUnauthorized: false },
    // no `auth` — relay is authorized by sending IP, not credentials
  });
  try {
    const info = await transport.sendMail({ from, to, subject, text, html });
    return { accepted: info.accepted ?? [], response: info.response, messageId: info.messageId };
  } catch (err) {
    return { accepted: [], error: err.message, response: err.response };
  } finally {
    transport.close();
  }
}

/**
 * Send a message through the credential's SMTP server.
 * @returns {Promise<{accepted:string[], messageId?:string, error?:string}>}
 */
export async function send(cred, { to, from, subject, text, html, sendTimeout = 15000 } = {}) {
  const transport = buildTransport(cred, { connectTimeout: sendTimeout, sendTimeout });
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
