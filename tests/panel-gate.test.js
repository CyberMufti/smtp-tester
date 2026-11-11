import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunPanelChecks } from '../src/core/panel-gate.js';

test('runs panels for a working credential', () => {
  assert.equal(shouldRunPanelChecks({ status: 'valid' }), true);
  assert.equal(shouldRunPanelChecks({ status: 'inbox' }), true);
  assert.equal(shouldRunPanelChecks({ status: 'spam' }), true);
  assert.equal(shouldRunPanelChecks({ status: 'unknown' }), true);
});

test('runs panels for an SMTP auth failure — the case panels exist for', () => {
  // Connected to the host but SMTP login was rejected; the same user/pass may
  // still work on cPanel/webmail/SSH. Skipping this would defeat the feature.
  assert.equal(shouldRunPanelChecks({ status: 'dead', deadReason: 'auth' }), true);
});

test('runs panels when the server merely refused the message', () => {
  assert.equal(shouldRunPanelChecks({ status: 'dead', deadReason: 'send' }), true);
});

test('skips panels when the host could never be connected to', () => {
  // After all SMTP retries the host is unreachable, so HTTPS/SSH/IMAP panels
  // on it will only time out — pure wasted work at scale.
  assert.equal(shouldRunPanelChecks({ status: 'dead', deadReason: 'connect' }), false);
});

test('skips panels for a lock-skipped credential', () => {
  // We deliberately did NOT test this account to avoid locking it; firing 11
  // panel logins would hammer the very account we spared.
  assert.equal(shouldRunPanelChecks({ status: 'dead', reason: 'skipped: locked', lockSkipped: true }), false);
});

test('runs panels for a dead result with no specific reason', () => {
  // Only the known-unreachable case is skipped; anything ambiguous still runs.
  assert.equal(shouldRunPanelChecks({ status: 'dead' }), true);
});

test('does not run panels for a missing result', () => {
  assert.equal(shouldRunPanelChecks(null), false);
  assert.equal(shouldRunPanelChecks(undefined), false);
});

test('consumer / SaaS mailbox providers skip panel checks (no customer cPanel/webmail)', () => {
  for (const provider of ['Gmail', 'Yahoo/AOL', 'Outlook/Hotmail', 'iCloud', 'SendGrid', 'Mimecast', 'Cox', 'Yahoo! Japan']) {
    assert.equal(shouldRunPanelChecks({ status: 'valid', provider }), false, provider);
  }
});

test('hosting / custom-domain / self-hosted providers still run panel checks', () => {
  for (const provider of ['GoDaddy', 'Namecheap', 'HostGator', 'Other', 'Unknown', 'cPanel/Exim', 'Google Workspace', 'Microsoft 365', undefined]) {
    assert.equal(shouldRunPanelChecks({ status: 'valid', provider }), true, String(provider));
  }
});
