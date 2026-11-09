/**
 * Download the free DB-IP IP-to-Country Lite database (CC BY 4.0) into
 * resources/geoip/dbip-country-lite.mmdb, for electron-builder to bundle.
 *
 * DB-IP publishes a fresh file each month at a dated URL; we try the current
 * month and walk back a few months in case this month's file isn't up yet.
 * Best-effort: if every attempt fails (offline build, etc.), we exit 0 without
 * a database — the app then reports country as "Unknown" instead of breaking.
 *
 *   node scripts/download-geoip.mjs
 *
 * Attribution: IP Geolocation by DB-IP (https://db-ip.com).
 */
import { createWriteStream, mkdirSync, existsSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'resources', 'geoip');
const outFile = join(outDir, 'dbip-country-lite.mmdb');

function monthsBack(n) {
  // Avoid Date math pitfalls: derive YYYY-MM strings from the current UTC date.
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function tryDownload(month) {
  const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  mkdirSync(outDir, { recursive: true });
  const tmp = outFile + '.tmp';
  await pipeline(res.body, createGunzip(), createWriteStream(tmp));
  // A valid mmdb is well over 1 MB; reject a truncated/empty download.
  if (statSync(tmp).size < 100_000) throw new Error('file too small');
  const { renameSync } = await import('node:fs');
  renameSync(tmp, outFile);
  return url;
}

if (existsSync(outFile) && statSync(outFile).size > 100_000) {
  console.log('GeoIP DB already present:', outFile);
  process.exit(0);
}

let ok = false;
for (let i = 0; i < 4; i++) {
  const month = monthsBack(i);
  try {
    const url = await tryDownload(month);
    console.log('Downloaded GeoIP DB:', url, '->', outFile);
    ok = true;
    break;
  } catch (e) {
    console.warn(`  ${month}: ${e.message}`);
  }
}
if (!ok) {
  console.warn('GeoIP DB download failed; app will report country as "Unknown".');
}
process.exit(0);
