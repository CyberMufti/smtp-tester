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
    concurrency: 5,
    connectTimeout: 10000,
    sendTimeout: 15000,
    placementTimeoutMs: 90000,
    pollIntervalMs: 5000,
    from: '',
    subjectTemplate: 'SMTP deliverability test {token}',
    bodyTemplate:
      'This is an automated SMTP deliverability test.\n\nToken: {token}\n\nYou can safely ignore this message.',
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
  const merged = mergeSettings(defaultSettings(), settings);
  store.set('settings', merged);
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
