const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLicense: () => ipcRenderer.invoke('license:get'),
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testSeed: (seed) => ipcRenderer.invoke('seed:test', seed),
  testBatch: (creds, seeds, opts) => ipcRenderer.invoke('batch:run', { creds, seeds, opts }),
  cancel: () => ipcRenderer.invoke('batch:cancel'),
  exportResults: (results, format) => ipcRenderer.invoke('results:export', { results, format }),
  scoreContent: (content) => ipcRenderer.invoke('content:score', content),
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
