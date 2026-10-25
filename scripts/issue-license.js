#!/usr/bin/env node
/**
 * Owner-only license issuer.
 *
 * Usage:
 *   node scripts/issue-license.js <HWID> [--days N]
 *
 * Reads your private key from owner-keys/private.pem (never commit it), signs a
 * license bound to the given HWID, and prints the license key to send back to
 * the user on Telegram. With --days it expires after N days; without, it never
 * expires.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { issueLicense } from '../src/core/license.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const hwid = args.find((a) => !a.startsWith('--'));
const daysArg = args.indexOf('--days');
const days = daysArg !== -1 ? Number(args[daysArg + 1]) : null;

if (!hwid) {
  console.error('Usage: node scripts/issue-license.js <HWID> [--days N]');
  process.exit(1);
}

let priv;
try {
  priv = readFileSync(join(__dirname, '..', 'owner-keys', 'private.pem'), 'utf8');
} catch {
  console.error('Could not read owner-keys/private.pem — keep your private key there.');
  process.exit(1);
}

const expMs = days ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
const key = issueLicense(hwid.trim().toUpperCase(), priv, { expMs });

console.log(`\nHWID:    ${hwid.trim().toUpperCase()}`);
console.log(`Expires: ${expMs ? new Date(expMs).toISOString() : 'never'}`);
console.log(`\nLicense key (send this to the user):\n\n${key}\n`);
