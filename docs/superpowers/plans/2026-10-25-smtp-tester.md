# SMTP Tester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-platform Electron desktop app that batch-tests bulk SMTP credentials and reports each as Dead / Valid / Inbox / Spam / Unknown placement, using the user's own seed mailboxes over IMAP for placement.

**Architecture:** A pure-Node `core/` engine (parser, classifier, SMTP, IMAP, orchestrator) with no Electron dependency, unit-tested in isolation. Electron's main process hosts the engine and persists settings; the renderer is a two-screen UI (Test, Settings) talking to main over a `contextBridge` preload API. Progress streams main→renderer so the results table fills live.

**Tech Stack:** Node 24, Electron, `nodemailer` (SMTP), `imapflow` (IMAP), `electron-store` (local settings), `electron-builder` (packaging), `smtp-server` (test-only), `node:test` test runner.

**Spec:** `docs/superpowers/specs/2026-10-25-smtp-tester-design.md`

## Global Constraints

- Node >= 24; ESM modules (`"type": "module"` in package.json).
- Electron security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox` where feasible; renderer reaches main ONLY through the preload `contextBridge` API.
- `core/` modules import no Electron API — they are plain Node and testable with `node --test`.
- Statuses are exactly: `dead`, `valid`, `inbox`, `spam`, `unknown` (internal keys); display labels: Dead / Valid / Inbox / Spam / Unknown placement.
- No live third-party credentials in automated tests.
- Every network operation has an explicit timeout; one failing credential never aborts the batch.
- Defaults: concurrency 5, placement timeout 90000 ms, poll interval 5000 ms, IMAP port 993/TLS.

## Review Focus

- **Malformed credential line** (wrong field count, non-numeric port) → parser reports it as a `ParseError` with line number, does not throw, other lines still parse. (Task 2)
- **Password containing the delimiter** (`:` in colon format) → split caps at 4 fields so the password keeps trailing delimiters; CSV honors quotes. (Task 2)
- **SMTP auth rejected vs. connection refused** → both yield `dead` but with distinct human-readable reasons. (Task 4, Task 3)
- **Seed IMAP login fails during a run** → that seed's placement is marked `error`; the SMTP still reports other seeds, and status degrades to `valid` + note if none resolved, never crashes the batch. (Task 5, Task 6)
- **Send succeeds but token never appears before timeout** → status is `unknown`, distinct from `valid`. (Task 3, Task 6)

---

### Task 1: Project scaffold & test harness

**Files:**
- Create: `package.json`, `.nvmrc`, `src/core/.gitkeep`
- Create: `tests/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs `node --test tests/**/*.test.js`; `npm run dev` launches Electron (added fully in Task 7).

- [ ] **Step 1:** Create `package.json` with `"type": "module"`, `engines.node >= 24`, scripts `test` (`node --test`), devDeps `electron`, `electron-builder`, `smtp-server`, deps `nodemailer`, `imapflow`, `electron-store`. Pin to current latest at install time.
- [ ] **Step 2:** Write `tests/smoke.test.js` asserting `1 + 1 === 2` via `node:test` + `node:assert`.
- [ ] **Step 3:** Run `npm install`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit (`chore: scaffold project and test harness`).

---

### Task 2: Credential parser (`core/parser.js`)

**Files:**
- Create: `src/core/parser.js`
- Test: `tests/parser.test.js`

**Interfaces:**
- Produces: `parse(text: string) -> { records: Credential[], errors: ParseError[] }`
  - `Credential = { host, port: number, user, pass, from?: string }`
  - `ParseError = { line: number, raw: string, reason: string }`

- [ ] **Step 1: Write failing tests** covering:
  - `host:port:user:pass` → one record, `port` is a Number.
  - `host,port,user,pass` (CSV) and `host|port|user|pass` parse equally.
  - Optional 5th field becomes `from`.
  - Blank lines and lines starting `#` are skipped (no record, no error).
  - Colon-format password containing `:` (e.g. `smtp.x.com:587:u@x.com:p:a:ss`) → `pass === "p:a:ss"` (split caps at 4 fields, no `from`); document that a 5th colon field is ambiguous and folded into pass for colon/pipe formats.
  - CSV with quoted field `"p,ass"` keeps the comma in `pass`.
  - Non-numeric port → a `ParseError` with that line number, and it does NOT appear in `records`; a valid line on either side still parses.
- [ ] **Step 2:** Run `node --test tests/parser.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `parse`.** Detect delimiter per line (prefer comma if line has a quote, else first of `: , |` present). For colon/pipe, split with a limit of 4 so pass absorbs extra delimiters; when a 5th explicit field exists in CSV it is `from`. Trim fields; coerce port via `Number`, error if `NaN`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: credential parser with multi-delimiter support`).

---

### Task 3: Status classifier (`core/classify.js`)

**Files:**
- Create: `src/core/classify.js`
- Test: `tests/classify.test.js`

