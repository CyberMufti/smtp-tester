import { parse, dedupeCredentials } from '../core/parser.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let settings = null;
let parsed = { records: [], errors: [] };
let runTotal = 0;
let activeFilter = 'all';
let running = false;

// Results are streamed to disk in the main process (bounded memory), so the
// renderer keeps only what it needs to paint the UI: O(1) running counts, the
// first content spam score, and the newest few thousand results for the table.
// Filtering/paging operates over this retained window; exports read the full
// run file from disk, so every result is still accounted for.
const MAX_RECENT = 5000;
// The paste box and the FileReader fallback both hold their whole content in
// renderer memory and parse it on the UI thread, so a huge payload freezes the
// window. Above this size we refuse that path and point at the file picker,
// which streams from disk. Delimited files go through the picker and never hit
// this; only pasted text and non-delimited fallback files do.
const MAX_INLINE_BYTES = 8_000_000; // ~8 MB
let counts = {};
let testedCount = 0;
let recent = [];
let firstSpamScore = null;

function resetRunState() {
  counts = {};
  testedCount = 0;
  recent = [];
  firstSpamScore = null;
}

// ---------- Tabs ----------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.screen').forEach((s) => s.classList.remove('active'));
    $(`#screen-${tab.dataset.tab}`).classList.add('active');
  });
});

// ---------- Credential input / parsing ----------
const credsInput = $('#creds-input');

// When a big lead file is picked we stream it from disk by path instead of
// loading its (hundreds of MB of) text into this textarea and parsing it on the
// UI thread. `loadedFile` holds that selection; typing in the box cancels it so
// the pasted text takes over again.
let loadedFiles = []; // Array of { path, name, count, parsedPath }

credsInput.addEventListener('input', () => {
  loadedFiles = [];
  refreshParse();
  refreshResumeButton();
});

$('#file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  
  loadedFiles = [];
  let totalCount = 0;
  const errors = [];
  
  $('#parse-count').textContent = 'Reading ' + files.length + ' file(s)…';
  $('#parse-errors').textContent = '';
  
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024 * 1024) {
      errors.push(file.name + ' exceeds 10GB limit');
      continue;
    }
    const path = api.getFilePath?.(file);
    if (!path) {
      errors.push(file.name + ': path unavailable');
      continue;
    }
    
    try {
      const res = await api.countFile(path);
      if (!res.count) {
        errors.push(file.name + ': no valid credentials');
        continue;
      }
      loadedFiles.push({ path, name: file.name, count: res.count, parsedPath: res.parsedPath });
      totalCount += res.count;
    } catch (err) {
      errors.push(file.name + ': ' + err.message);
    }
  }
  
  if (!loadedFiles.length) {
    $('#parse-count').textContent = 'No valid files loaded';
    $('#parse-errors').textContent = errors.join(' | ');
    return;
  }
  
  credsInput.value = '';
  $('#parse-count').textContent = loadedFiles.length + ' file(s) — ' + totalCount.toLocaleString() + ' total credentials';
  $('#parse-errors').textContent = errors.length ? errors.join(' | ') : '';
  refreshResumeButton();
});

function readFileIntoTextarea(file) {
  loadedFiles = [];
  if (file.size > MAX_INLINE_BYTES) {
    $('#parse-count').textContent = `${file.name} is too large to open here (${Math.round(file.size / 1e6)} MB).`;
    $('#parse-errors').textContent =
      'This file isn’t in host:port:user:pass form, so it would load into the editor and freeze the window. Convert it to delimited lines to stream it from disk.';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    credsInput.value = String(reader.result);
    refreshParse();
  };
  reader.readAsText(file);
}

function refreshParse() {
  // Guard the UI thread: parsing a very large pasted blob would freeze it.
  if (credsInput.value.length > MAX_INLINE_BYTES) {
    parsed = { records: [], errors: [] };
    $('#parse-count').textContent = 'Pasted text is too large for this box.';
    $('#parse-errors').textContent =
      'Save it as a .txt file and use “Choose file” — large lists stream from disk instead of freezing the window.';
    return;
  }
  parsed = parse(credsInput.value);
  $('#parse-count').textContent =
    `${parsed.records.length} credential${parsed.records.length === 1 ? '' : 's'}`;
  const errEl = $('#parse-errors');
  if (parsed.errors.length) {
    errEl.textContent = `${parsed.errors.length} line${parsed.errors.length === 1 ? '' : 's'} skipped (e.g. line ${parsed.errors[0].line}: ${parsed.errors[0].reason})`;
  } else {
    errEl.textContent = '';
  }
}

// ---------- Run / cancel ----------
$('#btn-run').addEventListener('click', runBatch);
$('#btn-cancel').addEventListener('click', () => {
  $('#btn-cancel').textContent = 'Cancelling...';
  $('#btn-cancel').disabled = true;
  api.cancel();
});

function buildRunOpts() {
  const manualRecipients = $('#manual-recipients').value
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    concurrency: Number($('#opt-concurrency').value) || 50,
    maxPerSec: Math.max(0, Number($('#opt-maxrate').value) || 0),
    // Honest backpressure: when the server returns a rate-limit response, every
    // worker waits this long before starting another test.
    rateLimitCooldownMs: 5000,
    connectTimeout: (settings?.connectTimeout) || 3000,
    sendTimeout: (settings?.sendTimeout) || 15000,
    placementTimeoutMs: (Number($('#opt-timeout').value) || 90) * 1000,
    pollIntervalMs: (settings?.pollIntervalMs) || 5000,
    from: settings?.from || '',
    subjectTemplate: settings?.subjectTemplate,
    bodyTemplate: settings?.bodyTemplate,
    htmlTemplate: settings?.htmlTemplate,
    manualRecipients,
    checks: $('#opt-checks').checked
      ? { authRecords: true, dnsbl: true, spamScore: true }
      : null,
    proxyConfig: settings?.proxy,
    protocols: $('#opt-protocols')?.value || 'smtp',
    maxCandidates: 2,
    enableMutations: $('#opt-mutations')?.checked || false,
    retries: 0,
    retryBackoffMs: 2000,
  };
}

function startRunUI() {
  running = true;
  resetRunState();
  renderResults();
  setRunning(true);
  $('#progress-bar').hidden = false;
  $('#progress-fill').style.width = '0%';
}

