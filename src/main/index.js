import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolveTxt, resolve4, resolveMx, resolveSrv } from 'node:dns/promises';
import { runBatch } from '../core/tester.js';
import { verifySeed } from '../core/imap.js';
import { buildProxyUrl } from '../core/smtp.js';
import { scoreContent } from '../core/spamscore.js';
import { toWorkingTxt } from '../core/export.js';
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

app.whenReady().then(() => {
  createWindow();
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

ipcMain.handle('batch:run', async (_e, { creds, seeds, opts }) => {
  currentAbort = new AbortController();
  // Crash-safe autosave: stream results to disk so a close/crash mid-run keeps
  // everything tested so far (recoverable from userData/last-run.json).
  const autosavePath = join(app.getPath('userData'), 'last-run.json');
  const collected = [];
  try {
    const results = await runBatch(
      creds,
      seeds,
      { ...opts, proxy: proxyUrlFrom(opts.proxyConfig), signal: currentAbort.signal, deps: { dns } },
      (result, index) => {
        collected.push(result);
        mainWindow?.webContents.send('batch:progress', { result, index });
        if (collected.length % 25 === 0) {
          writeFile(autosavePath, JSON.stringify(collected)).catch(() => {});
        }
      },
    );
    await writeFile(autosavePath, JSON.stringify(results)).catch(() => {});
    return results;
  } finally {
    // Always clear the abort handle and signal completion, even if the batch
    // throws, so the renderer never gets stuck in the "running" state.
    currentAbort = null;
    mainWindow?.webContents.send('batch:done', { done: true });
  }
});

ipcMain.handle('content:score', async (_e, content) => scoreContent(content));

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

ipcMain.handle('results:export', async (_e, { results, format }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `smtp-results.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (canceled || !filePath) return { saved: false };
  const content =
    format === 'json' ? toJson(results)
    : format === 'txt' ? toWorkingTxt(results, { generatedAt: new Date().toISOString() })
    : toCsv(results);
  await writeFile(filePath, content, 'utf8');
  return { saved: true, path: filePath };
});

function toJson(results) {
  return JSON.stringify(results, null, 2);
}

function toCsv(results) {
  const header = ['host', 'port', 'user', 'status', 'usedHost', 'usedPort', 'reason', 'latencyMs', 'placement', 'token'];
  const rows = results.map((r) => {
    const placement = (r.perSeed || [])
      .map((s) => `${s.label}=${s.error ? 'error' : s.folder || 'not found'}`)
      .join('; ');
    return [
      r.cred.host || '(auto)',
      r.cred.port || '',
      r.cred.user,
      r.status,
      r.usedHost || '',
      r.usedPort || '',
      r.reason,
      r.latencyMs,
      placement,
      r.token || '',
    ]
      .map(csvCell)
      .join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
