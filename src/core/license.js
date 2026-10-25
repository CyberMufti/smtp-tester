import { sign as cryptoSign, verify as cryptoVerify, createPublicKey, createPrivateKey } from 'node:crypto';

/**
 * Offline, signature-based licensing.
 *
 * A license key is an Ed25519 signature (by the owner's private key) over a
 * payload binding the key to one machine's HWID (and an optional expiry). The
 * app embeds only the PUBLIC key, so it can verify a key but never mint one —
 * only the owner, holding the private key, can issue valid licenses.
 *
 * Honest limitation: this proves a key is authentic and machine-bound; it does
 * not stop someone from patching the check out of a local copy of the app.
 *
 * Token format: `SPL1.<base64url(payloadJSON)>.<base64url(signature)>`
 *
 * @typedef {{valid:boolean, exp?:(number|null), reason?:string}} VerifyResult
 */

const PREFIX = 'SPL1';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Issue a license for a machine. Owner-side (needs the private key).
 * @param {string} hwid
 * @param {string} privateKeyPem
 * @param {{expMs?:(number|null)}} [opts]
 * @returns {string} the license key to give the user
 */
export function issueLicense(hwid, privateKeyPem, { expMs = null } = {}) {
  const payload = JSON.stringify({ hwid, exp: expMs });
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), key);
  return `${PREFIX}.${b64url(payload)}.${b64url(sig)}`;
}

/**
 * Verify a license against the local HWID and the embedded public key.
 * @param {string} hwid
 * @param {string} licenseKey
 * @param {string} publicKeyPem
 * @param {number} [nowMs]
 * @returns {VerifyResult}
 */
export function verifyLicense(hwid, licenseKey, publicKeyPem, nowMs = Date.now()) {
  try {
    const parts = String(licenseKey || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
      return { valid: false, reason: 'not a valid license key' };
    }
    const payloadBuf = Buffer.from(parts[1], 'base64url');
    const sig = Buffer.from(parts[2], 'base64url');
    const ok = cryptoVerify(null, payloadBuf, createPublicKey(publicKeyPem), sig);
    if (!ok) return { valid: false, reason: 'invalid signature' };

    const payload = JSON.parse(payloadBuf.toString('utf8'));
    if (payload.hwid !== hwid) {
      return { valid: false, reason: 'license is for a different machine' };
    }
    if (payload.exp && nowMs > payload.exp) {
      return { valid: false, reason: 'license expired' };
    }
    return { valid: true, exp: payload.exp ?? null };
  } catch (err) {
    return { valid: false, reason: `could not read license: ${err.message}` };
  }
}
