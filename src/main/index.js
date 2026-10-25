import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { resolveTxt, resolve4 } from 'node:dns/promises';
import { runBatch } from '../core/tester.js';
import { verifySeed } from '../core/imap.js';
import { scoreContent } from '../core/spamscore.js';
import { toWorkingTxt } from '../core/export.js';
import { loadSettings, saveSettings } from './store.js';

const dns = { resolveTxt, resolve4 };

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow;
let currentAbort = null;

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC handlers ---------------------------------------------------------

ipcMain.handle('settings:get', async () => loadSettings());

ipcMain.handle('settings:save', async (_e, settings) => saveSettings(settings));

ipcMain.handle('seed:test', async (_e, seed) => verifySeed(seed));

ipcMain.handle('batch:run', async (_e, { creds, seeds, opts }) => {
  currentAbort = new AbortController();
  const results = await runBatch(
    creds,
    seeds,
    { ...opts, signal: currentAbort.signal, deps: { dns } },
    (result, index) => {
      mainWindow?.webContents.send('batch:progress', { result, index });
    },
  );
  currentAbort = null;
  mainWindow?.webContents.send('batch:done', { count: results.length });
  return results;
});

ipcMain.handle('content:score', async (_e, content) => scoreContent(content));

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