async function runBatch() {
  if (running) return;
  // A file selection streams from disk; a pasted list tests the parsed records.
  if (loadedFiles.length > 0) return runFileBatch();

  refreshParse();
  if (!parsed.records.length) {
    $('#parse-errors').textContent = 'Nothing to test — add at least one valid credential.';
    return;
  }
  startRunUI();

  const { records: creds, removed } = dedupeCredentials(parsed.records);
  
  if (creds.length > 2000) {
    $('#parse-errors').textContent = 'Warning: Testing a large pasted list may freeze the UI for a minute while it sends data. For fast processing, save it as a .txt file and use "Load File" instead.';
  }

  runTotal = creds.length;
  if (removed) {
    $('#parse-errors').textContent = `${removed} duplicate${removed === 1 ? '' : 's'} removed — testing ${creds.length}.`;
  }

  $('#progress-label').textContent = `0 / ${runTotal}`;

  try {
    await api.testBatch(creds, settings?.seeds || [], buildRunOpts());
  } catch (err) {
    $('#parse-errors').textContent = `Run failed: ${err.message}`;
  } finally {
    setRunning(false);
    running = false;
  }
}

async function runFileBatch(isResume = false) {
  if (loadedFiles.length === 0) return;
  startRunUI();
  
  runTotal = loadedFiles.reduce((sum, f) => sum + f.count, 0);
  
  if (isResume) {
    const prior = await api.runProgress();
    counts = { ...prior.counts };
    testedCount = prior.total;
    renderSummary();
  }
  $('#progress-label').textContent = testedCount + ' / ' + runTotal;
  
  try {
    let first = true;
    for (const f of loadedFiles) {
      if (!running) break;
      const runPath = f.parsedPath || f.path;
      const preDeduped = !!f.parsedPath;
      const resumeFlag = (first && !isResume) ? false : true;
      await api.testBatchFile(runPath, settings?.seeds || [], buildRunOpts(), resumeFlag, preDeduped);
      first = false;
    }
  } catch (err) {
    $('#parse-errors').textContent = 'Run failed: ' + err.message;
  } finally {
    setRunning(false);
    running = false;
    refreshResumeButton();
  }
}

// Show "Resume last run" only when a file is loaded and a prior run exists on disk.
async function refreshResumeButton() {
  const btn = $('#btn-resume');
  if (!btn) return;
  if (running || loadedFiles.length === 0) {
    btn.hidden = true;
    return;
  }
  const prior = await api.runProgress();
  btn.hidden = !(prior && prior.total > 0);
  if (!btn.hidden) btn.textContent = `Resume last run (${prior.total.toLocaleString()} done)`;
}

$('#btn-resume').addEventListener('click', () => {
  if (running || !loadedFile) return;
  runFileBatch(true);
});

function setRunning(on) {
  $('#btn-run').disabled = on;
  $('#btn-cancel').disabled = !on;
  if (!on) $('#btn-cancel').textContent = 'Cancel';
  const noResults = testedCount === 0;
  $('#btn-export-csv').disabled = on || noResults;
  $('#btn-export-json').disabled = on || noResults;
  // TXT export holds only working (non-dead) credentials.
  const working = testedCount - (counts.dead || 0);
  $('#btn-export-txt').disabled = on || working <= 0;
  const pe = $('#btn-export-protocols');
  if (pe) pe.disabled = on || testedCount === 0;
}

// Cap how many rows live in the DOM so very large runs stay snappy. Counts come
// from the running totals and exports read the full run file from disk, so the
// table is just a live window. Even "all" is clamped to the retained buffer —
// we never keep millions of rows (or results) in the renderer.
function currentRowCap() {
  const v = $('#opt-rowcap')?.value;
  return v === 'all' ? Infinity : Number(v) || 500;
}

function displayCap() {
  return Math.min(currentRowCap(), MAX_RECENT);
}

$('#opt-rowcap').addEventListener('change', renderResults);

api.onProgress(({ result }) => {
  testedCount++;
  counts[result.status] = (counts[result.status] || 0) + 1;
  if (!firstSpamScore && result.spamScore) firstSpamScore = result.spamScore;
  // Retain only the newest window for the table; trim in bulk so this stays
  // amortized O(1) even across millions of results.
  recent.push(result);
  if (recent.length > MAX_RECENT * 1.2) recent = recent.slice(-MAX_RECENT);

  $('#progress-label').textContent = `${testedCount} / ${runTotal}`;
  const fill = $('#progress-fill');
  if (fill) fill.style.width = `${runTotal ? Math.round((testedCount / runTotal) * 100) : 0}%`;
  renderSummary();
  renderContentScoreBanner();
  renderRowsNote();
  // Append just this row instead of rebuilding the whole table — rebuilding on
  // every result is O(n^2) and freezes/crashes the window on large batches.
  appendResultRow(result);
});

function appendResultRow(r) {
  if (!(activeFilter === 'all' || r.status === activeFilter)) return;
  const body = $('#results-body');
  const empty = body.querySelector('.empty-row');
  if (empty) empty.remove();
  body.insertAdjacentHTML('beforeend', rowHtml(r));
  // Keep only the newest N rows in the DOM.
  const cap = displayCap();
  while (body.children.length > cap) body.removeChild(body.firstElementChild);
}

function renderRowsNote() {
  const el = $('#rows-note');
  if (!el) return;
  const shown = Math.min(recent.length, displayCap());
  el.textContent =
    testedCount > shown
      ? `Showing the newest ${shown} rows of ${testedCount} — all ${testedCount} are included in exports and the counts above.`
      : '';
}
api.onDone(() => {
  $('#progress-label').textContent = `${testedCount} tested`;
  $('#progress-fill').style.width = '100%';
});

// ---------- Results table ----------
$('#filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-filter');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  $$('.chip-filter').forEach((c) => c.classList.toggle('active', c === btn));
  renderResults();
});

