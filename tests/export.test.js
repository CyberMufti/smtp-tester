import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWorkingTxt, toConfirmedTxt, csvRowLine } from '../src/core/export.js';

test('csvRowLine neutralizes spreadsheet formula injection in a cell', () => {
  const row = csvRowLine({
    cred: { host: 'h', port: 587, user: 'u@x.com' },
    status: 'dead',
    reason: '=HYPERLINK("http://evil","x")',
    latencyMs: 1,
  });
  // The dangerous reason must be prefixed with ' so it can't execute as a formula.
  assert.ok(row.includes("'=HYPERLINK"), `expected neutralized formula, got: ${row}`);
  assert.ok(!/(^|,)=HYPERLINK/.test(row), 'a raw =formula cell must not survive');
});

test('csvRowLine does not mangle an ordinary negative number', () => {
  const row = csvRowLine({ cred: { host: 'h', port: 587, user: 'u@x.com' }, status: 'dead', reason: '-5', latencyMs: 1 });
  assert.ok(row.includes(',-5,'), `negative number should stay literal, got: ${row}`);
});
import { parse } from '../src/core/parser.js';

function result(status, cred, usedHost, usedPort) {
  return { status, cred, usedHost, usedPort };
}

const SAMPLE = [
  result('inbox', { host: 'smtp.gmail.com', port: 587, user: 'a@gmail.com', pass: 'p1' }, 'smtp.gmail.com', 587),
  result('spam', { host: 'smtp.x.com', port: 587, user: 'b@x.com', pass: 'p2' }, 'smtp.x.com', 587),
  result('valid', { host: 'smtp.y.com', port: 465, user: 'c@y.com', pass: 'p3' }, 'smtp.y.com', 465),
  result('dead', { host: 'dead.com', port: 587, user: 'd@dead.com', pass: 'p4' }, null, null),
  // host-less credential whose endpoint was detected
  result('valid', { host: null, port: null, user: 'e@gmail.com', pass: 'p5' }, 'smtp.gmail.com', 587),
];

test('excludes dead results and groups the rest by status', () => {
  const txt = toWorkingTxt(SAMPLE, { generatedAt: '2026-10-25' });
  assert.ok(!txt.includes('dead.com'), 'dead credential must not be written');
  assert.ok(/# === INBOX \(1\) ===/.test(txt));
  assert.ok(/# === SPAM \(1\) ===/.test(txt));
  assert.ok(/# === VALID \/ SENT \(2\) ===/.test(txt));
});

test('toConfirmedTxt writes ONLY inbox+spam credentials as host:port:user:pass', () => {
  const txt = toConfirmedTxt(SAMPLE, {});
  // Confirmed-delivered only: inbox + spam.
  assert.ok(txt.includes('smtp.gmail.com:587:a@gmail.com:p1'), 'inbox credential present');
  assert.ok(txt.includes('smtp.x.com:587:b@x.com:p2'), 'spam credential present');
  // Accepted-but-unconfirmed and dead must NOT appear.
  assert.ok(!txt.includes('c@y.com'), 'valid (accepted, unconfirmed) must be excluded');
  assert.ok(!txt.includes('e@gmail.com'), 'valid host-less must be excluded');
  assert.ok(!txt.includes('dead.com'), 'dead must be excluded');
});

test('toConfirmedTxt output is re-importable: exactly the 2 confirmed creds', () => {
  const { records, errors } = parse(toConfirmedTxt(SAMPLE, {}));
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.user).sort(), ['a@gmail.com', 'b@x.com']);
});

test('toConfirmedTxt is empty of credentials when nothing was confirmed', () => {
  const noneConfirmed = [
    result('valid', { host: 'smtp.y.com', port: 465, user: 'c@y.com', pass: 'p3' }, 'smtp.y.com', 465),
    result('dead', { host: 'dead.com', port: 587, user: 'd@dead.com', pass: 'p4' }, null, null),
  ];
  const { records } = parse(toConfirmedTxt(noneConfirmed, {}));
  assert.equal(records.length, 0);
});

test('writes the detected working host:port for a host-less credential', () => {
  const txt = toWorkingTxt(SAMPLE, {});
  assert.ok(txt.includes('smtp.gmail.com:587:e@gmail.com:p5'));
});

test('output is re-importable by the parser (comments ignored, 4 working creds)', () => {
  const txt = toWorkingTxt(SAMPLE, {});
  const { records, errors } = parse(txt);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.host && r.port && r.user && r.pass));
});

test('round-trips a password whose last colon-segment looks like an email', () => {
  const results = [
    result('valid', { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'x:admin@foo.com' }, 'smtp.x.com', 587),
  ];
  const txt = toWorkingTxt(results, {});
  const { records, errors } = parse(txt);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].pass, 'x:admin@foo.com');
  assert.equal(records[0].user, 'u@x.com');
  assert.equal(records[0].from, undefined);
});