**Interfaces:**
- Consumes: nothing from other tasks (pure).
- Produces: `classify(stepResults) -> { status, reason, perSeed }`
  - `stepResults = { connected: bool, authenticated: bool, authError?, sent: bool, sendError?, seeds: SeedPlacement[] }`
  - `SeedPlacement = { label, folder: 'inbox'|'spam'|null, error?: string }`
  - `status ∈ 'dead'|'valid'|'inbox'|'spam'|'unknown'`

- [ ] **Step 1: Write failing tests** for the matrix:
  - not connected → `dead`, reason mentions connection.
  - connected, not authenticated → `dead`, reason = authError.
  - authenticated, not sent → `dead`, reason = sendError.
  - sent, `seeds: []` → `valid` (placement not evaluated).
  - sent, all seeds `folder: 'inbox'` → `inbox`.
  - sent, any seed `folder: 'spam'` (rest inbox) → `spam` (conservative).
  - sent, all seeds `folder: null` → `unknown`.
  - sent, every seed has `error` → `valid` with a note about placement undetermined.
  - `perSeed` is always the passed seed array.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement `classify`** per the matrix above.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: status classifier`).

---

### Task 4: SMTP module (`core/smtp.js`)

**Files:**
- Create: `src/core/smtp.js`
- Test: `tests/smtp.test.js` (uses `smtp-server` in-process)

**Interfaces:**
- Consumes: `Credential` from Task 2.
- Produces:
  - `verify(cred, { connectTimeout }) -> { connected, authenticated, error? }`
  - `send(cred, { to, subject, html, text, from, sendTimeout }) -> { accepted: string[], messageId?, error? }`
  - Both use `nodemailer.createTransport({ host, port, auth, secure: port===465, connectionTimeout })`.

- [ ] **Step 1: Write failing tests** with a local `smtp-server`:
  - server that accepts user `good`/`pass` → `verify` returns `{ connected: true, authenticated: true }`.
  - wrong password → `{ connected: true, authenticated: false, error }`.
  - no server listening on the port → `{ connected: false, error }` (connection refused), within timeout.
  - `send` to the accepting server returns `accepted` containing the recipient.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement `verify` and `send`.** `verify` calls `transport.verify()`; map the error to connected/authenticated by inspecting the error (ECONNREFUSED/ETIMEDOUT → not connected; auth code 535 → not authenticated). `send` calls `transport.sendMail`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: SMTP verify and send`).

---

### Task 5: IMAP placement module (`core/imap.js`)

**Files:**
- Create: `src/core/imap.js`
- Test: `tests/imap.test.js`

**Interfaces:**
- Consumes: `Seed` config `{ label, imapHost, imapPort, imapUser, imapPassword, address, junkFolders? }`.
- Produces:
  - `findToken(seed, token, { folders, timeoutMs, pollIntervalMs }) -> { found: bool, folder: 'inbox'|'spam'|null, error? }`
  - `verifySeed(seed) -> { ok: bool, folders?: string[], error? }`
  - Internal pure helper `resolveFolders(mailboxNames, overrides) -> { inbox, junk }` for folder-name detection.

- [ ] **Step 1: Write failing tests** for the pure helper `resolveFolders`:
  - Given `['INBOX','[Gmail]/Spam']` → `{ inbox: 'INBOX', junk: '[Gmail]/Spam' }`.
  - Given `['INBOX','Junk']` → junk `'Junk'`; `['INBOX','Junk Email']` → `'Junk Email'`.
  - Explicit override wins over detection.
  - No junk candidate → `junk: null`.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement `resolveFolders`, `verifySeed`, `findToken`.** `findToken` connects via `imapflow`, resolves folders, then polls Inbox then Junk searching `SUBJECT token` until found or `timeoutMs` elapses (sleep `pollIntervalMs` between polls); returns the folder key where found. Wrap all IMAP errors into `{ found:false, folder:null, error }` — never throw. (The live-connection paths are verified manually; the test pins `resolveFolders`.)
- [ ] **Step 4:** Run `node --test tests/imap.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: IMAP placement lookup`).

---

### Task 6: Batch orchestrator (`core/tester.js`)

**Files:**
- Create: `src/core/tester.js`
- Test: `tests/tester.test.js` (inject stub smtp/imap)

**Interfaces:**
- Consumes: parser `Credential`, `classify` (Task 3), and smtp/imap modules (injected for testability).
- Produces:
  - `runBatch(creds, seeds, opts, onProgress) -> Promise<Result[]>`
  - `Result = { cred, status, reason, perSeed, latencyMs }`
  - `opts = { concurrency, connectTimeout, sendTimeout, placementTimeoutMs, pollIntervalMs, from, subjectTemplate, bodyTemplate, deps? }`
  - `deps` lets tests inject fake `smtp`/`imap`; defaults to the real modules.
  - A `cancel()` handle (via an `AbortController` passed in `opts.signal`) stops dispatching new work.

