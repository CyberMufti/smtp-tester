import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveTxt, resolve4, resolveMx, resolveSrv } from 'node:dns/promises';
import { runBatch } from '../core/tester.js';
import { streamCredentialsFromFile, dedupeFileToDisk, parsedCredsPathFor } from '../core/parse-file.js';
import { createResultSink, exportRun, readRunProgress, readResults } from '../core/result-store.js';
import { createProgressBatcher } from '../core/progress-batcher.js';
import { settleWithBudget } from '../core/settle-with-budget.js';
import { shouldRunPanelChecks } from '../core/panel-gate.js';
import { pickInstanceSlot, createFileLockStore } from '../core/instance-lock.js';
import { countHostMapEntries } from '../core/hostmap.js';

// Hard ceiling for a single credential's panel fan-out. Above any individual
// probe's timeout (5s) so normal detection is unaffected; it only caps the
// pathological case where a probe never honors its own timeout (a dead proxy
// that never resets) and would otherwise hang the worker forever.
const PANEL_BUDGET_MS = 9000;
import { resultFolderFiles, verifiedFolderFiles } from '../core/export.js';
import { makeGeoResolver, loadCountryLookup } from '../core/geoip.js';
import { grabBanner } from '../core/banner.js';
import { probeRealm } from '../core/ms-realm.js';
import { enumerateUser } from '../core/smtp-enum.js';
import { verifyEmail } from '../core/verify.js';
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
import { verifyImap, verifyPop3 } from '../core/mail-extra.js';
import { verifyPlesk, verifyDirectAdmin, verifyCyberPanel, verifyWebmin, verifyHestia } from '../core/panels-extra.js';
import { ProxyPool } from '../core/proxy_pool.js';
import { LockoutRegistry } from '../core/lockout.js';
import { rateLimiter } from '../core/jitter.js';
import { checkEmailAuth } from '../core/authcheck.js';
import { makeExec, sidecarAvailable, runAuthSidecar } from '../core/pyauth.js';
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
import { loadSettings, saveSettings, getLicenseKey, setLicenseKey, getMonitor, saveMonitor, getRunHistory, saveRunSummary, clearRunHistory } from './store.js';

async function safeReadProgress(filePath) {
  try {
    return await readRunProgress(filePath);
  } catch (err) {
    recordCrash('readRunProgress', err);
    return { keys: new Set(), total: 0, counts: {} };
  }
}

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
        title: 'ENDPOINT — credentials went dead',
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

