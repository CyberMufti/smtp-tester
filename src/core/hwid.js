import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Stable per-machine hardware ID.
 *
 * `getHwid()` derives a seed from the OS machine GUID (most stable identifier
 * available per platform), falling back to hostname + MAC + CPU if that can't
 * be read, then hashes it into a readable grouped-hex code. The pure
 * `hwidFromSeed()` is unit-tested.
 */

/** @param {string} seed @returns {string} e.g. "A1B2-C3D4-E5F6-7890-1234-5678" */
export function hwidFromSeed(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').slice(0, 24).toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

function readMachineGuid() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8' },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      if (m) return m[1];
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } else {
      // Linux and others: the systemd/D-Bus machine id.
      const { readFileSync } = require('node:fs');
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = readFileSync(p, 'utf8').trim();
          if (id) return id;
        } catch {
          /* try next */
        }
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return null;
}

function fallbackSeed() {
  const nets = os.networkInterfaces();
  const mac = Object.values(nets)
    .flat()
    .find((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')?.mac;
  const cpu = os.cpus()?.[0]?.model || '';
  return [os.hostname(), mac || '', cpu, os.platform(), os.arch()].join('|');
}

/** @returns {string} the machine's HWID */
export function getHwid() {
  const guid = readMachineGuid();
  return hwidFromSeed(`${guid || fallbackSeed()}|${process.platform}`);
}
