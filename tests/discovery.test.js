import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoconfig, srvCandidates, discoverHosts } from '../src/core/discovery.js';

const ISPDB_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port></incomingServer>
    <outgoingServer type="smtp">
      <hostname>mail.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

test('parseAutoconfig extracts the outgoing SMTP host and port', () => {
  const out = parseAutoconfig(ISPDB_XML);
  assert.deepEqual(out, [{ host: 'mail.example.com', port: 587 }]);
});

test('parseAutoconfig returns [] when there is no outgoing server', () => {
  assert.deepEqual(parseAutoconfig('<clientConfig></clientConfig>'), []);
  assert.deepEqual(parseAutoconfig('not xml'), []);
});

test('srvCandidates maps submission SRV (587) and submissions SRV (465)', () => {
  const out = srvCandidates(
    [{ name: 'smtp.example.com', port: 587 }],
    [{ name: 'smtp.example.com', port: 465 }],
  );
  assert.deepEqual(out, [
    { host: 'smtp.example.com', port: 587 },
    { host: 'smtp.example.com', port: 465 },
  ]);
});

test('discoverHosts prefers SRV, then autoconfig; dedupes; survives source failures', async () => {
  const dns = {
    async resolveSrv(name) {
      if (name === '_submission._tcp.example.com') return [{ name: 'srv.example.com', port: 587 }];
      throw new Error('ENOTFOUND');
    },
  };
  const fetchFn = async (url) => {
    if (url.includes('autoconfig.thunderbird.net')) {
      return { ok: true, text: async () => ISPDB_XML };
    }
    throw new Error('network');
  };
  const hosts = await discoverHosts('example.com', { dns, fetchFn });
  // SRV first (authoritative), then the ISPDB autoconfig result.
  assert.equal(hosts[0].host, 'srv.example.com');
  assert.equal(hosts[0].port, 587);
  assert.ok(hosts.some((h) => h.host === 'mail.example.com' && h.port === 587));
});

test('discoverHosts returns [] (no throw) when every source fails', async () => {
  const dns = { async resolveSrv() { throw new Error('x'); } };
  const fetchFn = async () => { throw new Error('x'); };
  assert.deepEqual(await discoverHosts('nope.com', { dns, fetchFn }), []);
});