test('round-trips a password containing a comma', () => {
  const results = [
    result('valid', { host: 'smtp.x.com', port: 587, user: 'u@x.com', pass: 'a,b:c' }, 'smtp.x.com', 587),
  ];
  const { records } = parse(toWorkingTxt(results, {}));
  assert.equal(records[0].pass, 'a,b:c');
});

test('empty when there are no working results', () => {
  const txt = toWorkingTxt([result('dead', { host: 'x', port: 1, user: 'u', pass: 'p' }, null, null)], {});
  const { records } = parse(txt);
  assert.equal(records.length, 0);
});

test('hostGroupKey maps hosts to their registrable domain', async () => {
  const { hostGroupKey } = await import('../src/core/export.js');
  assert.equal(hostGroupKey('smtp.gmail.com'), 'gmail.com');
  assert.equal(hostGroupKey('smtp.mail.yahoo.com'), 'yahoo.com');
  assert.equal(hostGroupKey('smtp.office365.com'), 'office365.com');
  assert.equal(hostGroupKey('mail.acme.co.uk'), 'acme.co.uk');
  assert.equal(hostGroupKey('203.0.113.4'), '203.0.113.4'); // IP groups under itself
  assert.equal(hostGroupKey(''), 'unknown');
  assert.equal(hostGroupKey(null), 'unknown');
});

test('hostGroupedExportFiles groups working SMTPs by host and separates unverified', async () => {
  const { hostGroupedExportFiles } = await import('../src/core/export.js');
  const rows = [
    result('valid', { host: null, port: null, user: 'a@gmail.com', pass: 'p1' }, 'smtp.gmail.com', 587),
    result('inbox', { host: null, port: null, user: 'b@gmail.com', pass: 'p2' }, 'smtp.gmail.com', 587),
    result('valid', { host: 'smtp.mail.yahoo.com', port: 465, user: 'c@yahoo.com', pass: 'p3' }, 'smtp.mail.yahoo.com', 465),
    result('unverified', { host: 'smtp.gmail.com', port: 587, user: 'd@gmail.com', pass: 'p4' }, 'smtp.gmail.com', 587),
    result('valid', { host: null, port: null, user: 'e', pass: 'p5' }, null, null), // no host -> unknown
    result('dead', { host: 'x.com', port: 587, user: 'f@x.com', pass: 'p6' }, null, null),
  ];
  const files = hostGroupedExportFiles(rows);
  assert.deepEqual(files['valid/gmail.com.txt'], ['smtp.gmail.com:587:a@gmail.com:p1', 'smtp.gmail.com:587:b@gmail.com:p2']);
  assert.deepEqual(files['valid/yahoo.com.txt'], ['smtp.mail.yahoo.com:465:c@yahoo.com:p3']);
  assert.deepEqual(files['unverified/gmail.com.txt'], ['smtp.gmail.com:587:d@gmail.com:p4']);
  assert.ok(files['valid/unknown.txt']); // host-less working cred
  // unverified never lands in a valid-by-host file
  assert.ok(!files['valid/gmail.com.txt'].some((l) => l.includes('d@gmail.com')));
  // dead excluded entirely
  assert.ok(!Object.values(files).some((arr) => arr.some((l) => l.includes('f@x.com'))));
});

