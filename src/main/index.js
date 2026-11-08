import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveTxt, resolve4, resolveMx, resolveSrv } from 'node:dns/promises';
import { runBatch } from '../core/tester.js';
import { streamCredentialsFromFile, dedupeFileToDisk } from '../core/parse-file.js';
import { createResultSink, exportRun, readRunProgress } from '../core/result-store.js';
import { credKey } from '../core/parser.js';
import { auditServer } from '../core/authaudit.js';
import { createHygieneAccumulator } from '../core/hygiene.js';
import { runCpanelChecks } from '../core/cpanel.js';
import { runWebmailChecks } from '../core/webmail.js';
import { runWhmChecks } from '../core/whm.js';
import { runSSHChecks, verifySSH } from '../core/ssh.js';
import { verifyCpanel } from '../core/cpanel.js';
import { verifyWebmail } from '../core/webmail.js';
import { verifyWhm } from '../core/whm.js';
import { ProxyPool } from '../core/proxy_pool.js';
import { LockoutRegistry } from '../core/lockout.js';
import { rateLimiter } from '../core/jitter.js';
import { checkEmailAuth } from '../core/authcheck.js';
import { makeExec, sidecarAvailable } from '../core/pyauth.js';
import { ensureSidecarEnv, venvPython } from '../core/pybootstrap.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { verifySeed } from '../core/imap.js';
import { buildProxyUrl } from '../core/smtp.js';
import { scoreContent } from '../core/spamscore.js';
import { getHwid } from '../core/hwid.js';
import { monitorDiff } from '../core/monitor.js';
import { verifyLicense } from '../core/license.js';
import { PUBLIC_KEY_PEM } from '../core/license-public-key.js';
import { loadSettings, saveSettings, getLicenseKey, setLicenseKey, getMonitor, saveMonitor } from './store.js';

const dns = { resolveTxt, resolve4, resolveMx, resolveSrv };
const TELEGRAM = '@splean_tool';

/** Build a SOCKS proxy URL from a saved proxy config, or null when disabled/empty. */
function proxyUrlFrom(cfg) {
  return cfg && cfg.enabled ? buildProxyUrl(cfg) : null;
}

// --- Health monitor -------------------------------------------------------

let monitorTimer = null;

/** Build runBatch options from saved settings (shared by batch + monitor). */
function optsFromSettings(s) {
  return {
    concurrency: s.concurrency || 5,
    connectTimeout: s.connectTimeout,
    sendTimeout: s.sendTimeout,
    placementTimeoutMs: s.placementTimeoutMs,
    pollIntervalMs: s.pollIntervalMs,
    from: s.from,
    subjectTemplate: s.subjectTemplate,
    bodyTemplate: s.bodyTemplate,
    proxy: proxyUrlFrom(s.proxy),
    retries: 1,
    deps: { dns },
  };
}