function renderResults() {
  renderSummary();
  renderContentScoreBanner();
  renderRowsNote();
  const body = $('#results-body');
  // Filtering/paging works over the retained window of recent results.
  const rows = recent.filter((r) => activeFilter === 'all' || r.status === activeFilter);
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${
      testedCount ? 'No results match this filter in the recent window.' : 'No results yet. Paste credentials and click <b>Test All</b>.'
    }</td></tr>`;
    return;
  }
  // Render only the newest N matching rows to keep the DOM light.
  body.innerHTML = rows.slice(-displayCap()).map(rowHtml).join('');
}

const SUMMARY_ORDER = [
  ['inbox', 'Inbox'],
  ['spam', 'Spam'],
  ['valid', 'Valid'],
  ['unknown', 'Unknown'],
  ['dead', 'Dead'],
];

function renderSummary() {
  const el = $('#summary');
  if (!testedCount) {
    el.innerHTML = '';
    return;
  }
  const chips = SUMMARY_ORDER.map(
    ([key, label]) =>
      `<span class="summary-chip status-${key}">${label}: ${counts[key] || 0}</span>`,
  ).join('');
  el.innerHTML = `${chips}<span class="summary-chip summary-total">Total: ${testedCount}</span>`;
}

function renderContentScoreBanner() {
  const el = $('#content-score-banner');
  const s = firstSpamScore;
  if (!s) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    `<span class="score-badge score-${s.level}">Content spam score: ${s.score}/${s.max} (${s.level})</span>` +
    (s.reasons.length ? `<span class="note"> — ${esc(s.reasons.join('; '))}</span>` : ' — looks clean');
}

function rowHtml(r) {
  const parts = [];

  const seedDetail = (r.perSeed || [])
    .map((s) => `<span class="seed-tag">${esc(s.label)}: <b>${s.error ? 'error' : s.folder || 'not found'}</b></span>`)
    .join('');
  if (seedDetail) parts.push(seedDetail);
  else if (r.reason) parts.push(esc(r.reason));

  // Account-existence verdict (only present when a server refused the login).
  if (r.catchAll) parts.push('<span class="dbadge b-neutral">catch-all domain</span>');
  if (r.userDoesNotExist) parts.push('<span class="dbadge b-bad">user does not exist (skipped)</span>');
  if (r.userExists === false) parts.push('<span class="dbadge b-bad">account not found</span>');
  else if (r.userExists === true) parts.push('<span class="dbadge b-ok">account exists</span>');

  if (r.mutationUsed) parts.push('<span class="dbadge b-ok" style="background:#d97706">mutated: ' + esc(r.mutationUsed) + '</span>');
    if (r.proxyFallback) {
    const dying = r.proxyThatDied ? ' (' + String(r.proxyThatDied).replace(/^socks[45]:\/\//, '').split('@').pop() + ')' : '';
    parts.push('<span class="dbadge b-neutral">dead proxy — retried direct' + dying + '</span>');
  }

  if (r.triedFallback && r.usedHost) {
    parts.push(`<span class="note">↳ connected via <b>${esc(r.usedHost)}:${esc(r.usedPort)}</b> (auto-detected)</span>`);
  }
  if (r.manualRecipients && r.manualRecipients.length && (r.status === 'valid' || r.status === 'inbox' || r.status === 'spam')) {
    parts.push(
      `<span class="note">✉ Check ${esc(r.manualRecipients.join(', '))} for subject containing <b class="mono">${esc(r.token)}</b></span>`,
    );
  }
  if (r.selfSendOnly) {
    parts.push(
      '<span class="dbadge b-neutral">self-send only</span>' +
      '<span class="note">⚠ Sent to the account itself — external delivery not verified. Add a seed mailbox or manual recipient to confirm inbox/spam placement.</span>',
    );
  }

  if ((r.status === 'dead' || r.status === 'unknown') && r.attempts && r.attempts.length) {
    const list = r.attempts
      .map((a) => `${esc(a.host)}:${esc(a.port)} — ${esc(a.outcome)}`)
      .join('<br>');
    parts.push(
      `<details class="tried"><summary>Tried ${r.attempts.length} endpoint${r.attempts.length === 1 ? '' : 's'}</summary>${list}</details>`,
    );
  }

  if (r.panels) {
    const p = r.panels;
    const b = (k, v) => {
      if (!v) return '';
      if (v.error) return '<span class="dbadge b-bad" title="' + esc(v.error) + '">' + k + '!</span>';
      if (v.valid) return '<span class="dbadge b-ok">' + k + '✓</span>';
      if (v.reachable === false) return '<span class="dbadge b-neutral">' + k + '-</span>';
      return '<span class="dbadge b-bad">' + k + '✗</span>';
    };
    let domainBadge = '';
    if (p.cpanel && p.cpanel.valid && p.cpanel.domains && p.cpanel.domains.length > 0) {
      domainBadge = '<span class="dbadge b-ok">' + p.cpanel.domains.length + ' domains</span> ';
    }
    parts.push('<span class="badges">' + domainBadge + b('CP', p.cpanel) + ' ' + b('WM', p.webmail) + ' ' + b('WHM', p.whm) + ' ' + b('SSH', p.ssh) + ' ' + b('IMAP', p.imap) + ' ' + b('POP3', p.pop3) + ' ' + b('PLESK', p.plesk) + ' ' + b('DA', p.directadmin) + '</span>');
  }
  const deliv = deliverabilityBadges(r);
  if (deliv) parts.push(deliv);
  const seedAuth = (r.perSeed || [])
    .filter((s) => s.auth)
    .map((s) => `<span class="note">${esc(s.label)} auth: ${authBadges(s.auth)}</span>`)
    .join(' ');
  if (seedAuth) parts.push(seedAuth);

  // Show the endpoint that worked; if nothing authenticated, show the host it
  // actually reached (e.g. the provider server that refused the login) rather
  // than a bare "auto-detect".
  const ep = reachedEndpoint(r);
  const host = `${ep.host}${ep.auto ? ' (auto)' : ''}`;
  return `<tr>
    <td class="mono">${esc(host)}${ep.port ? ':' + esc(ep.port) : ''}</td>
    <td class="mono">${esc(r.cred.user)}</td>
    <td><span class="status-chip status-${r.status}">${statusLabel(r.status)}</span></td>
    <td>${r.latencyMs} ms</td>
    <td class="detail">${parts.join('<br>')}</td>
  </tr>`;
}

function statusLabel(s) {
  return s === 'unknown' ? 'unknown placement' : s;
}

// Pick the host/port to show in the table: the one that worked, else the one
// the app actually reached (an auth-rejected server is most informative).
function reachedEndpoint(r) {
  if (r.usedHost) return { host: r.usedHost, port: r.usedPort, auto: !r.cred.host || r.triedFallback };
  if (r.cred.host) return { host: r.cred.host, port: r.cred.port, auto: false };
  const attempts = r.attempts || [];
  const pick = attempts.find((a) => /auth rejected/i.test(a.outcome)) || attempts[attempts.length - 1];
  if (pick) return { host: pick.host, port: pick.port, auto: true };
  return { host: 'auto-detect', port: '', auto: false };
}

function badge(label, ok, detail) {
  const cls = ok === true ? 'b-ok' : ok === false ? 'b-bad' : 'b-neutral';
  return `<span class="dbadge ${cls}">${esc(label)}${detail ? ': ' + esc(detail) : ''}</span>`;
}

function deliverabilityBadges(r) {
  const d = r.deliverability;
  if (!d) return '';
  const out = [];
  if (d.spf) out.push(badge('SPF', d.spf.found ? (d.spf.all === '-all' || d.spf.all === '~all') : false, d.spf.found ? d.spf.all || 'set' : 'missing'));
  if (d.dmarc) out.push(badge('DMARC', d.dmarc.found ? d.dmarc.policy !== 'none' : false, d.dmarc.found ? d.dmarc.policy : 'missing'));
  if (d.dnsbl) out.push(badge('Blacklist', !d.dnsbl.listed, d.dnsbl.error ? 'n/a' : d.dnsbl.listed ? d.dnsbl.lists.join(', ') : 'clean'));
  return out.length ? `<span class="badges">${out.join(' ')}</span>` : '';
}

function authBadges(a) {
  return ['spf', 'dkim', 'dmarc']
    .filter((k) => a[k])
    .map((k) => `${k}=${a[k]}`)
    .join(' ');
}

// ---------- Export ----------
$('#btn-export-txt').addEventListener('click', () => doExport('txt'));
$('#btn-export-csv').addEventListener('click', () => doExport('csv'));
$('#btn-export-json').addEventListener('click', () => doExport('json'));
$('#btn-export-protocols')?.addEventListener('click', async () => {
  const res = await api.exportByProtocol();
  if (res.error) {
    $('#progress-label').textContent = 'Export failed: ' + res.error;
  } else {
    $('#progress-label').textContent = 'Saved ' + res.count + ' files to ' + res.folder;
  }
});
async function doExport(format) {
  const res = await api.exportRun(format);
  if (res.saved) $('#progress-label').textContent = `Saved to ${res.path}`;
}

// ---------- Settings ----------
const seedsList = $('#seeds-list');
$('#btn-add-seed').addEventListener('click', () => addSeedRow({}));
$('#btn-save-settings').addEventListener('click', saveSettings);
$('#btn-save-proxy').addEventListener('click', async () => {
  settings = await api.saveSettings(collectSettings());
  $('#proxy-save-status').textContent = settings.proxy?.enabled ? 'Saved ✓ (proxy on)' : 'Saved ✓ (proxy off)';
  setTimeout(() => ($('#proxy-save-status').textContent = ''), 2500);
});

// ---------- Proxy pool scraper ----------
$('#btn-proxy-scrape').addEventListener('click', async () => {
  const status = $('#proxy-pool-status');
  const btn = $('#btn-proxy-scrape');
  btn.disabled = true;
  status.textContent = 'Scraping proxy lists…';
  const off = api.onProxyProgress?.((p) => {
    const poolEl = $('#proxy-pool-status');
    if (p.phase === 'daemon-start' && poolEl) { poolEl.textContent = '⚠️ Proxies running low. Auto-scraping 5,000...'; return; }
    if (p.phase === 'daemon-done' && poolEl) { poolEl.textContent = '✅ Daemon refilled pool: ' + p.valid + ' live proxies.'; return; }
    
    if (p.phase === 'scraped') status.textContent = 'Scraped ' + p.parsed + ' proxies. Validating first 5000…';
    if (p.phase === 'scraped') status.textContent = 'Scraped ' + p.parsed + ' proxies. Validating first 200…';
    else if (p.phase === 'validating') status.textContent = 'Validating… ' + p.done + '/' + p.total;
  });
  try {
    const rep = await api.scrapeProxies();
    if (rep.error) {
      status.textContent = 'Scrape failed: ' + rep.error;
    } else {
      const skipNote = rep.skipped > 0 ? ' — skipped ' + rep.skipped + ' (cap 200)' : '';
      status.textContent = 'Pool: ' + rep.valid + ' valid / ' + rep.tested + ' tested (' + rep.parsed + ' raw)' + skipNote;
    }
  } finally {
    off?.();
    btn.disabled = false;
  }
});

$('#btn-proxy-clear').addEventListener('click', async () => {
  const status = $('#proxy-pool-status');
  const rep = await api.clearProxies();
  status.textContent = 'Pool cleared (' + (rep.size?.valid ?? 0) + ' remaining)';
});

function addSeedRow(seed) {
  const tpl = $('#seed-row-tpl').content.cloneNode(true);
  const card = tpl.querySelector('.seed-card');
  for (const [k, v] of Object.entries(seed)) {
    const input = card.querySelector(`[data-f="${k}"]`);
    if (input) input.value = v;
  }
  card.querySelector('.btn-remove-seed').addEventListener('click', () => card.remove());
  card.querySelector('.btn-test-seed').addEventListener('click', () => testSeedRow(card));
  seedsList.appendChild(card);
}

function readSeedRow(card) {
  const seed = {};
  card.querySelectorAll('[data-f]').forEach((input) => {
    const key = input.dataset.f;
    seed[key] = key === 'imapPort' ? Number(input.value) : input.value.trim();
  });
  return seed;
}

async function testSeedRow(card) {
  const out = card.querySelector('.seed-test-result');
  out.textContent = 'Testing…';
  out.className = 'seed-test-result muted';
  const res = await api.testSeed(readSeedRow(card));
  if (res.ok) {
    out.textContent = `OK — ${res.folders.length} folders found`;
    out.className = 'seed-test-result ok';
  } else {
    out.textContent = `Failed: ${res.error}`;
    out.className = 'seed-test-result bad';
  }
}

function collectSettings() {
  return {
    ...settings,
    from: $('#set-from').value.trim(),
    subjectTemplate: $('#set-subject').value,
    bodyTemplate: $('#set-body').value,
    htmlTemplate: $('#set-html').value,
    connectTimeout: (Number($('#set-connect-timeout').value) || 10) * 1000,
    sendTimeout: (Number($('#set-send-timeout').value) || 15) * 1000,
    pollIntervalMs: (Number($('#set-poll').value) || 5) * 1000,
    concurrency: Number($('#opt-concurrency').value) || 5,
    placementTimeoutMs: (Number($('#opt-timeout').value) || 90) * 1000,
    rowCap: $('#opt-rowcap').value,
    proxy: {
      enabled: $('#proxy-enabled').checked,
      host: $('#proxy-host').value.trim(),
      port: Number($('#proxy-port').value) || 1080,
      user: $('#proxy-user').value.trim(),
      pass: $('#proxy-pass').value,
    },
    seeds: $$('.seed-card').map(readSeedRow),
  };
}

async function saveSettings() {
  settings = await api.saveSettings(collectSettings());
  $('#save-status').textContent = 'Saved ✓';
  updateSeedNote();
  setTimeout(() => ($('#save-status').textContent = ''), 2000);
}

function updateSeedNote() {
  const n = settings?.seeds?.length || 0;
  $('#seed-note').textContent = n
    ? `${n} seed mailbox${n === 1 ? '' : 'es'} — placement enabled`
    : 'No seeds — reports Dead / Valid only';
}

function applySettingsToForm() {
  $('#set-from').value = settings.from || '';
  $('#set-subject').value = settings.subjectTemplate || '';
  $('#set-body').value = settings.bodyTemplate || '';
  $('#set-html').value = settings.htmlTemplate || '';
  $('#set-connect-timeout').value = Math.round((settings.connectTimeout || 10000) / 1000);
  $('#set-send-timeout').value = Math.round((settings.sendTimeout || 15000) / 1000);
  $('#set-poll').value = Math.round((settings.pollIntervalMs || 5000) / 1000);
  $('#opt-concurrency').value = settings.concurrency || 5;
  $('#opt-timeout').value = Math.round((settings.placementTimeoutMs || 90000) / 1000);
  $('#opt-rowcap').value = settings.rowCap || '500';
  const px = settings.proxy || {};
  $('#proxy-enabled').checked = !!px.enabled;
  $('#proxy-host').value = px.host || '';
  $('#proxy-port').value = px.port || 1080;
  $('#proxy-user').value = px.user || '';
  $('#proxy-pass').value = px.pass || '';
  seedsList.innerHTML = '';
  (settings.seeds || []).forEach(addSeedRow);
  updateSeedNote();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Content scorer ----------
$('#btn-score').addEventListener('click', async () => {
  const body = $('#score-body').value;
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  const s = await api.scoreContent({
    subject: $('#score-subject').value,
    text: isHtml ? '' : body,
    html: isHtml ? body : '',
  });
  const el = $('#score-result');
  const reasons = s.reasons.length
    ? `<ul>${s.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '<p class="muted">No obvious spam signals found.</p>';
  el.innerHTML = `<span class="score-badge score-${s.level}">Score: ${s.score}/${s.max} (${s.level})</span>${reasons}`;
});

