import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSystemPython, ensureSidecarEnv, venvPython } from '../src/core/pybootstrap.js';

const SELFCHECK_OK = JSON.stringify({ available: true, partial: false, missing: [] });

test('findSystemPython picks the first candidate reporting Python >= 3.8', async () => {
  const run = async (cmd) => {
    if (cmd === 'python3') return { code: 1, stdout: '', stderr: 'not found' };
    if (cmd === 'python') return { code: 0, stdout: '3 11\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const found = await findSystemPython({ run });
  assert.equal(found.cmd, 'python');
});

test('findSystemPython rejects Python 2 and too-old Python 3', async () => {
  const run = async (cmd) => {
    if (cmd === 'python3') return { code: 0, stdout: '2 7\n', stderr: '' };
    if (cmd === 'python') return { code: 0, stdout: '3 6\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  assert.equal(await findSystemPython({ run }), null);
});

test('ensureSidecarEnv fast-paths when the venv already self-checks clean', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('--selfcheck')) return { code: 0, stdout: SELFCHECK_OK, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await ensureSidecarEnv({
    venvDir: '/data/venv',
    requirements: '/app/python/requirements.txt',
    script: '/app/python/authcheck.py',
    run,
    exists: () => true, // venv python already present
  });
  assert.equal(res.ready, true);
  assert.equal(res.already, true);
  assert.equal(res.python, venvPython('/data/venv'));
  // Only the selfcheck ran — no venv creation, no pip install.
  assert.ok(calls.every((c) => c.includes('--selfcheck')));
});

test('ensureSidecarEnv creates the venv and installs when absent', async () => {
  const seen = [];
  const run = async (cmd, args) => {
    seen.push(`${cmd} ${args.join(' ')}`);
    if (args.includes('-c')) return { code: 0, stdout: '3 12\n', stderr: '' }; // version probe
    if (args.includes('venv')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('pip')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('--selfcheck')) return { code: 0, stdout: SELFCHECK_OK, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await ensureSidecarEnv({
    venvDir: '/data/venv',
    requirements: '/app/python/requirements.txt',
    script: '/app/python/authcheck.py',
    run,
    exists: () => false, // nothing exists yet
  });
  assert.equal(res.ready, true);
  assert.ok(seen.some((c) => c.includes('-m venv /data/venv')));
  assert.ok(seen.some((c) => c.includes('-m pip install')));
});

test('ensureSidecarEnv reports python-not-found when no interpreter exists', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'command not found' });
  const res = await ensureSidecarEnv({
    venvDir: '/data/venv',
    requirements: '/r.txt',
    script: '/s.py',
    run,
    exists: () => false,
  });
  assert.equal(res.ready, false);
  assert.equal(res.reason, 'python-not-found');
});

test('ensureSidecarEnv reports pip-failed and surfaces the error detail', async () => {
  const run = async (cmd, args) => {
    if (args.includes('-c')) return { code: 0, stdout: '3 12\n', stderr: '' };
    if (args.includes('venv')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('pip')) return { code: 1, stdout: '', stderr: 'No matching distribution' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await ensureSidecarEnv({
    venvDir: '/data/venv',
    requirements: '/r.txt',
    script: '/s.py',
    run,
    exists: () => false,
  });
  assert.equal(res.ready, false);
  assert.equal(res.reason, 'pip-failed');
  assert.match(res.detail, /No matching distribution/);
});
