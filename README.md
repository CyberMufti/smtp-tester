# SMTP Tester

A desktop app for bulk-testing SMTP relay credentials (SendGrid, Resend, AWS SES,
Mailgun, and anything else that speaks SMTP). Paste a list of credentials, click
**Test All**, and get a per-credential verdict:

| Status | Meaning |
|--------|---------|
| **Dead** | Could not connect, could not authenticate, or the server refused the message. |
| **Valid** | Authenticated and accepted the message for delivery (placement not evaluated). |
| **Inbox** | Test mail landed in the **Inbox** of your seed mailbox(es). |
| **Spam** | Test mail landed in the **Junk/Spam** folder of a seed mailbox. |
| **Unknown placement** | Sent successfully, but the test mail wasn't found before the timeout. |

## How it works

For each credential the app runs a tiered pipeline — each step only runs if the
previous one passed:

1. **Connect** to the SMTP host/port.
2. **Authenticate** with the username/password.
3. **Send** a uniquely-tagged test email to your seed mailboxes.
4. **Placement** — log into each seed mailbox over IMAP and find which folder
   the tagged email landed in.

The "inbox vs spam" result comes from **your own seed mailboxes** — real inboxes
you control (Gmail, Outlook, Yahoo). This is the same technique commercial
seed-testing services use.

## Input formats

One credential per line. The parser auto-detects the delimiter:

```
host:port:user:pass
host,port,user,pass
host|port|user|pass
```

An optional 5th field sets a custom **From** address. Lines starting with `#`
are ignored. For CSV, wrap a field in double quotes if it contains a comma.

## Setting up seed mailboxes

Placement testing needs at least one mailbox you control, configured in
**Settings → Seed mailboxes**. Each seed needs IMAP enabled and an **app
password** (not your normal login password), which requires 2-Step
Verification on the account:

- **Gmail** — enable 2FA, create an app password at
  `myaccount.google.com/apppasswords`. IMAP: `imap.gmail.com:993`.
- **Outlook / Microsoft 365** — enable 2FA, create an app password in Security
  settings. IMAP: `outlook.office365.com:993`.
- **Yahoo** — Account Security → Generate app password. IMAP:
  `imap.mail.yahoo.com:993`.

Use **Test login** next to each seed to confirm the credentials work before
running a batch. With **no** seeds configured, the app still reports Dead/Valid
(it tests send capability only, no placement).

## Honest caveats

- **Seed placement is a strong signal, not a per-recipient guarantee.** Mailbox
  providers personalize placement by reputation and engagement, so an "Inbox"
  result on your seed won't be identical for every recipient. More seeds across
  different providers = a broader picture.
- Use ports **587** or **465**. Port 25 is usually blocked by ISPs.
- Placement has inherent latency (mail takes seconds to arrive); the poll
  timeout is configurable in Settings.
- Keep test volume modest so your seed accounts don't themselves get flagged.
- All credentials and app passwords are stored **only on your computer**
  (via `electron-store`); nothing is synced anywhere.

## Running from source

```bash
npm install
npm run dev     # launch the app
npm test        # run the unit/integration suite
```

## Building installers

```bash
npm run dist:mac   # builds dist/*.dmg and dist/*.zip (run on macOS)
npm run dist:win   # builds dist/*.exe (run on Windows)
```

### Getting a Windows `.exe` without a Windows machine

Cross-building a Windows installer from macOS is unreliable, so this repo
includes a GitHub Actions workflow (`.github/workflows/build.yml`) that builds
on both `macos-latest` and `windows-latest`. Push to `main` (or trigger the
workflow manually), then download the `smtp-tester-win` / `smtp-tester-mac`
artifacts from the workflow run.

## Project layout

```
src/
  core/      pure Node engine (parser, classify, smtp, imap, tester) — unit-tested
  main/      Electron main process + settings store
  renderer/  UI (Test & Settings screens)
  preload.cjs  contextBridge API exposed to the renderer
tests/       node:test suites for the core engine
```