// ---------- Server security audit ----------
$('#btn-audit-scan').addEventListener('click', async () => {
  const host = $('#audit-host').value.trim();
  const out = $('#audit-result');
  if (!host) {
    out.innerHTML = '<p class="err-text">Enter the host of a server you operate.</p>';
    return;
  }
  const port = Number($('#audit-port').value) || 587;
  out.innerHTML = '<p class="muted">Scanning…</p>';
  const rep = await api.auditServer(host, port);
  if (rep.error) {
    out.innerHTML = `<p class="err-text">Scan failed: ${esc(rep.error)}</p>`;
    return;
  }
  const highs = rep.findings.filter((f) => f.severity === 'high').length;
  const badge = highs
    ? `<span class="score-badge score-high">${highs} issue${highs === 1 ? '' : 's'} found</span>`
    : '<span class="score-badge score-low">No transport-security issues</span>';
  const items = rep.findings
    .map((f) => `<li><span class="dbadge b-${f.severity === 'high' ? 'bad' : f.severity === 'info' ? 'neutral' : 'ok'}">${esc(f.severity)}</span> ${esc(f.message)}</li>`)
    .join('');
  const oks = rep.okReasons.map((r) => `<li class="muted">${esc(r)}</li>`).join('');
  out.innerHTML =
    `${badge} <span class="note">${esc(rep.host)}:${esc(rep.port)} — AUTH: ${esc(rep.mechs.join(', ') || 'none')}</span>` +
    (items ? `<ul>${items}</ul>` : '') +
    (oks ? `<ul>${oks}</ul>` : '');
});

