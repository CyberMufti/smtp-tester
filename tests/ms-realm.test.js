import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyM365Realm, probeRealm } from '../src/core/ms-realm.js';

test('classifies the M365 auth type from realm data', () => {
  assert.equal(classifyM365Realm({ nameSpaceType: 'Managed', desktopSso: true }), 'DesktopSSO');
  assert.equal(classifyM365Realm({ nameSpaceType: 'Managed', desktopSso: false }), 'Native Office');
  assert.equal(classifyM365Realm({ nameSpaceType: 'Federated', authUrlHost: 'godaddy.okta.com' }), 'GoDaddy');
  assert.equal(classifyM365Realm({ nameSpaceType: 'Federated', authUrlHost: 'login.secureserver.net' }), 'GoDaddy');
  assert.equal(classifyM365Realm({ nameSpaceType: 'Federated', authUrlHost: 'sso.sgs.net/adfs/ls' }), 'Federated (ADFS)');
  assert.equal(classifyM365Realm({ nameSpaceType: 'Federated', authUrlHost: 'acme.okta.com' }), 'Federated (Okta)');
  assert.equal(classifyM365Realm({ nameSpaceType: 'Federated', authUrlHost: 'idp.example.com' }), 'Federated');
});

test('no usable realm -> null (keeps the base Microsoft 365 label)', () => {
  assert.equal(classifyM365Realm({ nameSpaceType: 'Unknown' }), null);
  assert.equal(classifyM365Realm({}), null);
  assert.equal(classifyM365Realm(null), null);
});

test('probeRealm parses the getuserrealm XML + GetCredentialType JSON (injected fetch)', async () => {
  const fetchFn = async (url, opts) => {
    if (url.includes('getuserrealm')) {
      return { ok: true, text: async () => '<RealmInfo><NameSpaceType>Federated</NameSpaceType><AuthURL>https://sso.sgs.net/adfs/ls/?x=1</AuthURL><FederationBrandName>SGS</FederationBrandName></RealmInfo>' };
    }
    return { ok: true, json: async () => ({ EstsProperties: { DesktopSsoEnabled: false } }) };
  };
  const r = await probeRealm('test@sgs.com', { fetchFn });
  assert.equal(r.nameSpaceType, 'Federated');
  assert.equal(r.authUrlHost, 'sso.sgs.net');
  assert.equal(classifyM365Realm(r), 'Federated (ADFS)');
});

test('probeRealm never throws on a failed fetch', async () => {
  const r = await probeRealm('test@x.com', { fetchFn: async () => { throw new Error('net'); } });
  assert.equal(r.nameSpaceType, 'Unknown');
});
