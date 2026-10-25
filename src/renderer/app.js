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
  $('#btn-export-csv').disabled = on || results.length === 0;
  $('#btn-export-json').disabled = on || results.length === 0;
}

api.onProgress(({ result }) => {
  results.push(result);
  $('#progress-label').textContent = `${results.length} / ${parsed.records.length}`;
  renderResults();
});
api.onDone(() => {
  $('#progress-label').textContent = `${results.length} tested`;
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
  const body = $('#results-body');
  const rows = results.filter((r) => activeFilter === 'all' || r.status === activeFilter);
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${
      results.length ? 'No results match this filter.' : 'No results yet. Paste credentials and click <b>Test All</b>.'
    }</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(rowHtml).join('');
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

  const host = r.cred.host || (r.usedHost ? `${r.usedHost} (auto)` : 'auto-detect');
  const port = r.cred.port || r.usedPort || '';
  return `<tr>
    <td class="mono">${esc(host)}${port ? ':' + esc(port) : ''}</td>
    <td class="mono">${esc(r.cred.user)}</td>
    <td><span class="status-chip status-${r.status}">${statusLabel(r.status)}</span></td>
    <td>${r.latencyMs} ms</td>
    <td class="detail">${parts.join('<br>')}</td>
  </tr>`;
}

function statusLabel(s) {
  return s === 'unknown' ? 'unknown placement' : s;
}

// ---------- Export ----------
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
  seedsList.innerHTML = '';
  (settings.seeds || []).forEach(addSeedRow);
  updateSeedNote();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Boot ----------
(async function init() {
  settings = await api.getSettings();
  applySettingsToForm();
  refreshParse();
})();