// ---------- Credential hygiene audit ----------
let hygieneAccountsPath = null;
let hygieneBreachPath = null;

function updateHygieneFiles() {
  const parts = [];
  if (hygieneAccountsPath) parts.push(`accounts: ${hygieneAccountsPath.split(/[/\\]/).pop()}`);
  if (hygieneBreachPath) parts.push(`breach list: ${hygieneBreachPath.split(/[/\\]/).pop()}`);
  $('#hygiene-files').textContent = parts.length ? parts.join(' · ') : 'No file loaded';
}

$('#hygiene-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  hygieneAccountsPath = file ? api.getFilePath?.(file) : null;
  updateHygieneFiles();
});
$('#hygiene-breach').addEventListener('change', (e) => {
  const file = e.target.files[0];
  hygieneBreachPath = file ? api.getFilePath?.(file) : null;
  updateHygieneFiles();
});

$('#btn-hygiene-scan').addEventListener('click', async () => {
  const out = $('#hygiene-result');
  if (!hygieneAccountsPath) {
    out.innerHTML = '<p class="err-text">Load an account export first (email:password per line).</p>';
    return;
  }
  out.innerHTML = '<p class="muted">Analyzing…</p>';
  const rep = await api.auditHygiene(hygieneAccountsPath, hygieneBreachPath);
  if (rep.error) {
    out.innerHTML = `<p class="err-text">Analysis failed: ${esc(rep.error)}</p>`;
    return;
  }
  const s = rep.summary;
  const badge = s.flagged
    ? `<span class="score-badge score-high">${s.flagged.toLocaleString()} of ${s.total.toLocaleString()} need a reset</span>`
    : `<span class="score-badge score-low">All ${s.total.toLocaleString()} accounts look OK</span>`;
  const breakdown = `<span class="note"> — weak: ${s.weak.toLocaleString()}, reused: ${s.reused.toLocaleString()}, breached: ${s.breached.toLocaleString()}</span>`;
  const rows = rep.sample
    .map((a) => `<li><span class="mono">${esc(a.user)}</span> — ${esc(a.reasons.join('; '))}</li>`)
    .join('');
  const note =
    s.flagged > rep.sample.length
      ? `<p class="muted">Showing the first ${rep.sample.length} flagged of ${s.flagged.toLocaleString()}.</p>`
      : '';
  out.innerHTML = `${badge}${breakdown}${rows ? `<ul>${rows}</ul>` : ''}${note}`;
});

// ---------- cPanel login check ----------
// Parse "host:username:password" lines. Split on the first two colons only, so
// a password containing ':' is preserved. The port is uniform for the batch.
function parseCpanelLines(text, port) {
  const targets = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i1 = line.indexOf(':');
    const i2 = i1 < 0 ? -1 : line.indexOf(':', i1 + 1);
    if (i1 < 0 || i2 < 0) continue; // need host:user:pass
    const host = line.slice(0, i1).trim();
    const user = line.slice(i1 + 1, i2).trim();
    const pass = line.slice(i2 + 1);
    if (host && user) targets.push({ host, user, pass, port });
  }
  return targets;
}

const CPANEL_STATUS = {
  valid: ['ok', 'Login works'],
  invalid: ['bad', 'Login rejected'],
  unknown: ['neutral', 'Up, unconfirmed'],
  'not-cpanel': ['neutral', 'Not cPanel'],
  unreachable: ['bad', 'Down / unreachable'],
};

function renderCpanelRows(results) {
  return results
    .map((r) => {
      const [cls, label] = CPANEL_STATUS[r.status] || ['neutral', r.status];
      return `<li><span class="dbadge b-${cls}">${esc(label)}</span> <span class="mono">${esc(r.host)}:${esc(String(r.port))}</span> — ${esc(r.user)}${r.detail ? ` <span class="muted">(${esc(String(r.detail))})</span>` : ''}</li>`;
    })
    .join('');
}