async function sendTelegramAlert(m, text) {
  if (!m.alertBotToken || !m.alertChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${m.alertBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: m.alertChatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    recordCrash('telegramAlert', err);
  }
}

async function runMonitorCheck() {
  const m = await getMonitor();
  if (!m.creds?.length) return { count: 0, died: [] };
  const settings = await loadSettings();
  const results = await runBatch(m.creds, settings.seeds || [], optsFromSettings(settings));
  const { died, newMap } = monitorDiff(m.statuses || {}, results);
  await saveMonitor({ statuses: newMap, lastCheck: Date.now() });

  if (died.length) {
    const lines = died.map((d) => `• ${d.cred.user} (${d.usedHost || d.cred.host || 'auto'})`).join('\n');
    if (Notification.isSupported()) {
      new Notification({
        title: 'SMTP Tester — credentials went dead',
        body: `${died.length} monitored SMTP${died.length === 1 ? '' : 's'} stopped working.`,
      }).show();
    }
    await sendTelegramAlert(
      m,
      `⚠️ <b>${died.length} monitored SMTP${died.length === 1 ? '' : 's'} went dead:</b>\n${lines}`,
    );
  }

  const summary = { count: results.length, died: died.map((d) => ({ user: d.cred.user, reason: d.reason })), at: Date.now() };
  mainWindow?.webContents.send('monitor:checked', summary);
  return summary;
}

async function restartMonitorSchedule() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  const m = await getMonitor();
  if (m.enabled && m.creds?.length) {
    const ms = Math.max(1, Number(m.intervalHours) || 6) * 3600 * 1000;
    monitorTimer = setInterval(() => runMonitorCheck().catch((e) => recordCrash('monitor', e)), ms);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow;
let currentAbort = null;

const proxyPool = new ProxyPool();

const lockoutRegistry = new LockoutRegistry({ maxFailures: 3, lockoutMs: 60000, hardLockFailures: 10 });

// --- Email-auth Python sidecar auto-setup ---------------------------------
// The sidecar's script + requirements ship read-only in the app; its venv is
// created in the writable user-data dir on first run. No manual activation.
function pythonDir() {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'python')
    : join(__dirname, '..', '..', 'python');
}
const sidecarScript = () => join(pythonDir(), 'authcheck.py');
const sidecarVenvDir = () => join(app.getPath('userData'), 'py-auth-venv');

let sidecarBinary = null; // a bundled frozen PyInstaller build, if shipped
let sidecarPython = null; // else a provisioned venv interpreter
let sidecarStatus = { state: 'pending' }; // pending | ready | unavailable

// A frozen onefile binary unpacks (and, when unsigned, gets security-scanned by
// the OS) on its FIRST launch, which can take 20-30s. The startup probe below
// warms it in the background; this generous timeout keeps both that probe and a
// user's first check from aborting the cold start. Warm runs are sub-second.
const SIDECAR_EXEC_TIMEOUT = 60000;

/** Path to the bundled frozen sidecar for this platform, or null if not shipped. */
function frozenSidecarPath() {
  const bin = process.platform === 'win32' ? 'authcheck.exe' : 'authcheck';
  const p = app.isPackaged
    ? join(process.resourcesPath, 'sidecar', bin)
    : join(__dirname, '..', '..', 'python', 'dist', bin);
  return existsSync(p) ? p : null;
}

/** Build the auth-check exec: prefer the frozen binary, else the venv interpreter. */
function authExec() {
  if (sidecarBinary) return makeExec({ binary: sidecarBinary, timeout: SIDECAR_EXEC_TIMEOUT });
  return makeExec({ python: sidecarPython || undefined, script: sidecarScript(), timeout: SIDECAR_EXEC_TIMEOUT });
}

/** Provision the sidecar in the background; never fatal — JS fallback covers failure. */
async function bootstrapSidecar() {
  try {
    // 1. A bundled frozen binary (shipped in the installer) needs nothing — no
    //    Python, no venv, no network. Verify it runs, then use it.
    const frozen = frozenSidecarPath();
    if (frozen) {
      const ok = await sidecarAvailable({ exec: makeExec({ binary: frozen, timeout: SIDECAR_EXEC_TIMEOUT }) });
      if (ok.available || ok.partial) {
        sidecarBinary = frozen;
        sidecarStatus = { state: 'ready', engine: 'bundled' };
        mainWindow?.webContents.send('auth:status', sidecarStatus);
        return;
      }
    }
    // 2. No frozen binary (e.g. dev) — provision a venv from a machine Python.
    const res = await ensureSidecarEnv({
      venvDir: sidecarVenvDir(),
      requirements: join(pythonDir(), 'requirements.txt'),
      script: sidecarScript(),
      log: (m) => {
        sidecarStatus = { state: 'pending', message: m };
        mainWindow?.webContents.send('auth:status', sidecarStatus);
      },
    });
    if (res.ready) {
      sidecarPython = res.python || venvPython(sidecarVenvDir());
      sidecarStatus = { state: 'ready' };
    } else {
      sidecarStatus = { state: 'unavailable', reason: res.reason, detail: res.detail };
    }
  } catch (err) {
    recordCrash('sidecarBootstrap', err);
    sidecarStatus = { state: 'unavailable', reason: 'error', detail: err.message };
  }
  mainWindow?.webContents.send('auth:status', sidecarStatus);
}

// Record unexpected errors to a log file (and keep the app alive) so a stray
// failure during a large run can be diagnosed instead of silently closing.
function recordCrash(kind, err) {
  const line = `${new Date().toISOString()} [${kind}] ${(err && (err.stack || err.message)) || err}\n`;
  try {
    appendFileSync(join(app.getPath('userData'), 'smtp-tester-crash.log'), line);
  } catch {
    /* best-effort */
  }
}
process.on('uncaughtException', (err) => recordCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => recordCrash('unhandledRejection', err));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'SMTP Tester',
    webPreferences: {
      preload: join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu?.();
  mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

function proxyPoolPath() {
  return join(app.getPath('userData'), 'proxy-pool.json');
}

let proxyDaemonTimer = null;
function startProxyDaemon() {
  if (proxyDaemonTimer) clearInterval(proxyDaemonTimer);
  proxyDaemonTimer = setInterval(async () => {
    // Only scrape if we have less than 100 live proxies left
    if (proxyPool.size().valid < 100) {
      try {
        console.log('[Daemon] Live proxies low (' + proxyPool.size().valid + '). Scraping 5000 fresh ones...');
        if (mainWindow) mainWindow.webContents.send('proxy:progress', { phase: 'daemon-start' });
        
        const scraped = await proxyPool.scrape();
        const validated = await proxyPool.validate({ maxProxies: 5000 });
        
        await proxyPool.save(proxyPoolPath());
        console.log('[Daemon] Done. Pool is back up to ' + validated.valid + ' live proxies.');
        
        if (mainWindow) mainWindow.webContents.send('proxy:progress', { phase: 'daemon-done', valid: validated.valid });
      } catch (err) {
        recordCrash('proxyDaemon', err);
      }
    }
  }, 60000); // Check every 60 seconds
}

app.whenReady().then(async () => {
  // Restore the scraped pool BEFORE the window opens so the renderer sees it.
  try { await proxyPool.load(proxyPoolPath()); } catch { /* noop */ }
  createWindow();
  startProxyDaemon();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Check the public releases repo for a newer version, download it, and notify;
  // it installs on quit. Packaged builds only (no-op in dev), never fatal.
  if (app.isPackaged) {
    autoUpdater.on('error', (e) => recordCrash('autoUpdater', e));
    autoUpdater.checkForUpdatesAndNotify().catch((e) => recordCrash('autoUpdater', e));
  }
  restartMonitorSchedule().catch((e) => recordCrash('monitor', e));
  // Auto-provision the email-auth sidecar in the background so the feature is
  // ready without any manual setup. Harmless if it can't complete.
  bootstrapSidecar();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC handlers ---------------------------------------------------------

// --- Licensing -----------------------------------------------------------

ipcMain.handle('license:get', async () => {
  const hwid = getHwid();
  const key = await getLicenseKey();
  const activated = key ? verifyLicense(hwid, key, PUBLIC_KEY_PEM).valid : false;
  return { activated, hwid, telegram: TELEGRAM };
});

ipcMain.handle('license:activate', async (_e, key) => {
  const hwid = getHwid();
  const result = verifyLicense(hwid, String(key || ''), PUBLIC_KEY_PEM);
  if (result.valid) await setLicenseKey(String(key).trim());
  return { ...result, hwid };
});

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) await shell.openExternal(url);
});

// --- Settings & testing ---------------------------------------------------

ipcMain.handle('settings:get', async () => loadSettings());

ipcMain.handle('settings:save', async (_e, settings) => saveSettings(settings));

ipcMain.handle('seed:test', async (_e, seed) => verifySeed(seed));

// Transport-security audit of a server the operator runs (no credentials sent).
ipcMain.handle('audit:server', async (_e, { host, port }) => {
  try {
    return await auditServer({ host: String(host || '').trim(), port: Number(port) || 587 });
  } catch (err) {
    return { error: err.message };
  }
});

// Batch cPanel login check for hosting accounts you operate: confirm which
// logins still work / which panels are up, instead of signing into each by
// hand. Streams per-account progress; returns all results plus a summary.
ipcMain.handle('cpanel:check', async (_e, { targets, opts }) => {
  try {
    const list = Array.isArray(targets) ? targets : [];
    const results = await runCpanelChecks(
      list,
      { concurrency: Number(opts?.concurrency) || 10, port: Number(opts?.port) || 2083, timeout: Number(opts?.timeout) || 10000, gate: rateLimiter({ maxPerSec: Number(opts?.maxPerSec) || 0 }), lockoutRegistry },
      (result, index) => mainWindow?.webContents.send('cpanel:progress', { result, index, total: list.length }),
    );
    const summary = results.reduce(
      (s, r) => ((s[r.status] = (s[r.status] || 0) + 1), s),
      { valid: 0, invalid: 0, unknown: 0, 'not-cpanel': 0, unreachable: 0 },
    );
    return { results, summary, total: results.length };
  } catch (err) {
    recordCrash('cpanelCheck', err);
    return { error: err.message };
  }
});

// Batch webmail (Roundcube/Horde/SquirrelMail) login check for accounts you
// operate — same shape as the cPanel check.
ipcMain.handle('webmail:check', async (_e, { targets, opts }) => {
  try {
    const list = Array.isArray(targets) ? targets : [];
    const results = await runWebmailChecks(
      list,
      {
        gate: rateLimiter({ maxPerSec: Number(opts?.maxPerSec) || 0 }),
        concurrency: Number(opts?.concurrency) || 10,
        port: Number(opts?.port) || 443,
        path: opts?.path || '/webmail',
        timeout: Number(opts?.timeout) || 10000,
        lockoutRegistry,
      },
      (result, index) => mainWindow?.webContents.send('webmail:progress', { result, index, total: list.length }),
    );
    const summary = results.reduce(
      (s, r) => ((s[r.status] = (s[r.status] || 0) + 1), s),
      { valid: 0, invalid: 0, unknown: 0, 'not-webmail': 0, unreachable: 0 },
    );
    return { results, summary, total: results.length };
  } catch (err) {
    recordCrash('webmailCheck', err);
    return { error: err.message };
  }
});

// Batch WHM (Web Host Manager, port 2087) login check — same shape as cPanel.
ipcMain.handle('whm:check', async (_e, { targets, opts }) => {
  try {
    const list = Array.isArray(targets) ? targets : [];
    const results = await runWhmChecks(
      list,
      { concurrency: Number(opts?.concurrency) || 10, port: Number(opts?.port) || 2087, timeout: Number(opts?.timeout) || 10000, gate: rateLimiter({ maxPerSec: Number(opts?.maxPerSec) || 0 }), lockoutRegistry },
      (result, index) => mainWindow?.webContents.send('whm:progress', { result, index, total: list.length }),
    );
    const summary = results.reduce(
      (s, r) => ((s[r.status] = (s[r.status] || 0) + 1), s),
      { valid: 0, invalid: 0, 'not-whm': 0, unreachable: 0 },
    );
    return { results, summary, total: results.length };
  } catch (err) {
    recordCrash('whmCheck', err);
    return { error: err.message };
  }
});

// Batch SSH login check for servers you operate (port 22), routed through the
// app-wide SOCKS proxy when one is configured.
ipcMain.handle('ssh:check', async (_e, { targets, opts }) => {
  try {
    const list = Array.isArray(targets) ? targets : [];
    const settings = await loadSettings();
    const results = await runSSHChecks(
      list,
      {
        gate: rateLimiter({ maxPerSec: Number(opts?.maxPerSec) || 0 }),
        concurrency: Number(opts?.concurrency) || 5,
        port: Number(opts?.port) || 22,
        timeout: Number(opts?.timeout) || 10000,
        lockoutRegistry,
        proxyUrl: proxyUrlFrom(settings?.proxy),
        ...(proxyPool.size().valid > 0 ? {
          proxyProvider: () => proxyPool.getNext(),
          onProxyFailure: (proxyUrl) => { proxyPool.markDead(proxyUrl); },
        } : {}),
      },
      (result, index) => mainWindow?.webContents.send('ssh:progress', { result, index, total: list.length }),
    );
    const summary = results.reduce(
      (s, r) => ((s[r.status] = (s[r.status] || 0) + 1), s),
      { valid: 0, invalid: 0, unreachable: 0 },
    );
    return { results, summary, total: results.length };
  } catch (err) {
    recordCrash('sshCheck', err);
    return { error: err.message };
  }
});

/** Load a breach corpus (one SHA-1 hex per line, optionally "HASH:count") into a Set. */
async function loadBreachSet(path) {
  if (!path) return null;
  const set = new Set();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const h = line.trim().split(/[:\s,]/)[0].toUpperCase();
      if (h) set.add(h);
    }
  } finally {
    rl.close();
  }
  return set;
}

