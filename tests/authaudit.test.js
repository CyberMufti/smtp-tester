import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEhlo, analyzeAudit } from '../src/core/authaudit.js';

test('parseEhlo extracts AUTH mechanisms and STARTTLS from a multiline reply', () => {
  const reply = ['250-mail.example.com', '250-SIZE 52428800', '250-STARTTLS', '250 AUTH LOGIN PLAIN XOAUTH2'];
  const { mechs, starttls, caps } = parseEhlo(reply);
  assert.deepEqual(mechs, ['LOGIN', 'PLAIN', 'XOAUTH2']);
  assert.equal(starttls, true);
  assert.ok(caps.includes('SIZE 52428800'));
});

test('parseEhlo handles raw text and the AUTH= form', () => {
  const { mechs, starttls } = parseEhlo('250-STARTTLS\r\n250 AUTH=LOGIN PLAIN');
  assert.deepEqual(mechs, ['LOGIN', 'PLAIN']);
  assert.equal(starttls, true);
});

test('parseEhlo with no AUTH line yields empty mechs', () => {
  const { mechs, starttls } = parseEhlo(['250-mail', '250 STARTTLS']);
  assert.deepEqual(mechs, []);
  assert.equal(starttls, true);
});

test('flags cleartext AUTH offered before STARTTLS as high severity', () => {
  const report = analyzeAudit({
    host: 'mail.example.com',
    port: 587,
    implicitTls: false,
    plain: { mechs: ['LOGIN', 'PLAIN'], starttls: true, caps: [] },
    secure: { mechs: ['LOGIN', 'PLAIN'], starttls: false, caps: [] },
  });
  const f = report.findings.find((x) => x.id === 'cleartext-auth');
  assert.ok(f, 'cleartext-auth finding expected');
  assert.equal(f.severity, 'high');
});

test('flags missing STARTTLS on a submission port', () => {
  const report = analyzeAudit({
    host: 'mail.example.com',
    port: 587,
    implicitTls: false,
    plain: { mechs: [], starttls: false, caps: [] },
    secure: null,
  });
  assert.ok(report.findings.some((x) => x.id === 'no-starttls' && x.severity === 'high'));
});

test('a correctly configured server (no cleartext AUTH, STARTTLS present) has no high findings', () => {
  const report = analyzeAudit({
    host: 'mail.example.com',
    port: 587,
    implicitTls: false,
    plain: { mechs: [], starttls: true, caps: [] }, // AUTH only appears after STARTTLS
    secure: { mechs: ['LOGIN', 'PLAIN'], starttls: false, caps: [] },
  });
  assert.equal(report.findings.filter((x) => x.severity === 'high').length, 0);
  assert.ok(report.okReasons.some((r) => /STARTTLS/.test(r)));
  // Basic auth over TLS is reported as informational only.
  assert.ok(report.findings.some((x) => x.id === 'basic-auth-enabled' && x.severity === 'info'));
});

test('implicit-TLS port (465) has no cleartext channel and no high findings', () => {
  const report = analyzeAudit({
    host: 'mail.example.com',
    port: 465,
    implicitTls: true,
    plain: null,
    secure: { mechs: ['LOGIN', 'PLAIN'], starttls: false, caps: [] },
  });
  assert.equal(report.findings.filter((x) => x.severity === 'high').length, 0);
  assert.ok(report.okReasons.some((r) => /Implicit TLS/.test(r)));
  assert.deepEqual(report.mechs, ['LOGIN', 'PLAIN']);
});
