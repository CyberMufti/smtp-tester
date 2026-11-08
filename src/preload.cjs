const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLicense: () => ipcRenderer.invoke('license:get'),
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testSeed: (seed) => ipcRenderer.invoke('seed:test', seed),
  auditServer: (host, port) => ipcRenderer.invoke('audit:server', { host, port }),
  checkCpanel: (targets, opts) => ipcRenderer.invoke('cpanel:check', { targets, opts }),
  onCpanelProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('cpanel:progress', handler);
    return () => ipcRenderer.removeListener('cpanel:progress', handler);
  },
  checkWebmail: (targets, opts) => ipcRenderer.invoke('webmail:check', { targets, opts }),
  onWebmailProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('webmail:progress', handler);
    return () => ipcRenderer.removeListener('webmail:progress', handler);
  },
  checkWhm: (targets, opts) => ipcRenderer.invoke('whm:check', { targets, opts }),
  onWhmProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('whm:progress', handler);
    return () => ipcRenderer.removeListener('whm:progress', handler);
  },
  checkSsh: (targets, opts) => ipcRenderer.invoke('ssh:check', { targets, opts }),
  checkSmtp: (creds, opts) => ipcRenderer.invoke('smtp:check', { creds, opts }),
  onComboProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('combo:progress', handler);
    return () => ipcRenderer.removeListener('combo:progress', handler);
  },
  mxResolve: (domains) => ipcRenderer.invoke('smtp:mxResolve', { domains }),
  scrapeProxies: () => ipcRenderer.invoke('proxy:scrape'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  clearProxies: () => ipcRenderer.invoke('proxy:clear'),
  onProxyProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('proxy:progress', handler);
    return () => ipcRenderer.removeListener('proxy:progress', handler);
  },
  onSshProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:progress', handler);
    return () => ipcRenderer.removeListener('ssh:progress', handler);
  },
  auditHygiene: (filePath, breachFilePath) => ipcRenderer.invoke('hygiene:auditFile', { filePath, breachFilePath }),
  testBatch: (creds, seeds, opts) => ipcRenderer.invoke('batch:run', { creds, seeds, opts }),
  // Resolve a dropped/picked File to its absolute path (Electron 32+ removed
  // File.path in favor of webUtils.getPathForFile).
  getFilePath: (file) => webUtils.getPathForFile(file),
  countFile: (filePath) => ipcRenderer.invoke('creds:countFile', filePath),
  testBatchFile: (filePath, seeds, opts, resume, preDeduped) =>
    ipcRenderer.invoke('batch:runFile', { filePath, seeds, opts, resume, preDeduped }),
  runProgress: () => ipcRenderer.invoke('run:progress'),
  cancel: () => ipcRenderer.invoke('batch:cancel'),
  exportRun: (format) => ipcRenderer.invoke('results:exportRun', { format }),
  scoreContent: (content) => ipcRenderer.invoke('content:score', content),
  checkEmailAuth: (request) => ipcRenderer.invoke('auth:check', request),
  getAuthStatus: () => ipcRenderer.invoke('auth:status'),
  onAuthStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('auth:status', handler);
    return () => ipcRenderer.removeListener('auth:status', handler);
  },
  getMonitor: () => ipcRenderer.invoke('monitor:get'),
  saveMonitor: (patch) => ipcRenderer.invoke('monitor:save', patch),
  setMonitorCreds: (creds) => ipcRenderer.invoke('monitor:setCreds', creds),
  checkMonitorNow: () => ipcRenderer.invoke('monitor:checkNow'),
  onMonitorChecked: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('monitor:checked', handler);
    return () => ipcRenderer.removeListener('monitor:checked', handler);
  },
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('batch:progress', handler);
    return () => ipcRenderer.removeListener('batch:progress', handler);
  },
  onDone: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('batch:done', handler);
    return () => ipcRenderer.removeListener('batch:done', handler);
  },
});