// Offline credential-hygiene audit: stream an account export (email:password)
// and flag weak / reused / breached passwords. No SMTP, no network.
// --- Proxy pool (scraped SOCKS) ---
// Stateful pool, survives across batches. Scraped from SpeedX lists,
// validated against Cloudflare DNS, round-robin via getNext().

ipcMain.handle('proxy:scrape', async (event) => {
  try {
    const scraped = await proxyPool.scrape();
    try { event.sender.send('proxy:progress', { phase: 'scraped', parsed: scraped.parsed, fetched: scraped.fetched }); } catch {}
    const validated = await proxyPool.validate({
      maxProxies: 5000,
      onProgress: (done, total) => {
        try { event.sender.send('proxy:progress', { phase: 'validating', done, total }); } catch {}
      },
    });
    try { await proxyPool.save(proxyPoolPath()); } catch { /* noop */ }
    return { fetched: scraped.fetched, parsed: scraped.parsed, sources: scraped.sources, tested: validated.tested, valid: validated.valid, skipped: validated.skipped, size: proxyPool.size() };
  } catch (err) {
    recordCrash('proxyScrape', err);
    return { error: err.message };
  }
});

ipcMain.handle('proxy:status', async () => ({
  size: proxyPool.size(),
  scrapedAt: proxyPool.scrapedAt || null,
  sample: proxyPool.valid.slice(0, 3).map((e) => e.host + ':' + e.port),
}));

