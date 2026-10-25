import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFolders } from '../src/core/imap.js';

test('detects Gmail-style spam folder', () => {
  const r = resolveFolders(['INBOX', '[Gmail]/Spam', '[Gmail]/Sent Mail'], {});
  assert.equal(r.inbox, 'INBOX');
  assert.equal(r.junk, '[Gmail]/Spam');
});

test('detects plain "Junk" folder', () => {
  const r = resolveFolders(['INBOX', 'Junk', 'Sent'], {});
  assert.equal(r.junk, 'Junk');
});

test('detects Outlook-style "Junk Email" folder', () => {
  const r = resolveFolders(['INBOX', 'Junk Email', 'Drafts'], {});
  assert.equal(r.junk, 'Junk Email');
});

test('explicit junk override wins over detection', () => {
  const r = resolveFolders(['INBOX', 'Junk', 'Bulk Mail'], { junk: 'Bulk Mail' });
  assert.equal(r.junk, 'Bulk Mail');
});

test('no junk candidate yields null junk', () => {
  const r = resolveFolders(['INBOX', 'Sent', 'Drafts'], {});
  assert.equal(r.inbox, 'INBOX');
  assert.equal(r.junk, null);
});

test('inbox detection is case-insensitive', () => {
  const r = resolveFolders(['inbox', 'spam'], {});
  assert.equal(r.inbox, 'inbox');
  assert.equal(r.junk, 'spam');
});
