import { parse } from '../core/parser.js';

const api = window.api;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let settings = null;
let parsed = { records: [], errors: [] };
let results = [];
let activeFilter = 'all';
let running = false;

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
credsInput.addEventListener('input', refreshParse);

$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    credsInput.value = String(reader.result);
    refreshParse();
  };
  reader.readAsText(file);
});

function refreshParse() {
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
$('#btn-cancel').addEventListener('click', () => api.cancel());

async function runBatch() {
  if (running) return;
  refreshParse();
  if (!parsed.records.length) {
    $('#parse-errors').textContent = 'Nothing to test — add at least one valid credential.';
    return;
  }
  running = true;
  results = [];
  renderResults();
  setRunning(true);
  $('#progress-bar').hidden = false;
  $('#progress-fill').style.width = '0%';

  const manualRecipients = $('#manual-recipients').value
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const opts = {
    concurrency: Number($('#opt-concurrency').value) || 5,
    connectTimeout: (settings?.connectTimeout) || 10000,
    sendTimeout: (settings?.sendTimeout) || 15000,
    placementTimeoutMs: (Number($('#opt-timeout').value) || 90) * 1000,
    pollIntervalMs: (settings?.pollIntervalMs) || 5000,
    from: settings?.from || '',
    subjectTemplate: settings?.subjectTemplate,
    bodyTemplate: settings?.bodyTemplate,
    manualRecipients,
    checks: $('#opt-checks').checked
      ? { authRecords: true, dnsbl: true, spamScore: true }
      : null,
    proxyConfig: settings?.proxy,
  };

  const total = parsed.records.length;
  $('#progress-label').textContent = `0 / ${total}`;

  try {
    await api.testBatch(parsed.records, settings?.seeds || [], opts);
  } catch (err) {
    $('#parse-errors').textContent = `Run failed: ${err.message}`;
  } finally {
    setRunning(false);
    running = false;
  }
}

function setRunning(on) {
  $('#btn-run').disabled = on;
  $('#btn-cancel').disabled = !on;
  const noResults = results.length === 0;
  $('#btn-export-csv').disabled = on || noResults;
  $('#btn-export-json').disabled = on || noResults;
  $('#btn-export-txt').disabled = on || results.every((r) => r.status === 'dead');
}

// Cap how many rows live in the DOM so very large runs stay snappy. Every
// result is still kept in `results` for counts and exports. Configurable.
function currentRowCap() {
  const v = $('#opt-rowcap')?.value;
  return v === 'all' ? Infinity : Number(v) || 500;
}

$('#opt-rowcap').addEventListener('change', renderResults);

api.onProgress(({ result }) => {
  results.push(result);
  const total = parsed.records.length;
  $('#progress-label').textContent = `${results.length} / ${total}`;
  const fill = $('#progress-fill');
  if (fill) fill.style.width = `${total ? Math.round((results.length / total) * 100) : 0}%`;
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
  const cap = currentRowCap();
  while (body.children.length > cap) body.removeChild(body.firstElementChild);
}

function renderRowsNote() {
  const el = $('#rows-note');
  if (!el) return;
  const cap = currentRowCap();
  el.textContent =
    results.length > cap
      ? `Showing the newest ${cap} rows of ${results.length} — all ${results.length} are included in exports and the counts above.`
      : '';
}
api.onDone(() => {
  $('#progress-label').textContent = `${results.length} tested`;
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
  const rows = results.filter((r) => activeFilter === 'all' || r.status === activeFilter);
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${
      results.length ? 'No results match this filter.' : 'No results yet. Paste credentials and click <b>Test All</b>.'
    }</td></tr>`;
    return;
  }
  // Render only the newest N matching rows to keep the DOM light.
  const cap = currentRowCap();
  body.innerHTML = (cap === Infinity ? rows : rows.slice(-cap)).map(rowHtml).join('');
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
  if (!results.length) {
    el.innerHTML = '';
    return;
  }
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const chips = SUMMARY_ORDER.map(
    ([key, label]) =>
      `<span class="summary-chip status-${key}">${label}: ${counts[key] || 0}</span>`,
  ).join('');
  el.innerHTML = `${chips}<span class="summary-chip summary-total">Total: ${results.length}</span>`;
}

function renderContentScoreBanner() {
  const el = $('#content-score-banner');
  const s = results.find((r) => r.spamScore)?.spamScore;
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

  if (r.triedFallback && r.usedHost) {
    parts.push(`<span class="note">↳ connected via <b>${esc(r.usedHost)}:${esc(r.usedPort)}</b> (auto-detected)</span>`);
  }
  if (r.manualRecipients && r.manualRecipients.length && (r.status === 'valid' || r.status === 'inbox' || r.status === 'spam')) {
    parts.push(
      `<span class="note">✉ Check ${esc(r.manualRecipients.join(', '))} for subject containing <b class="mono">${esc(r.token)}</b></span>`,
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
async function doExport(format) {
  const res = await api.exportResults(results, format);
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

// ---------- Boot ----------
let appStarted = false;
async function startApp() {
  if (appStarted) return;
  appStarted = true;
  settings = await api.getSettings();
  applySettingsToForm();
  refreshParse();
}

(async function init() {
  const licensed = await enforceLicense();
  if (licensed) startApp();
})();