// Give the main process a larger V8 heap so counting/deduping very large lead
// files (tens of millions of rows) has headroom. Must be set before app ready.
try { app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096'); } catch { /* noop */ }

// --- Per-instance isolation -------------------------------------------------
// Multiple copies of the app must not share one set of data files (run log,
// proxy pool, settings, result folder). Concurrent writes corrupt them and, on
// Windows, the file-lock conflicts cause hangs and crashes. Give each running
// copy its own slot: slot 1 keeps the default paths (existing data untouched),
// later slots get isolated userData + result directories. Must run before any
// userData path is read. The lock fds are held for the process lifetime so the
// slot stays claimed; the OS frees them on exit (even on crash).
let instanceLockFds = [];
const INSTANCE_SLOT = (() => {
  try {
    const store = createFileLockStore(join(app.getPath('appData'), 'smtp-tester-instance-locks'));
    instanceLockFds = store.heldFds;
    const slot = pickInstanceSlot(store);
    if (slot > 1) app.setPath('userData', `${app.getPath('userData')}-${slot}`);
    return slot;
  } catch {
    // Never refuse to start — fall back to the default (shared) paths.
    return 1;
  }
})();

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
    minWidth: 960,
    minHeight: 600,
    title: INSTANCE_SLOT > 1 ? `ENDPOINT Operator — Instance ${INSTANCE_SLOT}` : 'ENDPOINT Operator',
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
let proxyReplenishing = false;
const PROXY_TARGET = 100;

// Top up the live proxy pool when it runs low — MERGE fresh validated proxies
// into the existing pool (not replace), guarded so only one replenish runs at a
// time (prevents the overlapping-scrape storm). Called on a timer AND whenever a
// proxy dies mid-run, so dead proxies are replaced automatically during testing.
async function replenishProxies(target = PROXY_TARGET) {
  if (proxyReplenishing) return;
  if (proxyPool.size().valid >= target) return;
  proxyReplenishing = true;
  try {
    mainWindow?.webContents.send('proxy:progress', { phase: 'daemon-start', valid: proxyPool.size().valid });
    await proxyPool.scrape();
    const res = await proxyPool.validate({ maxProxies: 5000, merge: true });
    await proxyPool.save(proxyPoolPath());
    console.log(`[Proxy] Topped up +${res.added}; pool now ${proxyPool.size().valid} live.`);
    mainWindow?.webContents.send('proxy:progress', { phase: 'daemon-done', valid: proxyPool.size().valid, added: res.added });
  } catch (err) {
    recordCrash('proxyReplenish', err);
  } finally {
    proxyReplenishing = false;
  }
}

/** Remove a dead proxy and kick a top-up if that drops the pool below target. */
function retireProxy(proxyUrl) {
  proxyPool.markDead(proxyUrl);
  if (proxyPool.size().valid < PROXY_TARGET) replenishProxies().catch(() => {});
}

function startProxyDaemon() {
  if (proxyDaemonTimer) clearInterval(proxyDaemonTimer);
  proxyDaemonTimer = setInterval(() => { replenishProxies().catch(() => {}); }, 30000);
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
ipcMain.handle('hostmap:save', async (_e, text) => {
  await saveSettings({ ...(await loadSettings()), hostMap: text });
  return { size: countHostMapEntries(text) };
});
ipcMain.handle('hostmap:get', async () => {
  const s = await loadSettings();
  return s.hostMap || '';
});

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
      { concurrency: Number(opts?.concurrency) || 10, port: Number(opts?.port) || 2083, ports: opts?.ports || [2083, 2082, 8443], timeout: Number(opts?.timeout) || 10000, gate: rateLimiter({ maxPerSec: Number(opts?.maxPerSec) || 0 }), lockoutRegistry },
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
        ports: opts?.ports || [443, 2096, 2095],
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
      { concurrency: Number(opts?.concurrency) || 10, port: Number(opts?.port) || 2087, ports: opts?.ports || [2087, 2086, 8443], timeout: Number(opts?.timeout) || 10000, gate: rateLimiter({ maxPerSec: Number(opts?.maxPerSec) || 0 }), lockoutRegistry },
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
        ports: opts?.ports || [22, 2222, 2022],
        timeout: Number(opts?.timeout) || 10000,
        lockoutRegistry,
        proxyUrl: proxyUrlFrom(settings?.proxy),
        ...(proxyPool.size().valid > 0 ? {
          proxyProvider: () => proxyPool.getNext(),
          onProxyFailure: (proxyUrl) => retireProxy(proxyUrl),
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

/**
 * Where an uploaded file's deduped, normalized credentials are cached on disk.
 * Unique per source file — a single fixed name collides when several files are
 * loaded, making each file's copy overwrite the previous one so the run streams
 * the last file once per loaded file (double-counting it, skipping the others).
 */
function parsedCredsPath(srcPath) {
  return parsedCredsPathFor(app.getPath('userData'), srcPath);
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
// GeoIP country resolver, built once from the bundled DB-IP database. If the
// database isn't present (e.g. a build without the download step), the lookup
// yields null and every country degrades to "Unknown" — never an error.
let geoResolverPromise = null;
function getGeoResolver() {
  if (!geoResolverPromise) {
    geoResolverPromise = (async () => {
      const dbPath = join(process.resourcesPath || app.getAppPath(), 'geoip', 'dbip-country-lite.mmdb');
      const lookup = await loadCountryLookup(dbPath);
      return makeGeoResolver({ resolve4: (h) => resolve4(h), lookup });
    })();
  }
  return geoResolverPromise;
}

async function runBatchToDisk(source, seeds, opts, { resume = false } = {}) {
  currentAbort = new AbortController();
  const geoResolver = await getGeoResolver();
  // Resume: keep prior results, append new ones, and skip anything already done.
  const prior = resume ? await safeReadProgress(runFilePath()) : { keys: new Set(), total: 0, counts: {} };
  const sink = resume
    ? createResultSink(runFilePath(), { append: true, initialTotal: prior.total, initialCounts: prior.counts })
    : createResultSink(runFilePath());
  // Coalesce per-credential progress into batched IPC sends. One message per
  // credential floods the renderer (and this process) at large scale; a batched
  // array keeps the message rate bounded while delivering every result.
  const progress = createProgressBatcher({
    flush: (items) => mainWindow?.webContents.send('batch:progress', items),
  });
  const effSource = resume ? skipKnown(source, prior.keys) : source;
  // Pool rotation happens per credential via proxyProvider; manual proxy is the fallback.
  const hasPool = proxyPool.size().valid > 0;
  const proxyOptions = {
    proxy: proxyUrlFrom(opts.proxyConfig),
    ...(hasPool ? {
      proxyProvider: () => proxyPool.getNext(),
      onProxyFailure: (proxyUrl) => retireProxy(proxyUrl),
    } : {}),
  };
  // When the email-auth sidecar is ready, give the batch a real SPF/DMARC
  // evaluator so deliverability checks (and the valid->unverified gate) use
  // actual SPF-against-sending-IP and DMARC alignment, not just record presence.
  const evalAuth = sidecarStatus.state === 'ready'
    ? (request) => runAuthSidecar(request, { exec: authExec() })
    : null;
  try {
    await runBatch(
      effSource,
      seeds,
      { ...opts, ...proxyOptions, geoResolver, lockoutRegistry, signal: currentAbort.signal, deps: { dns, evalAuth, grabBanner, msRealm: (login) => probeRealm(login) } },
      async (result, index) => {
        if (currentAbort?.signal.aborted) return;
        try {
          if ((opts.protocols === 'all' || opts.protocols === 'panels') && shouldRunPanelChecks(result)) {
            const _uParts = (result.cred.user || '').split('@');
            const host = _uParts[1];
            const bareUser = _uParts[0];
            if (host) {
              const safe = async (fn, label) => {
                try { return await fn(); } catch (e) { return { error: label + ': ' + (e.message || String(e)) }; }
              };
              // Route the HTTPS control-panel checks through the proxy pool (a
              // fresh SOCKS proxy per credential) so they don't hit panels from
              // the operator's IP. Falls back to the manual proxy, then direct.
              const panelProxy = (hasPool && proxyPool.getNext()) || proxyUrlFrom(opts.proxyConfig) || undefined;
              // Budget the whole fan-out: a probe that ignores its own timeout
              // must not hang the worker. Unfinished probes come back as a
              // timeout marker so the credential's result is still delivered.
              const [cp, wm, whm, ssh, imapR, pop3R, pleskR, daR, cyber, webmin, hestia] = await settleWithBudget([
                { label: 'cpanel', run: () => safe(() => runCpanelChecks([{ host, user: bareUser, pass: result.cred.pass }], { timeout: 4000, concurrency: 1, ports: [2083, 2082, 8443], proxy: panelProxy }).then(r => r[0]), 'cpanel') },
                { label: 'webmail', run: () => safe(() => runWebmailChecks([{ host, user: bareUser, pass: result.cred.pass }], { timeout: 4000, concurrency: 1, ports: [443, 2096, 2095], proxy: panelProxy }).then(r => r[0]), 'webmail') },
                { label: 'whm', run: () => safe(() => runWhmChecks([{ host, user: bareUser, pass: result.cred.pass }], { timeout: 4000, concurrency: 1, ports: [2087, 2086, 8443], proxy: panelProxy }).then(r => r[0]), 'whm') },
                { label: 'ssh', run: () => safe(() => runSSHChecks([{ host, user: bareUser, pass: result.cred.pass }], { timeout: 4000, concurrency: 1, ports: [22, 2222, 2022] }).then(r => r[0]), 'ssh') },
                { label: 'imap', run: () => safe(() => verifyImap({ host, user: result.cred.user, pass: result.cred.pass }, { timeout: 5000 }), 'imap') },
                { label: 'pop3', run: () => safe(() => verifyPop3({ host, user: result.cred.user, pass: result.cred.pass }, { timeout: 5000 }), 'pop3') },
                { label: 'plesk', run: () => safe(() => verifyPlesk({ host, user: result.cred.user, pass: result.cred.pass }, { timeout: 5000, proxy: panelProxy }), 'plesk') },
                { label: 'directadmin', run: () => safe(() => verifyDirectAdmin({ host, user: result.cred.user, pass: result.cred.pass }, { timeout: 5000, proxy: panelProxy }), 'directadmin') },
                { label: 'cyberpanel', run: () => safe(() => verifyCyberPanel({ host, user: bareUser, pass: result.cred.pass }, { timeout: 5000, proxy: panelProxy }), 'cyberpanel') },
                { label: 'webmin', run: () => safe(() => verifyWebmin({ host, user: bareUser, pass: result.cred.pass }, { timeout: 5000, proxy: panelProxy }), 'webmin') },
                { label: 'hestia', run: () => safe(() => verifyHestia({ host, user: bareUser, pass: result.cred.pass }, { timeout: 5000, proxy: panelProxy }), 'hestia') },
              ], PANEL_BUDGET_MS);
              if (currentAbort?.signal.aborted) return;
              result.panels = { cpanel: cp, webmail: wm, whm, ssh, imap: imapR, pop3: pop3R, plesk: pleskR, directadmin: daR, cyberpanel: cyber, webmin, hestia };
            }
          }
        } catch (panelErr) {
          result.panelError = panelErr.message || String(panelErr);
        }
        // Await drain on backpressure so results can't buffer unboundedly in
        // memory when they arrive faster than the disk flushes (e.g. a run of
        // instant connection-refused failures) — this throttles the worker that
        // awaits this callback, keeping the streaming sink bounded as intended.
        if (!sink.write(result)) await sink.drain();
        progress.push({ result, index });
      },
    );
    const summary = await sink.close();
    // Auto-write the per-provider result folder to the Desktop after every run,
    // so the user never has to click Export. Best-effort: a write failure must
    // not fail the run itself.
    try {
      await writeResultFolder(runFilePath(), resultFolderPath());
    } catch (e) {
      recordCrash('autoResultFolder', e);
    }
    return summary;
  } catch (err) {
    await sink.close().catch(() => {});
    throw err;
  } finally {
    // Always clear the abort handle and signal completion, even if the batch
    // throws, so the renderer never gets stuck in the "running" state.
    currentAbort = null;
    progress.flush();
    mainWindow?.webContents.send('batch:done', { done: true });
  }
}

// batch:run safety wrapper — ECONNRESET during panel/socket work must not
// leak as 'reply was never sent'. Any throw becomes a readable { error }.
ipcMain.handle('batch:run', async (_e, { creds, seeds, opts }) => {
  try {
    return await runBatchToDisk(creds, seeds, opts);
  } catch (err) {
    recordCrash('batchRun', err);
    return { error: err.message || String(err) };
  }
});

// Count the credentials in an uploaded file without loading its text into the
// renderer — lets the UI show the parsed count + a sample the moment a huge
// lead file is picked, with no main-window freeze.
ipcMain.handle('creds:countFile', async (_e, filePath) => {
  try {
    // Dedupe once, here, writing a normalized copy to disk. The run streams
    // that copy with dedupe off, so the multi-GB key Set is built a single
    // time instead of once now and again at run time.
    const parsedPath = parsedCredsPath(String(filePath));
    const { count, errors, sample, dedupeTruncated } = await dedupeFileToDisk(String(filePath), parsedPath);
    return { count, errors, sample, parsedPath, dedupeTruncated };
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
  const { total, counts } = await safeReadProgress(runFilePath());
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

// Run history (compact per-run summaries, persisted locally).
ipcMain.handle('history:save', async (_e, { summary }) => saveRunSummary(summary).catch(() => []));
ipcMain.handle('history:list', async () => getRunHistory().catch(() => []));
ipcMain.handle('history:clear', async () => clearRunHistory().catch(() => []));

// Passwordless email verification (the Verify screen). Streams one result per
// address back to the renderer. Uses RCPT-TO on port 25 for existence (needs
// outbound 25), Microsoft IfExistsResult for M365, plus catch-all/disposable/
// role flags and provider/country.
let verifyAbort = null;
ipcMain.handle('verify:cancel', async () => { verifyAbort?.abort(); return true; });
ipcMain.handle('verify:run', async (_e, { emails }) => {
  verifyAbort = new AbortController();
  const signal = verifyAbort.signal;
  const list = (emails || []).map((s) => String(s).trim()).filter(Boolean);
  const geoResolver = await getGeoResolver();
  const deps = {
    resolveMx: async (domain) => {
      try { return (await resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange); }
      catch { return []; }
    },
    enumerate: (email, { host, port }) => enumerateUser({ user: email }, { host, port, timeout: 8000 }),
    msRealm: (email) => probeRealm(email),
    geoResolver,
  };
  const counts = {};
  let done = 0;
  const concurrency = 8;
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      if (signal.aborted) return;
      const email = list[idx++];
      let result;
      try { result = await verifyEmail(email, deps); }
      catch (err) { result = { email, status: 'unknown', error: err.message }; }
      counts[result.status] = (counts[result.status] || 0) + 1;
      done++;
      mainWindow?.webContents.send('verify:progress', { result, done, total: list.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  mainWindow?.webContents.send('verify:done', { done, total: list.length, counts });
  return { total: list.length, counts };
});

// Export the last run by streaming its JSONL file to the chosen format — the
// results never come back through IPC, so a multi-million-row export stays
// bounded in memory.
// The Desktop folder a run's per-provider files are written to.
function resultFolderPath() {
  const base = join(app.getPath('desktop'), 'result');
  // Keep each instance's auto-exported folder separate — writeResultFolder
  // clears the folder before writing, so a shared path would have instances
  // wiping each other's results.
  return INSTANCE_SLOT > 1 ? `${base}-${INSTANCE_SLOT}` : base;
}

/**
 * Write a run's working credentials to `outDir` as one file per provider,
 * grouped by trustworthiness (see resultFolderFiles). Streams the run file so a
 * multi-million-row run stays bounded in memory — only the working lines are
 * held. The folder is cleared first so it always reflects the latest run.
 * Returns the number of files written. Never throws for a missing run file.
 */
async function writeResultFolder(runFile, outDir) {
  if (!existsSync(runFile)) return { count: 0, folder: outDir };
  const files = {};
  for await (const r of readResults(runFile)) {
    const one = resultFolderFiles([r]);
    for (const [name, lines] of Object.entries(one)) (files[name] ||= []).push(...lines);
  }
  // Clear only the subtrees this function owns (SMTP result/ and Leads/) so a
  // separate verified/ folder from the Email Verifier is preserved across runs.
  for (const sub of ['SMTP result', 'Leads', 'panels']) {
    try { rmSync(join(outDir, sub), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  mkdirSync(outDir, { recursive: true });
  let count = 0;
  for (const [name, arr] of Object.entries(files)) {
    if (arr.length === 0) continue;
    const full = join(outDir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, arr.join('\n'));
    count++;
  }
  return { count, folder: outDir };
}

// Write the Email Verifier's VALID addresses to Desktop/result/verified/, one
// file per provider+country. Clears only result/verified first.
async function writeVerifiedFolder(results) {
  const outDir = join(resultFolderPath(), 'verified');
  const files = verifiedFolderFiles(results || []);
  try { rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  mkdirSync(outDir, { recursive: true });
  let count = 0;
  let emails = 0;
  for (const [name, arr] of Object.entries(files)) {
    if (!arr.length) continue;
    writeFileSync(join(outDir, name), arr.join('\n'));
    count++;
    emails += arr.length;
  }
  return { count, emails, folder: outDir };
}

ipcMain.handle('verify:export', async (_e, { results }) => {
  try {
    const { count, emails, folder } = await writeVerifiedFolder(results);
    return { saved: true, count, emails, folder };
  } catch (err) {
    recordCrash('verifyExport', err);
    return { error: err.message };
  }
});

ipcMain.handle('results:exportByProtocol', async () => {
  try {
    const filePath = runFilePath();
    if (!existsSync(filePath)) return { error: 'No results found' };
    const { count, folder } = await writeResultFolder(filePath, resultFolderPath());
    return { saved: true, count, folder };
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

// Confirmed-only export: just the SMTPs whose test message was found in a seed
// inbox/spam folder, as re-importable host:port:user:pass. Written as a .txt.
ipcMain.handle('results:exportConfirmed', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'smtp-confirmed.txt',
    filters: [{ name: 'TXT', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { saved: false };
  await exportRun(runFilePath(), filePath, 'confirmed', { generatedAt: new Date().toISOString() });
  return { saved: true, path: filePath };
});
