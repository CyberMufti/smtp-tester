/**
 * SOCKS proxy pool: scrape → validate → rotate.
 *
 * Emits SOCKS URL strings (socks5://user:pass@host:port or socks5://host:port)
 * that plug directly into:
 *   - SMTP  (`opts.proxy` on runBatch, via nodemailer + socks)
 *   - SSH   (`opts.proxyUrl` on runSSHChecks, via SocksClient)
 *
 * Scrape and validate accept injectable dependencies so tests never touch
 * the network. In production, defaults use node:https + SocksClient.
 *
 * Rotation is round-robin. Empty pool → getNext() returns null.
 *
 * @typedef {{ host: string, port: number, type: 4|5, user?: string, pass?: string }} ProxyEntry
 */
import https from 'node:https';
import fsDefault from 'node:fs';
import { SocksClient } from 'socks';

export const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
];

export const DEFAULT_VALIDATE_TARGET = { host: '1.1.1.1', port: 53 };
export const DEFAULT_VALIDATE_TIMEOUT = 3000;
export const DEFAULT_VALIDATE_CONCURRENCY = 50;

/**
 * Parse a raw line from a proxy list into a ProxyEntry, or null.
 * Accepts:
 *   ip:port
 *   ip:port:user:pass  (some lists use this for authenticated proxies)
 */
export function parseProxyLine(line, type = 5) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  const parts = s.split(':');
  if (parts.length < 2) return null;
  const host = parts[0].trim();
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const entry = { host, port, type };
  if (parts.length >= 4) {
    entry.user = parts[2];
    entry.pass = parts[3];
  }
  return entry;
}

/** Convert a ProxyEntry to a SOCKS URL string. */
export function proxyEntryToUrl(entry) {
  const scheme = entry.type === 4 ? 'socks4' : 'socks5';
  const auth = entry.user ? `${encodeURIComponent(entry.user)}:${encodeURIComponent(entry.pass || '')}@` : '';
  return `${scheme}://${auth}${entry.host}:${entry.port}`;
}

function defaultFetch(url, timeout = 10000) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, { timeout }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (data.length < 5_000_000) data += c; });
        res.on('end', () => resolve(data));
      });
    } catch { resolve(''); return; }
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