ipcMain.handle('proxy:clear', async () => {
  proxyPool.clear();
  try { await proxyPool.save(proxyPoolPath()); } catch { /* noop */ }
  return { size: proxyPool.size() };
});

ipcMain.handle('hygiene:auditFile', async (_e, { filePath, breachFilePath }) => {
  try {
    const breachedHashes = await loadBreachSet(breachFilePath ? String(breachFilePath) : '');
    const acc = createHygieneAccumulator({ breachedHashes });
    // dedupe:false so every account line is counted — reuse detection needs them.
    for await (const rec of streamCredentialsFromFile(String(filePath), { dedupe: false, onError: () => {} })) {
      acc.add(rec);
    }
    return acc.result();
  } catch (err) {
    return { error: err.message };
  }
});

/** Where the current/last run is streamed as JSONL (also the crash-safe autosave). */
function runFilePath() {
  return join(app.getPath('userData'), 'last-run.jsonl');
}

/** Where an uploaded file's deduped, normalized credentials are cached on disk. */
function parsedCredsPath() {
  return join(app.getPath('userData'), 'parsed-creds.txt');
}

/** Yield only credentials not already present in `keys` (for resuming a run). */
async function* skipKnown(source, keys) {
  for await (const rec of source) {
    if (keys.has(credKey(rec))) continue;
    yield rec;
  }
}

