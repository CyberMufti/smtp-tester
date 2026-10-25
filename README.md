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

Paste directly or click **Load file** to import a `.txt`/`.csv`. The parser
auto-detects the shape, so you rarely have to reformat a provider's export.

**Delimited lines** — one credential per line, fields separated by any of
`:` `,` `;` `|`, a tab, or spaces:

```
smtp.example.com:587:user@example.com:secret
smtp.example.com,587,user@example.com,secret
smtp.example.com 587 user@example.com secret
```

Field order doesn't have to be standard — the numeric field is taken as the
**port** and the hostname-looking field as the **host**, so
`user pass host port` also parses. A password may contain the delimiter; a
trailing field is treated as a custom **From** address only when it looks like
an email. For CSV, wrap a field in double quotes if it contains a comma.

**Labeled key-value blocks** — when lines look like `Label: value` or
`Label = value`, each blank-line-separated block becomes one credential:

```
Host: smtp.sendgrid.net
Port: 587
Username: apikey
Password: SG.xxxxxxxx

Server = smtp.mailgun.org
Port = 587
Login = postmaster@mg.example.com
Pwd = secret
```

Labels are matched by synonym (Host/Server/SMTP, Port, User/Login/Email,
Password/Pwd/Key, From/Sender), case-insensitively. Lines starting with `#`
are ignored.

**Just an email + password** — for a known provider you can skip the host
entirely; the app fills it in (see below):

```
someone@gmail.com:app-password
someone@outlook.com password
```

## Auto host/port detection & fallback

- **Missing host** — if you supply only `email:password` and the email is at a
  recognized provider (Gmail, Outlook/Hotmail, Yahoo, iCloud, Zoho, AOL, GMX,
  Yandex, Office 365, …), the app resolves the SMTP host and port for you.
- **Wrong host or port** — the app always tries exactly what you typed **first**.
  Only if that endpoint can't connect does it fall back to the known-correct
  host/port for the provider before deciding the credential is dead. When a
  fallback succeeds, the result shows which endpoint actually worked.

AWS SES is region-specific (`email-smtp.<region>.amazonaws.com`) and can't be
auto-detected — supply its host explicitly.

## Verifying placement yourself

On the Test screen there's a **Your test inboxes** box. Enter one or more of
your own email addresses; the app sends each credential's uniquely-tagged test
message to them. Each result row shows the unique token, so you can open your
mailbox, search for that token, and confirm Inbox vs Spam with your own eyes —
no IMAP setup required. (If an address is also configured as an IMAP seed in
Settings, the app classifies it automatically too.)

The results header shows a **live count** of Inbox / Spam / Valid / Unknown /
Dead as the batch runs.

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
