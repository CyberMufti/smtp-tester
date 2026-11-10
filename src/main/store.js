/**
 * Local settings persistence.
 *
 * The pure helpers (`defaultSettings`, `mergeSettings`) carry no Electron
 * dependency so they are unit-testable with `node --test`. The electron-store
 * instance is created lazily inside load/save, which only run inside the app.
 *
 * @typedef {import('../core/imap.js').Seed} Seed
 * @typedef {{
 *   concurrency:number, connectTimeout:number, sendTimeout:number,
 *   placementTimeoutMs:number, pollIntervalMs:number,
 *   from:string, subjectTemplate:string, bodyTemplate:string, seeds:Seed[],
 * }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    concurrency: 50,
    connectTimeout: 10000,
    sendTimeout: 15000,
    placementTimeoutMs: 90000,
    pollIntervalMs: 5000,
    from: '',
    rowCap: '500',
    proxy: { enabled: false, host: '', port: 1080, user: '', pass: '' },
    subjectTemplate: 'SMTP deliverability test {token}',
    bodyTemplate:
      'This is an automated SMTP deliverability test.\n\nToken: {token}\n\nYou can safely ignore this message.',
    htmlTemplate: '',
    seeds: [],
  };
}

/**
 * Overlay a partial patch onto settings without mutating the base and without
 * dropping keys the patch does not mention.
 * @param {Settings} base
 * @param {Partial<Settings>} patch
 * @returns {Settings}
 */
export function mergeSettings(base, patch) {
  return { ...base, ...(patch || {}) };
}

let storeInstance;

async function getStore() {
  if (!storeInstance) {
    const { default: Store } = await import('electron-store');
    storeInstance = new Store({ name: 'smtp-tester-settings' });
  }
  return storeInstance;
}

/** Load persisted settings merged over defaults. @returns {Promise<Settings>} */
export async function loadSettings() {
  const store = await getStore();
  return mergeSettings(defaultSettings(), store.get('settings') || {});
}

/** Persist a full settings object. @param {Settings} settings */
export async function saveSettings(settings) {
  const store = await getStore();
  // Fold the incoming patch over the CURRENTLY STORED settings (not just
  // defaults), so keys written by a separate path and not present in the
  // renderer payload — e.g. `hostMap` via hostmap:save — aren't clobbered.
  const base = mergeSettings(defaultSettings(), store.get('settings') || {});
  const merged = mergeSettings(base, settings);
  store.set('settings', merged);
  return merged;
}

/** Return the stored run-history summaries (newest first). */
export async function getRunHistory() {
  const store = await getStore();
  const h = store.get('runHistory');
  return Array.isArray(h) ? h : [];
}

/** Prepend a run summary and cap the history. Returns the new list. */
export async function saveRunSummary(summary, cap = 50) {
  const store = await getStore();
  const { pushHistory } = await import('../core/run-history.js');
  const next = pushHistory(await getRunHistory(), summary, cap);
  store.set('runHistory', next);
  return next;
}

/** Clear all stored run history. */
export async function clearRunHistory() {
  const store = await getStore();
  store.set('runHistory', []);
  return [];
}

/** Default health-monitor state (stored separately from settings). */
export function defaultMonitor() {
  return {
    enabled: false,
    intervalHours: 6,
    alertBotToken: '',
    alertChatId: '',
    creds: [],
    statuses: {},
    lastCheck: null,
  };
}

export async function getMonitor() {
  const store = await getStore();
  return { ...defaultMonitor(), ...(store.get('monitor') || {}) };
}

/** Merge a patch into the stored monitor state. */
export async function saveMonitor(patch) {
  const store = await getStore();
  const merged = { ...defaultMonitor(), ...(store.get('monitor') || {}), ...(patch || {}) };
  store.set('monitor', merged);
  return merged;
}

/** @returns {Promise<string|null>} the stored license key, if any */
export async function getLicenseKey() {
  const store = await getStore();
  return store.get('licenseKey') || null;
}

/** @param {string} key */
export async function setLicenseKey(key) {
  const store = await getStore();
  store.set('licenseKey', key);
}