/**
 * Run a batch (from an array or a streaming source), writing each result to a
 * JSONL file on disk instead of accumulating them in memory, and forwarding
 * live progress to the renderer. Returns the totals the UI needs — never the
 * full result set, which at scale is far too large to hand back. With
 * `resume`, prior results in the run file are kept and already-tested
 * credentials are skipped.
 */
async function runBatchToDisk(source, seeds, opts, { resume = false } = {}) {
  currentAbort = new AbortController();
  // Resume: keep prior results, append new ones, and skip anything already done.
  const prior = resume ? await readRunProgress(runFilePath()) : { keys: new Set(), total: 0, counts: {} };
  const sink = resume
    ? createResultSink(runFilePath(), { append: true, initialTotal: prior.total, initialCounts: prior.counts })
    : createResultSink(runFilePath());
  const effSource = resume ? skipKnown(source, prior.keys) : source;
  // Pool rotation happens per credential via proxyProvider; manual proxy is the fallback.
  const hasPool = proxyPool.size().valid > 0;
  const proxyOptions = {
    proxy: proxyUrlFrom(opts.proxyConfig),
    ...(hasPool ? {
      proxyProvider: () => proxyPool.getNext(),
      onProxyFailure: (proxyUrl) => { proxyPool.markDead(proxyUrl); },
    } : {}),
  };
  try {
    await runBatch(
      effSource,
      seeds,
      { ...opts, ...proxyOptions, lockoutRegistry, signal: currentAbort.signal, deps: { dns } },
      async (result, index) => {
        if (currentAbort?.signal.aborted) return;
        if (opts.protocols === 'all' || opts.protocols === 'panels') {
          const host = (result.cred.user || '').split('@')[1];
          if (host) {
            const [cp, wm, whm, ssh] = await Promise.allSettled([
              verifyCpanel({ host, user: result.cred.user, pass: result.cred.pass }),
              verifyWebmail({ host, user: result.cred.user, pass: result.cred.pass }),
              verifyWhm({ host, user: result.cred.user, pass: result.cred.pass }),
              verifySSH({ host, user: result.cred.user, pass: result.cred.pass })
            ]);
            if (currentAbort?.signal.aborted) return;
            result.panels = {
              cpanel: cp.status === 'fulfilled' ? cp.value : null,
              webmail: wm.status === 'fulfilled' ? wm.value : null,
              whm: whm.status === 'fulfilled' ? whm.value : null,
              ssh: ssh.status === 'fulfilled' ? ssh.value : null
            };
          }
        }
        sink.write(result);
        mainWindow?.webContents.send('batch:progress', { result, index });
      },
    );
    return await sink.close();
  } catch (err) {
    await sink.close().catch(() => {});
    throw err;
  } finally {
    // Always clear the abort handle and signal completion, even if the batch
    // throws, so the renderer never gets stuck in the "running" state.
    currentAbort = null;
    mainWindow?.webContents.send('batch:done', { done: true });
  }
}