$('#btn-cpanel-check').addEventListener('click', async () => {
  const out = $('#cpanel-result');
  const prog = $('#cpanel-progress');
  const port = Number($('#cpanel-port').value) || 2083;
  const concurrency = Number($('#cpanel-concurrency').value) || 10;
  const targets = parseCpanelLines($('#cpanel-input').value, port);
  if (!targets.length) {
    out.innerHTML = '<p class="err-text">Add at least one account as host:username:password.</p>';
    return;
  }
  const btn = $('#btn-cpanel-check');
  btn.disabled = true;
  out.innerHTML = '';
  prog.textContent = `0 / ${targets.length}`;
  let done = 0;
  const off = api.onCpanelProgress(() => {
    done++;
    prog.textContent = `${done} / ${targets.length}`;
  });
  try {
    const rep = await api.checkCpanel(targets, { maxPerSec: Number($('#opt-maxrate').value) || 0,  port, concurrency });
    if (rep.error) {
      out.innerHTML = `<p class="err-text">Check failed: ${esc(rep.error)}</p>`;
      return;
    }
    const s = rep.summary;
    const badge =
      `<span class="score-badge score-low">${s.valid} up</span> ` +
      `<span class="score-badge score-high">${s.invalid + s.unreachable} need attention</span>`;
    const note = `<span class="note"> — valid: ${s.valid}, rejected: ${s.invalid}, down: ${s.unreachable}, other: ${s.unknown + s['not-cpanel']}</span>`;
    out.innerHTML = `${badge}${note}<ul>${renderCpanelRows(rep.results)}</ul>`;
  } finally {
    off?.();
    prog.textContent = '';
    btn.disabled = false;
  }
});

// ---------- Webmail login check ----------
const WEBMAIL_STATUS = {
  valid: ['ok', 'Login works'],
  invalid: ['bad', 'Login rejected'],
  unknown: ['neutral', 'Up, unconfirmed'],
  'not-webmail': ['neutral', 'Not webmail'],
  unreachable: ['bad', 'Down / unreachable'],
};

function renderWebmailRows(results) {
  return results
    .map((r) => {
      const [cls, label] = WEBMAIL_STATUS[r.status] || ['neutral', r.status];
      return `<li><span class="dbadge b-${cls}">${esc(label)}</span> <span class="mono">${esc(r.host)}:${esc(String(r.port))}</span> — ${esc(r.user)}${r.detail ? ` <span class="muted">(${esc(String(r.detail))})</span>` : ''}</li>`;
    })
    .join('');
}

$('#btn-webmail-check').addEventListener('click', async () => {
  const out = $('#webmail-result');
  const prog = $('#webmail-progress');
  const port = Number($('#webmail-port').value) || 443;
  const path = $('#webmail-path').value.trim() || '/webmail';
  const concurrency = Number($('#webmail-concurrency').value) || 10;
  const targets = parseCpanelLines($('#webmail-input').value, port); // host:user:pass, shared parser
  if (!targets.length) {
    out.innerHTML = '<p class="err-text">Add at least one account as host:username:password.</p>';
    return;
  }
  const btn = $('#btn-webmail-check');
  btn.disabled = true;
  out.innerHTML = '';
  prog.textContent = `0 / ${targets.length}`;
  let done = 0;
  const off = api.onWebmailProgress(() => {
    done++;
    prog.textContent = `${done} / ${targets.length}`;
  });
  try {
    const rep = await api.checkWebmail(targets, { maxPerSec: Number($('#opt-maxrate').value) || 0,  port, path, concurrency });
    if (rep.error) {
      out.innerHTML = `<p class="err-text">Check failed: ${esc(rep.error)}</p>`;
      return;
    }
    const s = rep.summary;
    const badge =
      `<span class="score-badge score-low">${s.valid} up</span> ` +
      `<span class="score-badge score-high">${s.invalid + s.unreachable} need attention</span>`;
    const note = `<span class="note"> — valid: ${s.valid}, rejected: ${s.invalid}, down: ${s.unreachable}, other: ${s.unknown + s['not-webmail']}</span>`;
    out.innerHTML = `${badge}${note}<ul>${renderWebmailRows(rep.results)}</ul>`;
  } finally {
    off?.();
    prog.textContent = '';
    btn.disabled = false;
  }
});

// ---------- WHM login check ----------
const WHM_STATUS = {
  valid: ['ok', 'Login works'],
  invalid: ['bad', 'Login rejected'],
  'not-whm': ['neutral', 'Not WHM'],
  unreachable: ['bad', 'Down / unreachable'],
};

function renderWhmRows(results) {
  return results
    .map((r) => {
      const [cls, label] = WHM_STATUS[r.status] || ['neutral', r.status];
      return `<li><span class="dbadge b-${cls}">${esc(label)}</span> <span class="mono">${esc(r.host)}:${esc(String(r.port))}</span> — ${esc(r.user)}${r.detail ? ` <span class="muted">(${esc(String(r.detail))})</span>` : ''}</li>`;
    })
    .join('');
}

$('#btn-whm-check').addEventListener('click', async () => {
  const out = $('#whm-result');
  const prog = $('#whm-progress');
  const port = Number($('#whm-port').value) || 2087;
  const concurrency = Number($('#whm-concurrency').value) || 10;
  const targets = parseCpanelLines($('#whm-input').value, port); // host:user:pass, shared parser
  if (!targets.length) {
    out.innerHTML = '<p class="err-text">Add at least one account as host:username:password.</p>';
    return;
  }
  const btn = $('#btn-whm-check');
  btn.disabled = true;
  out.innerHTML = '';
  prog.textContent = `0 / ${targets.length}`;
  let done = 0;
  const off = api.onWhmProgress(() => {
    done++;
    prog.textContent = `${done} / ${targets.length}`;
  });
  try {
    const rep = await api.checkWhm(targets, { maxPerSec: Number($('#opt-maxrate').value) || 0,  port, concurrency });
    if (rep.error) {
      out.innerHTML = `<p class="err-text">Check failed: ${esc(rep.error)}</p>`;
      return;
    }
    const s = rep.summary;
    const badge =
      `<span class="score-badge score-low">${s.valid} up</span> ` +
      `<span class="score-badge score-high">${s.invalid + s.unreachable} need attention</span>`;
    const note = `<span class="note"> — valid: ${s.valid}, rejected: ${s.invalid}, down: ${s.unreachable}, other: ${s['not-whm']}</span>`;
    out.innerHTML = `${badge}${note}<ul>${renderWhmRows(rep.results)}</ul>`;
  } finally {
    off?.();
    prog.textContent = '';
    btn.disabled = false;
  }
});

// ---------- SSH login check ----------
const SSH_STATUS = {
  valid: ['ok', 'Login works'],
  invalid: ['bad', 'Login rejected'],
  unreachable: ['bad', 'Down / unreachable'],
};

function renderSshRows(results) {
  return results
    .map((r) => {
      const [cls, label] = SSH_STATUS[r.status] || ['neutral', r.status];
      return `<li><span class="dbadge b-${cls}">${esc(label)}</span> <span class="mono">${esc(r.host)}:${esc(String(r.port))}</span> — ${esc(r.username || r.user)}${r.detail ? ` <span class="muted">(${esc(String(r.detail))})</span>` : ''}</li>`;
    })
    .join('');
}

