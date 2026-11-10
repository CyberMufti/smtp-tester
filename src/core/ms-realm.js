/**
 * Microsoft 365 realm probe — sub-classifies an M365 domain by how it
 * authenticates, using Microsoft's public, unauthenticated endpoints:
 *   - getuserrealm.srf  → NameSpaceType (Managed vs Federated), AuthURL, brand
 *   - GetCredentialType → DesktopSsoEnabled (Seamless SSO)
 *
 * No credentials are sent; only the domain/username namespace is queried. The
 * fetch is injectable so the parsing/classification is testable offline.
 *
 * @typedef {{ nameSpaceType:string, authUrlHost:string|null, federationBrand:string|null, desktopSso:boolean }} Realm
 */

function tagText(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml || '');
  return m ? m[1].trim() : null;
}

function hostOf(url) {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase(); } catch { /* fall through */ }
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Query Microsoft for a login's realm. Never throws — a failed probe returns an
 * "Unknown" realm so the caller just keeps the base "Microsoft 365" label.
 * @param {string} login  full email address
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<Realm>}
 */
export async function probeRealm(login, opts = {}) {
  const fetchFn = opts.fetchFn || ((u, o) => fetch(u, o));
  const timeoutMs = opts.timeoutMs || 8000;
  const out = { nameSpaceType: 'Unknown', authUrl: null, authUrlHost: null, federationBrand: null, desktopSso: false, ifExists: 'unknown' };
  const signal = (() => { try { return AbortSignal.timeout(timeoutMs); } catch { return undefined; } })();
  try {
    const realmUrl = `https://login.microsoftonline.com/getuserrealm.srf?login=${encodeURIComponent(login)}&xml=1`;
    const res = await fetchFn(realmUrl, { signal });
    if (res?.ok) {
      const xml = await res.text();
      out.nameSpaceType = tagText(xml, 'NameSpaceType') || 'Unknown';
      out.federationBrand = tagText(xml, 'FederationBrandName');
      out.authUrl = tagText(xml, 'AuthURL');
      out.authUrlHost = hostOf(out.authUrl);
    }
  } catch { /* keep Unknown */ }
  try {
    const res = await fetchFn('https://login.microsoftonline.com/common/GetCredentialType', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Username: login }), signal,
    });
    if (res?.ok) {
      const j = await res.json();
      out.desktopSso = !!j?.EstsProperties?.DesktopSsoEnabled;
      // IfExistsResult: 0 = mailbox exists, 1 = does not exist; other codes
      // (redirect/throttle) are inconclusive. A throttled response is unreliable.
      if (j?.ThrottleStatus && j.ThrottleStatus !== 0) out.ifExists = 'unknown';
      else if (j?.IfExistsResult === 0) out.ifExists = 'yes';
      else if (j?.IfExistsResult === 1) out.ifExists = 'no';
      else out.ifExists = 'unknown';
    }
  } catch { /* keep desktopSso false */ }
  return out;
}

/**
 * Map realm data to an M365 auth-type sub-label, or null when it can't be told.
 * Federated realms are named by their identity provider (GoDaddy, ADFS, Okta…);
 * Managed realms are DesktopSSO (Seamless SSO) or plain "Native Office" (which
 * is also the OWA-capable case — every Managed tenant exposes OWA).
 * @param {Realm} realm
 * @returns {string|null}
 */
export function classifyM365Realm(realm) {
  const ns = realm?.nameSpaceType;
  if (ns === 'Federated') {
    // Match against the full AuthURL (the IdP signal is often in the path, e.g.
    // ".../adfs/ls"), falling back to just the host.
    const h = realm.authUrl || realm.authUrlHost || '';
    if (/godaddy|secureserver/i.test(h)) return 'GoDaddy';
    if (/\bokta\b/i.test(h)) return 'Federated (Okta)';
    if (/adfs|\bsts\b|\bfs\./i.test(h)) return 'Federated (ADFS)';
    if (/ping(id|federate|one)/i.test(h)) return 'Federated (PingFederate)';
    if (/onelogin/i.test(h)) return 'Federated (OneLogin)';
    return 'Federated';
  }
  if (ns === 'Managed') {
    return realm.desktopSso ? 'DesktopSSO' : 'Native Office';
  }
  return null;
}