ipcMain.handle('batch:run', async (_e, { creds, seeds, opts }) => runBatchToDisk(creds, seeds, opts));

// Count the credentials in an uploaded file without loading its text into the
// renderer — lets the UI show the parsed count + a sample the moment a huge
// lead file is picked, with no main-window freeze.
ipcMain.handle('creds:countFile', async (_e, filePath) => {
  try {
    // Dedupe once, here, writing a normalized copy to disk. The run streams
    // that copy with dedupe off, so the multi-GB key Set is built a single
    // time instead of once now and again at run time.
    const parsedPath = parsedCredsPath();
    const { count, errors, sample } = await dedupeFileToDisk(String(filePath), parsedPath);
    return { count, errors, sample, parsedPath };
  } catch (err) {
    recordCrash('countFile', err);
    return { count: 0, errors: 0, sample: [], error: err.message };
  }
});

// Test a batch straight from a file on disk. Credentials stream line-by-line
// into the worker pool, so a multi-million-lead file is never held whole in
// memory and never crosses IPC as one giant array.
ipcMain.handle('batch:runFile', async (_e, { filePath, seeds, opts, resume, preDeduped }) => {
  // A pre-deduped file (the normalized copy written during the count pass)
  // streams with dedupe off — no second key Set. A raw path still dedupes.
  const source = streamCredentialsFromFile(String(filePath), { dedupe: !preDeduped, onError: () => {} });
  return runBatchToDisk(source, seeds, opts, { resume: !!resume });
});

