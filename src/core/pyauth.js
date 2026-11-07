/**
 * Bridge to the Python email-authentication sidecar (`python/authcheck.py`).
 *
 * The sidecar does accurate SPF evaluation, DKIM signature verification, and
 * DMARC alignment — things the JS checks in `authrecords.js` only approximate.
 * It is optional: if Python or its libraries aren't present, callers fall back
 * to the JS checks (see `authcheck.js`).
 *
 * The one impure primitive — running the Python process — is injected as
 * `exec(args, stdin) => Promise<{code, stdout, stderr}>`, so this module's
 * request/response handling is unit-testable with no Python installed.
 *
 * @typedef {(args:string[], stdin:string)=>Promise<{code:number, stdout:string, stderr:string}>} Exec
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(HERE, '..', '..', 'python');
/** Path to the sidecar script (src/core -> project root -> python/authcheck.py). */
export const SIDECAR_SCRIPT = join(PY_DIR, 'authcheck.py');

/**
 * Prefer the project venv's interpreter (where the sidecar's libraries live) if
 * it exists; otherwise fall back to `python3` on PATH. On Windows the venv
 * interpreter is under Scripts\.
 */
export function resolvePython() {
  const candidates = [
    join(PY_DIR, '.venv', 'bin', 'python3'),
    join(PY_DIR, '.venv', 'Scripts', 'python.exe'),
  ];
  return candidates.find((p) => existsSync(p)) || 'python3';
}

/**
 * Default process runner: `python3 <script> [args]`, feeding `stdin`, with a
 * hard timeout. Never rejects — a spawn failure resolves as a non-zero exit so
 * callers uniformly treat "couldn't run it" as "sidecar unavailable".
 * @type {Exec}
 */
function defaultExec(args, stdin, { python = resolvePython(), script = SIDECAR_SCRIPT, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
    }, timeout);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits early
    child.stdin.end(stdin ?? '');
  });
}

/**
 * Ask the sidecar which libraries are installed.
 * @param {{exec?:Exec}} [opts]
 * @returns {Promise<{available:boolean, partial:boolean, missing:string[]}>}
 *   `available` = all libs present; `partial` = some present. On any failure to
 *   run Python at all, returns available:false, partial:false.
 */
export async function sidecarAvailable({ exec = defaultExec } = {}) {
  try {
    const { code, stdout } = await exec(['--selfcheck'], '');
    if (code !== 0) return { available: false, partial: false, missing: ['python'] };
    const parsed = JSON.parse(stdout);
    return {
      available: !!parsed.available,
      partial: !!parsed.partial,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    };
  } catch {
    return { available: false, partial: false, missing: ['python'] };
  }
}

/**
 * Run an auth check through the sidecar.
 * @param {object} request — see authcheck.py's contract (domain, ip, helo, mailfrom, message).
 * @param {{exec?:Exec}} [opts]
 * @returns {Promise<object>} the parsed result (`ok:true` on success, `ok:false` with `error` otherwise).
 */
export async function runAuthSidecar(request, { exec = defaultExec } = {}) {
  let res;
  try {
    res = await exec([], JSON.stringify(request ?? {}));
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  if (res.code !== 0) {
    return { ok: false, error: res.stderr?.trim() || `sidecar exited ${res.code}` };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: 'unparseable sidecar output' };
  }
}