test('resultFolderFiles splits into SMTP result (by status/host) and Leads (alive only, by provider/country)', async () => {
  const { resultFolderFiles } = await import('../src/core/export.js');
  // domainCountry = the lead's ccTLD country (what drives the Leads sort);
  // `country` = server GeoIP (NOT used for folders, shown as info only).
  const geo = (status, cred, host, provider, domainCountry, extra = {}) => ({ status, cred, usedHost: host, usedPort: cred.port, provider, country: 'US', domainCountry, ...extra });
  const rows = [
    geo('inbox', { host: 'smtp.gmail.com', port: 587, user: 'a@acme.co.uk', pass: 'p1' }, 'smtp.gmail.com', 'Google Workspace', 'United Kingdom'),
    geo('spam', { host: 'smtp.mail.yahoo.com', port: 465, user: 'b@firma.de', pass: 'p2' }, 'smtp.mail.yahoo.com', 'Yahoo/AOL', 'Germany'),
    geo('valid', { host: 'smtp.ionos.com', port: 587, user: 'c@shop.com', pass: 'p3' }, 'smtp.ionos.com', 'IONOS', 'Unknown'),
    geo('unverified', { host: 'smtp.gmail.com', port: 587, user: 'e@firm.co.uk', pass: 'p5' }, 'smtp.gmail.com', 'Google Workspace', 'United Kingdom'),
    // dead but the account EXISTS (wrong password) -> alive lead, included in Leads
    geo('dead', { host: 'smtp.mail.yahoo.com', port: 587, user: 'g@societe.fr', pass: 'p7' }, 'smtp.mail.yahoo.com', 'Yahoo/AOL', 'France', { userExists: true }),
    // dead, account NOT found -> not alive, excluded from Leads
    geo('dead', { host: 'smtp.mail.yahoo.com', port: 587, user: 'h@societe.fr', pass: 'p8' }, 'smtp.mail.yahoo.com', 'Yahoo/AOL', 'France', { userExists: false }),
    // dead on connect (no existence signal) -> excluded from Leads
    geo('dead', { host: 'mail.gone.com', port: 587, user: 'i@gone.com', pass: 'p9' }, 'mail.gone.com', 'Other', 'Unknown'),
  ];
  const files = resultFolderFiles(rows);

  // SMTP result/: working SMTPs by delivery status, grouped by host. Dead excluded.
  assert.deepEqual(files['SMTP result/inbox/gmail.com.txt'], ['smtp.gmail.com:587:a@acme.co.uk:p1']);
  assert.deepEqual(files['SMTP result/spam/yahoo.com.txt'], ['smtp.mail.yahoo.com:465:b@firma.de:p2']);
  assert.deepEqual(files['SMTP result/unconfirmed/ionos.com.txt'], ['smtp.ionos.com:587:c@shop.com:p3']);
  const smtpLines = Object.entries(files).filter(([k]) => k.startsWith('SMTP result/')).flatMap(([, v]) => v);
  assert.ok(!smtpLines.some((l) => /g@societe|h@societe|i@gone/.test(l)), 'no dead creds under SMTP result');

  // Leads/: ALIVE leads only, EMAIL ONLY (an address list), sorted by DOMAIN
  // country (ccTLD), not server GeoIP.
  assert.deepEqual(files['Leads/hosts/Google_Workspace/Google_Workspace_United_Kingdom.txt'], ['a@acme.co.uk', 'e@firm.co.uk']);
  assert.deepEqual(files['Leads/hosts/Yahoo_AOL/Yahoo_AOL_France.txt'], ['g@societe.fr']); // dead-but-account-exists kept
  assert.deepEqual(files['Leads/countries/Germany/Yahoo_AOL.txt'], ['b@firma.de']);
  assert.deepEqual(files['Leads/countries/Unknown/IONOS.txt'], ['c@shop.com']); // generic .com -> Unknown country
  // account-not-found and connect-failure dead leads are excluded entirely.
  assert.ok(!Object.values(files).some((arr) => arr.some((l) => l.includes('h@societe.fr') || l.includes('i@gone.com'))));
});

test('verifiedFolderFiles groups VALID verified addresses by provider_country', async () => {
  const { verifiedFolderFiles } = await import('../src/core/export.js');
  const rows = [
    { email: 'a@yahoo.com', status: 'valid', provider: 'Yahoo/AOL', country: 'United States' },
    { email: 'b@yahoo.com', status: 'valid', provider: 'Yahoo/AOL', country: 'United States' },
    { email: 'c@acme.de', status: 'valid', provider: 'Microsoft 365', country: 'Germany' },
    { email: 'd@acme.com', status: 'invalid', provider: 'Gmail', country: 'Unknown' },
    { email: 'e@acme.com', status: 'catch-all', provider: 'Gmail', country: 'Unknown' },
  ];
  const files = verifiedFolderFiles(rows);
  assert.deepEqual(files['Yahoo_AOL_United_States.txt'], ['a@yahoo.com', 'b@yahoo.com']);
  assert.deepEqual(files['Microsoft_365_Germany.txt'], ['c@acme.de']);
  assert.ok(!Object.values(files).some((arr) => arr.includes('d@acme.com') || arr.includes('e@acme.com')), 'only valid');
});

test('control-panel exports are host:port:user:pass using the port that logged in; leads stay email-only', async () => {
  const { resultFolderFiles, hostGroupedExportFiles } = await import('../src/core/export.js');
  const rows = [{
    status: 'valid',
    cred: { host: null, port: null, user: 'admin@site.com', pass: 's3cr3t' },
    usedHost: 'smtp.site.com',
    usedPort: 587,
    provider: 'Other',
    domainCountry: 'Unknown',
    panels: {
      cpanel: { valid: true, port: 2083, host: 'site.com', user: 'admin' },
      whm: { valid: true, port: 2087, host: 'site.com', user: 'admin' },
      webmail: { valid: true, port: 2096, host: 'site.com', user: 'admin' },
      ssh: { valid: false, port: 22 },
    },
  }];

  for (const files of [resultFolderFiles(rows), hostGroupedExportFiles(rows)]) {
    assert.deepEqual(files['panels/cpanel_valid.txt'], ['site.com:2083:admin@site.com:s3cr3t']);
    assert.deepEqual(files['panels/whm_valid.txt'], ['site.com:2087:admin@site.com:s3cr3t']);
    assert.deepEqual(files['panels/webmail_valid.txt'], ['site.com:2096:admin@site.com:s3cr3t']);
    assert.ok(!files['panels/ssh_valid.txt'], 'a non-valid panel is not exported');
  }

  // Leads remain email-only.
  const rf = resultFolderFiles(rows);
  assert.deepEqual(rf['Leads/hosts/Other/Other_Unknown.txt'], ['admin@site.com']);
});