$('#btn-ssh-check').addEventListener('click', async () => {
  const out = $('#ssh-result');
  const prog = $('#ssh-progress');
  const port = Number($('#ssh-port').value) || 22;
  const concurrency = Number($('#ssh-concurrency').value) || 5;
  const targets = parseCpanelLines($('#ssh-input').value, port); // host:user:pass, shared parser
  if (!targets.length) {
    out.innerHTML = '<p class="err-text">Add at least one account as host:username:password.</p>';
    return;
  }
  const btn = $('#btn-ssh-check');
  btn.disabled = true;
  out.innerHTML = '';
  prog.textContent = `0 / ${targets.length}`;
  let done = 0;
  const off = api.onSshProgress(() => {
    done++;
    prog.textContent = `${done} / ${targets.length}`;
  });
  try {
    const rep = await api.checkSsh(targets, { maxPerSec: Number($('#opt-maxrate').value) || 0,  port, concurrency });
    if (rep.error) {
      out.innerHTML = `<p class="err-text">Check failed: ${esc(rep.error)}</p>`;
      return;
    }
    const s = rep.summary;
    const badge =
      `<span class="score-badge score-low">${s.valid} up</span> ` +
      `<span class="score-badge score-high">${s.invalid + s.unreachable} need attention</span>`;
    const note = `<span class="note"> — valid: ${s.valid}, rejected: ${s.invalid}, down: ${s.unreachable}</span>`;
    out.innerHTML = `${badge}${note}<ul>${renderSshRows(rep.results)}</ul>`;
  } finally {
    off?.();
    prog.textContent = '';
    btn.disabled = false;
  }
});

// ---------- Combo Cracker (all 5 protocols from one paste) ----------
function comboDeriveHost(rec) {
  if (rec.host) return rec.host;
  const u = String(rec.user || '');
  return u.includes('@') ? u.split('@')[1] : null;
}

function comboCell(kind, result) {
  if (!result) return '<td class="detail"><span class="dbadge b-neutral">—</span></td>';
  let cls = 'b-neutral';
  let label = '?';
  if (kind === 'smtp') {
    if (result.status === 'valid') { cls = 'b-ok'; label = '✓'; }
    else if (result.status === 'inbox') { cls = 'b-ok'; label = '✓ inbox'; }
    else if (result.status === 'spam') { cls = 'b-ok'; label = '✓ spam'; }
    else if (result.status === 'dead') { cls = 'b-bad'; label = '✗'; }
    else { label = result.status || '?'; }
  } else {
    if (result.valid === true) { cls = 'b-ok'; label = '✓'; }
    else if (result.reachable === false) { cls = 'b-neutral'; label = '—'; }
    else if (result.valid === false) { cls = 'b-bad'; label = '✗'; }
    else { label = '?'; }
  }
  return '<td class="detail"><span class="dbadge ' + cls + '">' + label + '</span></td>';
}

function comboRenderRow(r) {
  const notes = [];
  if (r.smtp?.proxyFallback) notes.push('dead proxy — retried direct');
  if (r.smtp?.usedHost) notes.push('smtp: ' + r.smtp.usedHost);
  return '<tr>' +
    '<td class="mono">' + esc(r.user) + '</td>' +
    comboCell('smtp', r.smtp) +
    comboCell('cpanel', r.cpanel) +
    comboCell('webmail', r.webmail) +
    comboCell('whm', r.whm) +
    comboCell('ssh', r.ssh) +
    '<td class="notes">' + esc(notes.join('; ')) + '</td>' +
    '</tr>';
}

// ---------- Email authentication check ----------
function authBadge(label, verdict) {
  // verdict: 'ok' | 'bad' | 'neutral'
  return `<span class="dbadge b-${verdict}">${esc(label)}</span>`;
}

function renderAuthReport(rep) {
  const engine =
    rep.engine === 'python'
      ? '<span class="score-badge score-low">Python sidecar — SPF evaluated, DKIM verified</span>'
      : '<span class="score-badge score-medium">JS fallback — records read only (install the sidecar for SPF eval + DKIM verify)</span>';

  // SPF
  const spf = rep.spf || {};
  const spfVerdict = spf.result === 'pass' ? 'ok' : spf.result && spf.result !== 'none' ? 'bad' : 'neutral';
  const spfLine = spf.found
    ? `${authBadge(`SPF ${spf.result || spf.all || 'found'}`, spfVerdict)} <span class="mono">${esc(spf.record || '')}</span>${spf.explanation ? ` <span class="muted">(${esc(spf.explanation)})</span>` : ''}`
    : `${authBadge('SPF missing', 'bad')} <span class="muted">no v=spf1 record</span>`;

  // DKIM
  const dkim = rep.dkim || {};
  const dkimVerdict = dkim.verified === true ? 'ok' : dkim.verified === false ? 'bad' : 'neutral';
  const dkimLabel = dkim.verified === true ? 'DKIM verified' : dkim.verified === false ? 'DKIM failed' : 'DKIM not checked';
  const dkimLine = `${authBadge(dkimLabel, dkimVerdict)}${dkim.domains?.length ? ` <span class="mono">d=${esc(dkim.domains.join(', '))}</span>` : ''}${dkim.detail ? ` <span class="muted">(${esc(dkim.detail)})</span>` : ''}`;

  // DMARC
  const dmarc = rep.dmarc || {};
  const dmarcVerdict = !dmarc.found ? 'bad' : dmarc.policy === 'reject' || dmarc.policy === 'quarantine' ? 'ok' : 'neutral';
  const dmarcLine = dmarc.found
    ? `${authBadge(`DMARC p=${dmarc.policy || '?'}`, dmarcVerdict)}${dmarc.pct != null ? ` pct=${dmarc.pct}` : ''}${dmarc.aligned != null ? ` — ${dmarc.aligned ? 'aligned' : 'not aligned'}` : ''} <span class="mono">${esc(dmarc.record || '')}</span>`
    : `${authBadge('DMARC missing', 'bad')} <span class="muted">no _dmarc record</span>`;

  return `${engine}<ul><li>${spfLine}</li><li>${dkimLine}</li><li>${dmarcLine}</li></ul>`;
}

// Reflect the auto-provisioning state of the Python sidecar — no manual setup.
function renderAuthStatus(st) {
  const el = $('#auth-status');
  if (!el || !st) return;
  if (st.state === 'ready') {
    el.textContent = '✓ High-accuracy checks ready';
  } else if (st.state === 'pending') {
    el.textContent = st.message || 'Setting up high-accuracy checks…';
  } else {
    // unavailable — the feature still works via the JS fallback.
    const why = st.reason === 'python-not-found' ? 'no Python found' : st.reason || 'unavailable';
    el.textContent = `Using built-in checks (${why})`;
  }
}
if (api.getAuthStatus) api.getAuthStatus().then(renderAuthStatus);
api.onAuthStatus?.(renderAuthStatus);