async function defaultCheck(proxyUrl, { target, timeout }) {
  try {
    const u = new URL(proxyUrl);
    const type = u.protocol.startsWith('socks4') ? 4 : 5;
    await SocksClient.createConnection({
      proxy: {
        host: u.hostname,
        port: Number(u.port) || 1080,
        type,
        userId: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      },
      command: 'connect',
      destination: target,
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

export class ProxyPool {
  /**
   * @param {{
   *   sources?: string[],
   *   validateTarget?: {host:string, port:number},
   *   validateTimeout?: number,
   *   validateConcurrency?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.sources = opts.sources || DEFAULT_SOURCES;
    this.validateTarget = opts.validateTarget || DEFAULT_VALIDATE_TARGET;
    this.validateTimeout = opts.validateTimeout || DEFAULT_VALIDATE_TIMEOUT;
    this.validateConcurrency = opts.validateConcurrency || DEFAULT_VALIDATE_CONCURRENCY;
    this.raw = [];
    this.valid = [];
    this.index = 0;
  }

  /**
   * Scrape proxy lists into `this.raw` (deduped).
   * @param {{ fetchFn?: (url: string) => Promise<string> }} [opts]
   * @returns {Promise<{ fetched: number, parsed: number, sources: number }>}
   */
  async scrape(opts = {}) {
    const fetchFn = opts.fetchFn || ((url) => defaultFetch(url));
    const seen = new Set();
    this.raw = [];
    let sourcesOk = 0;
    for (const src of this.sources) {
      const type = src.toLowerCase().includes('socks4') ? 4 : 5;
      const body = await fetchFn(src);
      if (!body) continue;
      sourcesOk++;
      for (const line of body.split(/\r?\n/)) {
        const entry = parseProxyLine(line, type);
        if (!entry) continue;
        const key = `${entry.type}:${entry.host}:${entry.port}:${entry.user || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.raw.push(entry);
      }
    }
    return { fetched: sourcesOk, parsed: this.raw.length, sources: this.sources.length };
  }

  /**
   * Validate every raw proxy; keep only the ones that pass.
   * @param {{
   *   checkFn?: (proxyUrl: string, opts: {target:any, timeout:number}) => Promise<boolean>,
   *   signal?: AbortSignal,
   * }} [opts]
   * @returns {Promise<{ tested: number, valid: number }>}
   */
  async validate(opts = {}) {
    const checkFn = opts.checkFn || defaultCheck;
    const target = this.validateTarget;
    const timeout = this.validateTimeout;
    const concurrency = Math.max(1, this.validateConcurrency);
    const maxProxies = Math.max(1, Number(opts.maxProxies) || 200);
    const onProgress = opts.onProgress;
    const input = this.raw.slice(0, maxProxies);
    const skipped = Math.max(0, this.raw.length - input.length);
    const results = new Array(input.length);
    let next = 0;
    let done = 0;

    async function worker() {
      while (next < input.length) {
        if (opts.signal?.aborted) return;
        const i = next++;
        const entry = input[i];
        const url = proxyEntryToUrl(entry);
        let ok = false;
        try { ok = await checkFn(url, { target, timeout }); } catch { ok = false; }
        results[i] = ok ? entry : null;
        done++;
        try { onProgress?.(done, input.length); } catch { /* ignore */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, worker));

    this.valid = results.filter(Boolean);
    this.index = 0;
    return { tested: input.length, valid: this.valid.length, skipped };
  }

  /**
   * Return the next valid proxy as a SOCKS URL (round-robin), or null if empty.
   * @returns {string|null}
   */
  getNext() {
    if (!this.valid.length) return null;
    const entry = this.valid[this.index];
    this.index = (this.index + 1) % this.valid.length;
    return proxyEntryToUrl(entry);
  }

  /** Random valid proxy URL, or null. */
  getRandom() {
    if (!this.valid.length) return null;
    return proxyEntryToUrl(this.valid[Math.floor(Math.random() * this.valid.length)]);
  }

  /** @returns {{ total: number, valid: number }} */
  size() {
    return { total: this.raw.length, valid: this.valid.length };
  }

  /**
   * Persist the current valid pool to disk. Never throws.
   * @param {string} filePath
   * @param {{ fs?: any }} [opts]
   * @returns {Promise<boolean>}
   */
  async save(filePath, opts = {}) {
    const fsm = opts.fs || fsDefault;
    try {
      const payload = { version: 1, scrapedAt: Date.now(), valid: this.valid };
      await fsm.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
      this.scrapedAt = payload.scrapedAt;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restore the pool from disk. Missing/corrupt file = empty pool. Never throws.
   * @param {string} filePath
   * @param {{ fs?: any }} [opts]
   * @returns {Promise<{ loaded: number, scrapedAt: number|null }>}
   */
  async load(filePath, opts = {}) {
    const fsm = opts.fs || fsDefault;
    try {
      const raw = await fsm.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.valid)) {
        this.valid = parsed.valid.filter((e) => e && e.host && e.port);
        this.index = 0;
        this.scrapedAt = parsed.scrapedAt || null;
        return { loaded: this.valid.length, scrapedAt: this.scrapedAt };
      }
    } catch { /* missing/corrupt → empty */ }
    this.valid = [];
    this.index = 0;
    this.scrapedAt = null;
    return { loaded: 0, scrapedAt: null };
  }

  /** Remove a proxy from the valid pool. Idempotent. Returns number removed. */
  markDead(proxyUrl) {
    const before = this.valid.length;
    this.valid = this.valid.filter((e) => proxyEntryToUrl(e) !== proxyUrl);
    this.index = this.valid.length > 0 ? this.index % this.valid.length : 0;
    return before - this.valid.length;
  }

  clear() {
    this.raw = [];
    this.valid = [];
    this.index = 0;
  }
}
