# SMTP Tester — Design Spec

**Date:** 2026-10-25
**Status:** Approved (design), pending implementation plan

## Purpose

A desktop app for a digital marketer who buys SMTP relay credentials in bulk
(SendGrid, Resend, AWS SES, etc.). Credentials silently die or degrade over
time. The app replaces manual one-by-one testing (currently done with GMass)
by batch-testing a list of SMTP credentials and reporting, per credential:

- **Dead** — cannot connect or cannot authenticate.
- **Valid / Live** — authenticates and accepts a message for delivery.
- **Inbox** — test mail landed in a seed mailbox's Inbox.
- **Spam** — test mail landed in a seed mailbox's Junk/Spam.
- **Unknown placement** — sent successfully but not found before timeout.

## Users & platform

- Single non-technical user running locally. No server, no multi-user, no auth.
- **Electron** desktop app. Builds: macOS `.dmg`/`.app` locally; Windows `.exe`
  via a GitHub Actions pipeline (cross-building Windows from macOS is unreliable).
- All data (seed mailbox config, results) stays on the user's machine.

## Core concepts

### Tiered test pipeline (per SMTP credential)

Each step runs only if the previous passed. Short-circuit to a status on failure.

1. **Connect** — TCP connect to `host:port` with timeout. Fail → `Dead`.
2. **Authenticate** — SMTP AUTH with username/password. Fail → `Dead` (with
   reason: auth rejected vs. connection error).
3. **Send** — send a uniquely-tagged email through this SMTP to each configured
   seed mailbox address. Fail → `Dead` (reason: rejected / relay denied). Pass
   with no seeds configured → `Valid` (placement not evaluated).
4. **Placement** — for each seed, connect via IMAP and search Inbox + Junk/Spam
   for the unique token. Report per-seed folder. Aggregate → `Inbox` / `Spam` /
   `Unknown placement`.

### Unique token

Each test send embeds a unique token (e.g. `SMTPTEST-<timestamp>-<counter>-<random
suffix>`) in the Subject and body. IMAP search matches on this token so concurrent
tests never cross-match a message from a different run.

### Placement aggregation rule

Per SMTP, across all seeds:
- Any seed = Spam and none better → `Spam`.
- All found seeds = Inbox → `Inbox`.
- Mixed (some Inbox, some Spam) → `Spam` (conservative; details retained per seed).
- Sent but no seed found the token before timeout → `Unknown placement`.
- Per-seed breakdown is always retained and shown in a result's detail view.

### Seed mailboxes

User configures 1+ mailboxes they control. Each seed:
- `label` (e.g. "Gmail #1")
- `imapHost`, `imapPort` (993 default, TLS), `imapUser`, `imapPassword` (app-password)
- `address` — the address test mail is sent TO (usually same as imapUser)
- Junk folder name override (defaults try common names: `Junk`, `Spam`,
  `[Gmail]/Spam`, `Junk Email`).

If zero seeds are configured, the app still runs Connect/Auth/Send and reports
`Valid`/`Dead` — placement is simply skipped with a clear note.

## Architecture

```
src/
  core/                     # pure Node, no Electron — unit-testable
    parser.js               # parse pasted text / file into credential records
    classify.js             # map raw step results -> final status
    smtp.js                 # connect + auth + send (nodemailer)
    imap.js                 # search seed folders for token (imapflow)
    tester.js               # orchestrates pipeline, concurrency, timeouts, events
  main/                     # Electron main process
    index.js                # app lifecycle, window, IPC handlers
    store.js                # local persistence (electron-store) of settings
  renderer/                 # UI (HTML/CSS/vanilla JS or lightweight)
    index.html
    app.js
    styles.css
  preload.js                # contextBridge-exposed safe IPC API
```

### Module contracts

- **parser.parse(text) -> { records: Credential[], errors: ParseError[] }**
  - `Credential = { host, port, user, pass, from? }`
  - Accepts per line: `host:port:user:pass[:from]`, `host,port,user,pass[,from]`,
    `host|port|user|pass[|from]`. Auto-detects delimiter per line. Skips blanks and
    `#` comments. Tolerates passwords containing the delimiter only for CSV via
    quoting; otherwise treats everything after the 3rd delimiter up to an optional
    recognizable email as pass (documented limitation — see Open decisions).

