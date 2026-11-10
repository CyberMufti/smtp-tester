import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProxyPool,
  parseProxyLine,
  proxyEntryToUrl,
} from '../src/core/proxy_pool.js';

test('parseProxyLine handles ip:port', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:1080'), { host: '1.2.3.4', port: 1080, type: 5 });
});

test('parseProxyLine handles ip:port:user:pass', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:1080:alice:secret'), { host: '1.2.3.4', port: 1080, type: 5, user: 'alice', pass: 'secret' });
});

test('parseProxyLine respects socks4 type', () => {
  const r = parseProxyLine('1.2.3.4:1080', 4);
  assert.equal(r.type, 4);
});

test('parseProxyLine rejects junk', () => {
  assert.equal(parseProxyLine(''), null);
  assert.equal(parseProxyLine('# comment'), null);
  assert.equal(parseProxyLine('not a proxy'), null);
  assert.equal(parseProxyLine('1.2.3.4:99999'), null);
  assert.equal(parseProxyLine('1.2.3.4'), null);
});

test('proxyEntryToUrl formats bare and authed URLs', () => {
  assert.equal(proxyEntryToUrl({ host: 'h', port: 1080, type: 5 }), 'socks5://h:1080');
  assert.equal(proxyEntryToUrl({ host: 'h', port: 1080, type: 4 }), 'socks4://h:1080');
  assert.equal(
    proxyEntryToUrl({ host: 'h', port: 1080, type: 5, user: 'a b', pass: 'p@ss' }),
    'socks5://a%20b:p%40ss@h:1080',
  );
});

test('empty pool: getNext and getRandom return null', () => {
  const pool = new ProxyPool();
  assert.equal(pool.getNext(), null);
  assert.equal(pool.getRandom(), null);
  assert.deepEqual(pool.size(), { total: 0, valid: 0 });
});

test('scrape parses and dedupes lines from sources', async () => {
  const fetchFn = async (url) => {
    if (url.includes('socks5')) return '1.1.1.1:1080\n2.2.2.2:1080\n1.1.1.1:1080\n';
    if (url.includes('socks4')) return '3.3.3.3:1080\n';
    return '';
  };
  const pool = new ProxyPool({ sources: ['https://x/socks5.txt', 'https://x/socks4.txt'] });
  const res = await pool.scrape({ fetchFn });
  assert.equal(res.parsed, 3);
  assert.deepEqual(pool.size(), { total: 3, valid: 0 });
});

test('scrape tolerates failing sources', async () => {
  const fetchFn = async (url) => {
    if (url.includes('good')) return '1.1.1.1:1080\n';
    throw new Error('boom');
  };
  const pool = new ProxyPool({ sources: ['https://x/good.txt', 'https://x/bad.txt'] });
  const res = await pool.scrape({ fetchFn: async (u) => { try { return await fetchFn(u); } catch { return ''; } } });
  assert.equal(res.parsed, 1);
});

test('validate keeps only proxies the checker approves', async () => {
  const fetchFn = async () => '1.1.1.1:1080\n2.2.2.2:1080\n3.3.3.3:1080\n';
  const pool = new ProxyPool({ sources: ['https://x/socks5.txt'], validateConcurrency: 3 });
  await pool.scrape({ fetchFn });
  const checkFn = async (url) => url.includes('2.2.2.2');
  const res = await pool.validate({ checkFn });
  assert.equal(res.tested, 3);
  assert.equal(res.valid, 1);
  assert.deepEqual(pool.size(), { total: 3, valid: 1 });
});

test('validate({ merge:true }) tops up the pool without dropping existing proxies', async () => {
  const pool = new ProxyPool({ sources: ['https://x/socks5.txt'] });
  // Simulate an existing live pool (some proxies already validated earlier).
  pool.valid = [{ host: '9.9.9.9', port: 1080, type: 5 }];
  // Scrape a fresh batch that includes a new one and a duplicate of the existing.
  await pool.scrape({ fetchFn: async () => '2.2.2.2:1080\n9.9.9.9:1080\n' });
  const res = await pool.validate({ checkFn: async () => true, merge: true });
  assert.equal(res.added, 1, 'only the new proxy is added');
  const hosts = pool.valid.map((e) => e.host).sort();
  assert.deepEqual(hosts, ['2.2.2.2', '9.9.9.9'], 'existing kept, new merged, dup deduped');
});

test('validate treats checker exceptions as failures', async () => {
  const fetchFn = async () => '1.1.1.1:1080\n';
  const pool = new ProxyPool({ sources: ['https://x/socks5.txt'] });
  await pool.scrape({ fetchFn });
  const checkFn = async () => { throw new Error('checker boom'); };
  const res = await pool.validate({ checkFn });
  assert.equal(res.valid, 0);
});

test('getNext round-robins through the valid pool', async () => {
  const fetchFn = async () => '1.1.1.1:1080\n2.2.2.2:1080\n';
  const pool = new ProxyPool({ sources: ['https://x/socks5.txt'] });
  await pool.scrape({ fetchFn });
  await pool.validate({ checkFn: async () => true });
  const first = pool.getNext();
  const second = pool.getNext();
  const third = pool.getNext();
  assert.notEqual(first, second);
  assert.equal(third, first);
});

test('clear resets raw and valid', async () => {
  const fetchFn = async () => '1.1.1.1:1080\n';
  const pool = new ProxyPool({ sources: ['https://x/socks5.txt'] });
  await pool.scrape({ fetchFn });
  await pool.validate({ checkFn: async () => true });
  pool.clear();
  assert.deepEqual(pool.size(), { total: 0, valid: 0 });
  assert.equal(pool.getNext(), null);
});

test('save/load roundtrip preserves valid proxies and scrapedAt', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const tmpPath = path.join(os.tmpdir(), 'proxy-pool-test-' + Date.now() + '.json');
  try {
    const pool = new ProxyPool();
    pool.valid = [
      { host: '1.1.1.1', port: 1080, type: 5 },
      { host: '2.2.2.2', port: 1080, type: 5, user: 'u', pass: 'p' },
    ];
    const saved = await pool.save(tmpPath);
    assert.equal(saved, true);
    assert.ok(pool.scrapedAt > 0);

    const pool2 = new ProxyPool();
    const loaded = await pool2.load(tmpPath);
    assert.equal(loaded.loaded, 2);
    assert.equal(pool2.valid.length, 2);
    assert.equal(pool2.valid[0].host, '1.1.1.1');
    assert.equal(pool2.valid[1].user, 'u');
    assert.ok(pool2.scrapedAt > 0);
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
});

test('load on missing file is a no-op (empty pool, no throw)', async () => {
  const pool = new ProxyPool();
  const res = await pool.load('/nonexistent/path-' + Date.now() + '.json');
  assert.equal(res.loaded, 0);
  assert.equal(pool.valid.length, 0);
  assert.equal(pool.scrapedAt, null);
});

test('load on corrupt file is a no-op (empty pool, no throw)', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const tmpPath = path.join(os.tmpdir(), 'proxy-pool-corrupt-' + Date.now() + '.json');
  try {
    await fs.promises.writeFile(tmpPath, 'not valid json {{{', 'utf8');
    const pool = new ProxyPool();
    const res = await pool.load(tmpPath);
    assert.equal(res.loaded, 0);
    assert.equal(pool.valid.length, 0);
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
});
