import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socksHttpsAgent } from '../src/core/socks-agent.js';

test('returns null for empty or unparseable proxy URLs', () => {
  assert.equal(socksHttpsAgent(''), null);
  assert.equal(socksHttpsAgent(null), null);
  assert.equal(socksHttpsAgent('not a url'), null);
});

test('builds an https.Agent with a SOCKS-tunneling createConnection', () => {
  const agent = socksHttpsAgent('socks5://1.2.3.4:1080');
  assert.ok(agent, 'agent created');
  assert.equal(typeof agent.createConnection, 'function');
});

test('accepts authenticated socks4/socks5 URLs without throwing', () => {
  assert.ok(socksHttpsAgent('socks5://user:pass@1.2.3.4:1080'));
  assert.ok(socksHttpsAgent('socks4://1.2.3.4:1080'));
});
