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

test('prefers the IMAP \\Junk special-use folder regardless of its name', () => {
  const r = resolveFolders([
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Pourriels', specialUse: '\\Junk' },
    { path: 'Sent', specialUse: '\\Sent' },
  ], {});
  assert.equal(r.inbox, 'INBOX');
  assert.equal(r.junk, 'Pourriels');
});

test('\\Junk special-use wins even when a name-matched folder also exists', () => {
  const r = resolveFolders([
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Spam', specialUse: null },
    { path: 'Bloqueados', specialUse: '\\Junk' },
  ], {});
  assert.equal(r.junk, 'Bloqueados');
});

test('detects localized junk folder names by pattern (no special-use)', () => {
  assert.equal(resolveFolders(['INBOX', 'Correo no deseado'], {}).junk, 'Correo no deseado');
  assert.equal(resolveFolders(['INBOX', 'Posta indesiderata'], {}).junk, 'Posta indesiderata');
  assert.equal(resolveFolders(['INBOX', 'Unerwünscht'], {}).junk, 'Unerwünscht');
  assert.equal(resolveFolders(['INBOX', '迷惑メール'], {}).junk, '迷惑メール');
  assert.equal(resolveFolders(['INBOX', '垃圾邮件'], {}).junk, '垃圾邮件');
});

test('still works with plain string arrays (backward compatible)', () => {
  const r = resolveFolders(['INBOX', 'Junk', 'Sent'], {});
  assert.equal(r.inbox, 'INBOX');
  assert.equal(r.junk, 'Junk');
});
