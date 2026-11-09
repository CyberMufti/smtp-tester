import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grabBanner } from '../src/core/banner.js';

test('combines banners from every probed port', async () => {
  const probe = async (host, port) => ({
    587: '220 balder ESMTP Exim 4.100.1',
    993: '* OK Dovecot ready.',
    465: '',
  }[port] ?? '');
  const text = await grabBanner('mail.acme.com', { probe, ports: [587, 993, 465] });
  assert.match(text, /Exim/);
  assert.match(text, /Dovecot/);
});

test('empty host and all-empty probes yield empty string, never throws', async () => {
  assert.equal(await grabBanner('', { probe: async () => 'x' }), '');
  assert.equal(await grabBanner('h', { probe: async () => '' }), '');
});

test('a probe that rejects is ignored, others still contribute', async () => {
  const probe = async (host, port) => { if (port === 587) throw new Error('refused'); return port === 993 ? 'Zimbra IMAP ready' : ''; };
  const text = await grabBanner('mail.acme.com', { probe, ports: [587, 993] });
  assert.match(text, /Zimbra/);
});