- **smtp.verify(cred, { connectTimeout }) -> { connected, authenticated, error? }**
- **smtp.send(cred, { to, subject, html, text, from, sendTimeout }) -> { accepted, messageId, error? }**
- **imap.findToken(seed, token, { folders, timeoutMs, pollIntervalMs }) ->
  { found, folder | null, error? }**
- **classify(stepResults) -> { status, reason, perSeed }**
- **tester.runBatch(creds, seeds, opts, onProgress) -> Result[]**
  - Concurrency limited (default 5). Emits `onProgress(result)` as each finishes
    so the UI table updates live.

### Electron wiring

- Main process owns the core engine (Node APIs, sockets). Renderer is UI only.
- `preload.js` exposes a minimal, typed API over `contextBridge`
  (`contextIsolation: true`, `nodeIntegration: false`): `testBatch`, `cancel`,
  `getSettings`, `saveSettings`, `testSeed` (validate a seed's IMAP login),
  `exportResults`.
- Progress streamed main→renderer via `webContents.send` events.

## UI

Two screens, tab-switched:

1. **Test**
   - Large paste box + "Load file" button.
   - Parsed-count + parse-error summary.
   - Concurrency and placement-timeout controls (sensible defaults).
   - **Test All** / **Cancel** buttons.
   - Live results table: Host · User · Status chip (color-coded) · Latency ·
     Detail (per-seed placement, error reason). Sortable; filter by status.
   - **Export CSV / JSON**.

2. **Settings**
   - Seed mailbox list (add/edit/remove) with a **Test login** button per seed
     (validates IMAP connect/auth and lists detected folders).
   - Default From address, test subject/body template, timeouts.
   - Inline setup help: how to get an app-password + enable IMAP for Gmail/
     Outlook/Yahoo.

## Error handling

- Every network op has an explicit timeout; no hang.
- SMTP/IMAP errors are caught and surfaced as human-readable reasons, never crash
  the batch — one bad credential never stops the others.
- Cancel stops dispatching new tests and lets in-flight ones settle.
- Seed IMAP failure during placement marks that seed `error` for the result but
  still reports other seeds; overall status falls back to `Valid` + note if no
  placement could be determined.

## Testing

- **parser.js** and **classify.js**: TDD with fixture tables (pure functions,
  the core logic). Cover each delimiter, comments, blanks, malformed lines, the
  aggregation matrix.
- **smtp.js**: integration test against an in-process test SMTP server
  (`smtp-server`) — assert connect/auth success + failure paths.
- **imap.js**: thin wrapper; test token-matching logic against a fake/stubbed
  IMAP response where practical, else manual verification documented.
- **tester.js**: test concurrency limit + progress callback with stubbed
  smtp/imap modules.
- No live third-party credentials in automated tests.

## Build & distribution

- `electron-builder`. Targets: `dmg`+`zip` (mac), `nsis` (Windows `.exe`).
- GitHub Actions workflow: on tag/push, build mac on macos runner + Windows on
  windows runner, upload artifacts. Documented in README.
- Local `npm run dev` for development, `npm run dist:mac` for local mac build.

## Security & honesty notes (surfaced in-app)

- Seed placement is a strong signal, not a per-recipient guarantee (mailbox
  providers personalize placement by reputation/engagement).
- Seed accounts need IMAP enabled + an app-password (2FA prerequisite).
- Placement has inherent latency; the poll timeout is user-configurable.
- Credentials and app-passwords are stored locally only (electron-store on the
  user's disk). Documented; not synced anywhere.
- Keep test volume modest to avoid flagging the seed accounts themselves.

## Out of scope (YAGNI)

- OAuth seed login (app-passwords only for v1).
- Paid seed-test service integration.
- Scheduling/automation, multi-user, cloud sync, web deployment.
- SPF/DKIM/DMARC deep analysis (may report what the provider set, but not a focus).

## Open decisions (resolved defaults)

- **Password containing `:`** — for colon/pipe formats, we split into exactly 4
  fields max (host, port, user, rest-as-pass) so passwords may contain the
  delimiter after the 3rd one. CSV uses standard quoting. Documented in UI.
- **Default concurrency** 5; **placement timeout** 90s; **poll interval** 5s.
- **Status when seeds configured but SMTP send succeeds and nothing found** →
  `Unknown placement` (distinct from `Valid`).