- [ ] **Step 1: Write failing tests** with stub deps:
  - 10 creds, concurrency 3 → stub records max in-flight never exceeds 3; all 10 `Result`s returned.
  - `onProgress` is called once per cred as it finishes.
  - A cred whose stub smtp throws still yields a `dead` Result; the batch completes.
  - Each cred's pipeline short-circuits: stub `verify` returning not-authenticated means `send`/`findToken` stubs are never called.
  - Token passed to `send` and to `findToken` for a given cred is identical and unique across creds.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement `runBatch`.** A promise-pool limited to `concurrency`; per cred generate a unique token, run verify→send→(per-seed findToken in parallel)→classify, time it, call `onProgress`, respect `opts.signal`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit (`feat: batch test orchestrator with concurrency`).

---

### Task 7: Electron main, settings store & preload

**Files:**
- Create: `src/main/index.js`, `src/main/store.js`, `src/preload.js`
- Modify: `package.json` (add `"main": "src/main/index.js"`, `dev` script)
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `core/tester`, `core/imap.verifySeed`.
- Produces (preload `contextBridge` API `window.api`):
  - `getSettings() / saveSettings(settings)`
  - `testSeed(seed) -> verifySeed result`
  - `testBatch(creds, opts) -> runId` and progress events via `onProgress(cb)` / `onDone(cb)`
  - `cancel()`
  - `exportResults(results, format) -> savedPath`
  - `store.js` exports pure `defaultSettings()` and `mergeSettings(saved, patch)` (unit-tested without Electron).

- [ ] **Step 1: Write failing tests** for `store.js` pure helpers: `defaultSettings()` returns the documented defaults (concurrency 5, placementTimeoutMs 90000, pollIntervalMs 5000, empty seeds, default subject/body templates); `mergeSettings` overlays a patch without dropping unspecified keys.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement** `store.js` (pure helpers + `electron-store`-backed load/save), `main/index.js` (BrowserWindow with secure webPreferences + preload, IPC handlers wiring the core engine, streaming progress with `webContents.send`), and `preload.js` (`contextBridge.exposeInMainWorld('api', …)`).
- [ ] **Step 4:** Run `node --test tests/store.test.js`. Expected: PASS. Then `npm run dev` launches a window (manual check).
- [ ] **Step 5:** Commit (`feat: electron main, settings store, preload bridge`).

---

### Task 8: Renderer UI (Test & Settings screens)

**Files:**
- Create: `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.api` from the preload (Task 7).

- [ ] **Step 1:** Build `index.html` with a tab switcher for **Test** and **Settings** screens.
- [ ] **Step 2: Test screen:** paste box + Load-file button; parsed count + parse-error summary; concurrency & placement-timeout inputs (prefilled from settings); Test All / Cancel; live results table (Host, User, color-coded status chip, latency, expandable per-seed/error detail); status filter; Export CSV / JSON buttons.
- [ ] **Step 3: Settings screen:** seed mailbox list (add/edit/remove) each with a Test-login button showing result + detected folders; default From, subject/body templates, timeouts; collapsible app-password setup help for Gmail/Outlook/Yahoo.
- [ ] **Step 4:** Wire `window.api` calls and progress events; apply status→color mapping (dead=red, valid=blue, inbox=green, spam=amber, unknown=grey).
- [ ] **Step 5:** `npm run dev`, manually run a batch against a local `smtp-server` + verify table + export (manual check). Commit (`feat: renderer UI for testing and settings`).

---

### Task 9: Packaging & CI

**Files:**
- Create: `electron-builder.yml`, `.github/workflows/build.yml`, `README.md`
- Modify: `package.json` (scripts `dist:mac`, `dist:win`)

**Interfaces:**
- Consumes: the whole app.

- [ ] **Step 1:** Add `electron-builder.yml` with `appId`, mac targets `dmg`+`zip`, Windows target `nsis`, `files` including `src/**`.
- [ ] **Step 2:** Add `package.json` scripts `dist:mac` / `dist:win`.
- [ ] **Step 3:** Run `npm run dist:mac`. Expected: a `.dmg`/`.zip` appears in `dist/` (manual check).
- [ ] **Step 4:** Add `.github/workflows/build.yml`: matrix of `macos-latest` + `windows-latest`, `npm ci`, `npm test`, `npx electron-builder --publish never`, upload artifacts.
- [ ] **Step 5:** Write `README.md` (what it does, seed-mailbox + app-password setup, how to run dev, how to download the Windows `.exe` from Actions artifacts, honesty caveats from the spec). Commit (`feat: packaging config, CI, and docs`).

---

## Self-Review notes

- **Spec coverage:** pipeline (T6), statuses (T3), parser/input formats (T2), seeds/placement (T5), UI screens (T8), build+CI (T9), security/honesty docs (T9 README + T8 help). Covered.
- **Type consistency:** `Credential`, `SeedPlacement`, `Result`, status keys used identically across T2/T3/T5/T6.
- **Review Focus:** each of the five lines maps to a test in T2/T3/T4/T5/T6 as noted.
- **Proportion:** plan expresses interfaces and test names, not implementations; bodies omitted except where an algorithm is pinned.
