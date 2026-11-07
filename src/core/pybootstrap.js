/**
 * First-run auto-setup for the email-auth Python sidecar.
 *
 * The user should never run a terminal command. On startup the app calls
 * `ensureSidecarEnv()`, which — if a working sidecar venv isn't already present
 * — finds a usable Python on the machine, creates a private virtualenv in the
 * app's data directory, and installs the sidecar's (pure-Python) requirements.
 * It is idempotent and safe to call repeatedly: once the venv self-checks clean
 * it returns immediately.
 *
 * Everything impure (process spawning, path existence) is injected, so the
 * control flow is unit-testable with no Python and no filesystem.
 *
 * @typedef {(cmd:string, args:string[], opts?:{timeout?:number})=>Promise<{code:number, stdout:string, stderr:string}>} Run
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Candidate interpreters to probe, in order. `pre` is prepended to every call. */
const PYTHON_CANDIDATES = [
  { cmd: 'python3', pre: [] },
  { cmd: 'python', pre: [] },
  { cmd: 'py', pre: ['-3'] }, // Windows launcher
];

/** The venv's interpreter path for the current platform. */
export function venvPython(venvDir) {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python3');
}

/** Default process runner. Never rejects — a spawn failure is reported as code -1. */
function defaultRun(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  });
}

/**
 * Find a usable Python (>= 3.8) on the machine.
 * @returns {Promise<{cmd:string, pre:string[]}|null>}
 */
export async function findSystemPython({ run = defaultRun } = {}) {
  for (const cand of PYTHON_CANDIDATES) {
    const res = await run(cand.cmd, [...cand.pre, '-c', 'import sys;print(sys.version_info[0],sys.version_info[1])']);
    if (res.code !== 0) continue;
    const m = res.stdout.trim().match(/^(\d+)\s+(\d+)/);
    if (m && Number(m[1]) === 3 && Number(m[2]) >= 8) return cand;
  }
  return null;
}

/** Run the sidecar's --selfcheck and report whether it can do real work. */
async function selfcheckOk(python, script, run) {
  const res = await run(python, [script, '--selfcheck']);
  if (res.code !== 0) return false;
  try {
    const p = JSON.parse(res.stdout);
    return !!(p.available || p.partial);
  } catch {
    return false;
  }
}

/**
 * Ensure the sidecar venv exists and its libraries are installed.
 *
 * @param {{
 *   venvDir:string, requirements:string, script:string,
 *   run?:Run, exists?:(p:string)=>boolean, log?:(m:string)=>void
 * }} opts
 * @returns {Promise<{ready:boolean, python:(string|null), reason?:string, detail?:string, already?:boolean}>}
 */
export async function ensureSidecarEnv({ venvDir, requirements, script, run = defaultRun, exists = existsSync, log = () => {} }) {
  const python = venvPython(venvDir);

  // Already set up and working — fast path.
  if (exists(python) && (await selfcheckOk(python, script, run))) {
    return { ready: true, python, already: true };
  }

  const sys = await findSystemPython({ run });
  if (!sys) {
    return { ready: false, python: null, reason: 'python-not-found' };
  }

  if (!exists(python)) {
    log('Creating Python environment for email-auth checks…');
    const venv = await run(sys.cmd, [...sys.pre, '-m', 'venv', venvDir]);
    if (venv.code !== 0) {
      return { ready: false, python: null, reason: 'venv-failed', detail: venv.stderr.trim() };
    }
  }

  log('Installing email-auth libraries…');
  const pip = await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', requirements]);
  if (pip.code !== 0) {
    return { ready: false, python, reason: 'pip-failed', detail: pip.stderr.trim() };
  }

  if (await selfcheckOk(python, script, run)) {
    return { ready: true, python };
  }
  return { ready: false, python, reason: 'selfcheck-failed' };
}