$('#btn-auth-check').addEventListener('click', async () => {
  const out = $('#auth-result');
  const domain = $('#auth-domain').value.trim();
  if (!domain) {
    out.innerHTML = '<p class="err-text">Enter a domain you send from.</p>';
    return;
  }
  const request = {
    domain,
    ip: $('#auth-ip').value.trim() || undefined,
    helo: $('#auth-helo').value.trim() || undefined,
    mailfrom: $('#auth-mailfrom').value.trim() || undefined,
    message: $('#auth-message').value.trim() || undefined,
  };
  const btn = $('#btn-auth-check');
  btn.disabled = true;
  out.innerHTML = '<p class="muted">Checking…</p>';
  try {
    const rep = await api.checkEmailAuth(request);
    if (rep.error) {
      out.innerHTML = `<p class="err-text">Check failed: ${esc(rep.error)}</p>`;
      return;
    }
    out.innerHTML = renderAuthReport(rep);
  } finally {
    btn.disabled = false;
  }
});

// ---------- License gate ----------
const licenseOverlay = $('#license-overlay');

$('#license-telegram').addEventListener('click', () => api.openExternal('https://t.me/splean_tool'));
$('#license-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#license-hwid').value);
  $('#license-copy').textContent = 'Copied ✓';
  setTimeout(() => ($('#license-copy').textContent = 'Copy'), 1500);
});
$('#license-activate').addEventListener('click', async () => {
  const key = $('#license-key').value.trim();
  if (!key) return;
  const res = await api.activateLicense(key);
  if (res.valid) {
    licenseOverlay.hidden = true;
    startApp();
  } else {
    $('#license-error').textContent = res.reason || 'Invalid license key';
  }
});

async function enforceLicense() {
  const lic = await api.getLicense();
  $('#license-hwid').value = lic.hwid;
  if (lic.activated) {
    licenseOverlay.hidden = true;
    return true;
  }
  licenseOverlay.hidden = false;
  return false;
}

// ---------- Health monitor ----------
let monitorState = null;

function fmtTime(ts) {
  if (!ts) return 'never';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function renderMonitorStatus() {
  const m = monitorState || {};
  const n = (m.creds || []).length;
  $('#monitor-status').textContent =
    `${n} credential${n === 1 ? '' : 's'} monitored · ${m.enabled ? 'ON' : 'off'} · last check: ${fmtTime(m.lastCheck)}`;
}

$('#monitor-creds').addEventListener('input', () => {
  const r = parse($('#monitor-creds').value);
  $('#monitor-creds-count').textContent = `${r.records.length} parsed`;
});

$('#btn-monitor-savelist').addEventListener('click', async () => {
  const { records } = dedupeCredentials(parse($('#monitor-creds').value).records);
  monitorState = await api.setMonitorCreds(records);
  $('#monitor-save-status').textContent = `Saved ${records.length} ✓`;
  renderMonitorStatus();
  setTimeout(() => ($('#monitor-save-status').textContent = ''), 2500);
});

$('#btn-monitor-save').addEventListener('click', async () => {
  monitorState = await api.saveMonitor({
    enabled: $('#monitor-enabled').checked,
    intervalHours: Number($('#monitor-interval').value) || 6,
    alertBotToken: $('#monitor-token').value.trim(),
    alertChatId: $('#monitor-chatid').value.trim(),
  });
  $('#monitor-save-status').textContent = monitorState.enabled ? 'Saved ✓ (monitoring on)' : 'Saved ✓ (off)';
  renderMonitorStatus();
  setTimeout(() => ($('#monitor-save-status').textContent = ''), 2500);
});

$('#btn-monitor-check').addEventListener('click', async () => {
  $('#monitor-log').innerHTML = '<p class="muted">Checking…</p>';
  const res = await api.checkMonitorNow();
  monitorState = await api.getMonitor();
  renderMonitorStatus();
  if (!res.count) {
    $('#monitor-log').innerHTML = '<p class="muted">No credentials saved to monitor yet.</p>';
  } else if (res.died.length) {
    $('#monitor-log').innerHTML =
      `<span class="score-badge score-high">${res.died.length} went dead</span>` +
      `<ul>${res.died.map((d) => `<li>${esc(d.user)} — ${esc(d.reason || 'dead')}</li>`).join('')}</ul>`;
  } else {
    $('#monitor-log').innerHTML = `<span class="score-badge score-low">All ${res.count} still OK</span>`;
  }
});

api.onMonitorChecked((summary) => {
  renderMonitorStatus();
  if (summary.died?.length) {
    $('#monitor-log').innerHTML =
      `<span class="score-badge score-high">${summary.died.length} went dead at ${fmtTime(summary.at)}</span>` +
      `<ul>${summary.died.map((d) => `<li>${esc(d.user)} — ${esc(d.reason || 'dead')}</li>`).join('')}</ul>`;
  }
});

async function initMonitor() {
  monitorState = await api.getMonitor();
  $('#monitor-creds').value = (monitorState.creds || [])
    .map((c) => `${c.host || ''}:${c.port || ''}:${c.user}:${c.pass}`.replace(/^::/, ''))
    .join('\n');
  $('#monitor-creds-count').textContent = `${(monitorState.creds || []).length} parsed`;
  $('#monitor-interval').value = String(monitorState.intervalHours || 6);
  $('#monitor-enabled').checked = !!monitorState.enabled;
  $('#monitor-token').value = monitorState.alertBotToken || '';
  $('#monitor-chatid').value = monitorState.alertChatId || '';
  renderMonitorStatus();
}

// ---------- Boot ----------
let appStarted = false;
async function startApp() {
  if (appStarted) return;
  appStarted = true;
  settings = await api.getSettings();
  applySettingsToForm();
  refreshParse();
  initMonitor();
}

(async function init() {
  const licensed = await enforceLicense();
  if (licensed) startApp();
  // Show restored proxy pool on launch (from prior session's save).
  try {
    const s = await api.proxyStatus?.();
    const el = $('#proxy-pool-status');
    if (el && s && s.size && s.size.valid > 0) {
      const when = s.scrapedAt ? new Date(s.scrapedAt).toLocaleString() : 'unknown';
      el.textContent = 'Pool: ' + s.size.valid + ' valid / ' + s.size.total + ' tested (restored ' + when + ')';
    }
  } catch { /* noop */ }
})();


// ---------- Host Map ----------
api.getHostMap?.().then(text => { if (text) $('#hostmap-input').value = text; }).catch(()=>{});
$('#btn-save-hostmap')?.addEventListener('click', async () => {
  const text = $('#hostmap-input').value;
  const res = await api.saveHostMap(text);
  $('#hostmap-status').textContent = 'Saved ' + res.size + ' mappings ✓';
  setTimeout(() => $('#hostmap-status').textContent = '', 2000);
});