// How much of a prior run is on disk, so the UI can offer "resume" and seed its
// progress display. Returns only summary numbers, never the credential keys.
ipcMain.handle('run:progress', async () => {
  const { total, counts } = await readRunProgress(runFilePath());
  return { total, counts };
});

ipcMain.handle('content:score', async (_e, content) => scoreContent(content));

// Email-authentication check (SPF eval / DKIM verify / DMARC alignment) via the
// Python sidecar when available, falling back to the built-in JS record checks.
ipcMain.handle('auth:check', async (_e, request) => {
  try {
    return await checkEmailAuth(request || {}, { resolveTxt, exec: authExec() });
  } catch (err) {
    return { error: err.message };
  }
});

// Current state of the auto-provisioned sidecar, so the UI can show setup
// progress and whether checks run with full (Python) or fallback (JS) accuracy.
ipcMain.handle('auth:status', async () => sidecarStatus);

// --- Health monitor IPC ---
ipcMain.handle('monitor:get', async () => getMonitor());
ipcMain.handle('monitor:save', async (_e, patch) => {
  const m = await saveMonitor(patch);
  await restartMonitorSchedule();
  return m;
});
ipcMain.handle('monitor:setCreds', async (_e, creds) => {
  // New list resets the known statuses (baseline re-established on next check).
  const m = await saveMonitor({ creds: creds || [], statuses: {} });
  await restartMonitorSchedule();
  return m;
});
ipcMain.handle('monitor:checkNow', async () => runMonitorCheck());

ipcMain.handle('batch:cancel', async () => {
  currentAbort?.abort();
  return true;
});

// Export the last run by streaming its JSONL file to the chosen format — the
// results never come back through IPC, so a multi-million-row export stays
// bounded in memory.
ipcMain.handle('results:exportByProtocol', async () => {
  try {
    const filePath = runFilePath();
    if (!existsSync(filePath)) return { error: 'No results found' };

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const hits = { smtp: [], cpanel: [], webmail: [], whm: [], ssh: [] };

    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        const user = r.cred?.user || '?';
        const pass = r.cred?.pass || '?';
        const host = r.usedHost || r.cred?.host || (user.split('@')[1] || '');

        if (r.status === 'valid' || r.status === 'inbox' || r.status === 'spam') {
          hits.smtp.push(user + ':' + pass);
        }
        if (r.panels) {
          if (r.panels.cpanel?.valid) hits.cpanel.push(host + ':' + user + ':' + pass);
          if (r.panels.webmail?.valid) hits.webmail.push(host + ':' + user + ':' + pass);
          if (r.panels.whm?.valid) hits.whm.push(host + ':' + user + ':' + pass);
          if (r.panels.ssh?.valid) hits.ssh.push(host + ':' + user + ':' + pass);
        }
      } catch (e) { /* skip bad lines */ }
    }

    const dlPath = app.getPath('downloads');
    const outDir = join(dlPath, 'result');
    try { mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore if exists */ }
    let count = 0;
    for (const [proto, arr] of Object.entries(hits)) {
      if (arr.length > 0) {
        writeFileSync(join(outDir, proto + '_valid.txt'), arr.join('\n'));
        count++;
      }
    }
    return { saved: true, count, folder: outDir };
  } catch (err) {
    recordCrash('exportByProtocol', err);
    return { error: err.message };
  }
});

ipcMain.handle('results:exportRun', async (_e, { format }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `smtp-results.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (canceled || !filePath) return { saved: false };
  await exportRun(runFilePath(), filePath, format, { generatedAt: new Date().toISOString() });
  return { saved: true, path: filePath };
});
