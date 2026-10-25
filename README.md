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

**Just an email + password** — you can skip the host entirely for **any**
domain; the app discovers the server (see below):

```
someone@gmail.com:app-password
someone@mycompany.com:Secret#123
```

## Auto host/port detection & fallback

- **Missing host** — supply only `email:password` and the app discovers the
  SMTP server from the email domain, in this order: a recognized public
  provider (Gmail, Outlook, Yahoo, iCloud, Zoho, …); the domain's **MX records**
  mapped to the real submission host (so a custom domain hosted on
  Zoho / Google Workspace / Microsoft 365 / GoDaddy is sent correctly); and
  finally guessed `smtp.<domain>` / `mail.<domain>`. Each candidate is tried on
  ports 587 then 465 until one authenticates.
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

## Deliverability checks

Tick **Deliverability checks** on the Test screen (on by default) to run three
extra analyses that explain *why* mail may be landing in spam:

- **SPF / DMARC** — looks up the From domain's SPF (`TXT`) and DMARC
  (`_dmarc.<domain>` `TXT`) records and flags a missing SPF, a soft/neutral
  `all` qualifier, or a `p=none` DMARC policy. When you use IMAP seeds, each
  result also shows **spf/dkim/dmarc as the receiving provider actually
  evaluated them**, read from the delivered message's `Authentication-Results`
  header — the most reliable signal there is.
- **Blacklist (DNSBL)** — resolves the sending host's IP and checks it against
  Spamhaus, Barracuda, SpamCop, and SORBS. A listed IP is a strong reason for
  spam placement.
- **Content spam score** — a fast heuristic pass over the message (ALL-CAPS
  subject, trigger words, link density, shortened URLs, missing unsubscribe,
  image-heavy body). Use **Settings → Check your campaign content** to score
  your *real* campaign copy before sending — this closes the biggest accuracy
  gap, since the built-in test message isn't your actual content.

These checks are **heuristics and signals, not guarantees**. They tell you where
the obvious problems are; they can't perfectly predict a specific provider's
decision. See the accuracy notes above.

## Saving your working list

The results table always shows the host/port that actually worked — including an
auto-detected or fallback endpoint, marked `(auto)`. **Save working SMTPs
(.txt)** writes every non-dead credential to a plain-text file as
`host:port:username:password` using that resolved endpoint, grouped by Inbox /
Spam / Valid / Unknown. That file re-imports directly (the group headers are
`#` comments the parser ignores), so your verified working list becomes the
input for your next run. CSV/JSON exports with full per-credential detail are
also available.

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

## Licensing & activation

The app is gated: on first launch it shows an **activation screen** with the
machine's **Hardware ID (HWID)** and the Telegram contact **@splean_tool**
("contact splean_tool for license key"). The user sends you their HWID on
Telegram; you issue a license key bound to that HWID; they paste it and the app
unlocks. The key is stored locally so they only activate once.

### How it works

Licensing is **offline and signature-based** (Ed25519):

- The app embeds only the **public** key (`src/core/license-public-key.js`).
- You hold the **private** key (`owner-keys/private.pem`) — it is **gitignored
  and must never be committed or shared**.
- A license key is your signature over the user's HWID, so only you can issue a
  valid key, and a key only works on the machine it was issued for. Keys can't
  be forged or shared between machines.

> **Honest limitation:** this prevents forging and key-sharing, but like all
> client-side licensing it does not stop someone from patching the check out of
> a local copy. It's a strong deterrent, not unbreakable DRM. A server check
> would be needed for that.

### Issuing a license (owner)

When a user sends you their HWID on Telegram:

```bash
node scripts/issue-license.js 16DA-426B-8DEA-32BA-1A4F-939A          # never expires
node scripts/issue-license.js 16DA-426B-8DEA-32BA-1A4F-939A --days 30  # 30-day license
```

It prints a `SPL1.…` license key — send that back to the user.

> **Back up `owner-keys/private.pem`.** If you lose it you can't issue new
> licenses, and you'd have to ship a new app build with a new embedded public
> key (invalidating every existing license). It is intentionally excluded from
> packaged builds, so it never ships to users.

### Activating from a Telegram bot

`scripts/telegram-bot.js` lets you approve users and deliver keys entirely from
Telegram. Run it on the machine that holds your private key (your PC/server) —
**never ship the bot or the key to users.**

1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Start the bot once and message it `/whoami` — it replies with your numeric
   **chat id** (that's your admin id).
3. Run it with your token and admin id:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... ADMIN_CHAT_IDS=111111111 npm run bot
```

**How activation works in Telegram:**

- A user opens the app, copies their **HWID**, and sends it to your bot.
- You (admin) get a message showing who requested it and the HWID, with buttons:
  **✅ Activate (never expires)** · **✅ 30 days** · **❌ Deny**.
- One tap signs the license and the bot **delivers the key straight to the
  user**, who pastes it into the app. Deny notifies them instead.
- Shortcut: as an admin you can also just send the bot an HWID (or
  `/issue <HWID> [days]`) to get the key immediately and forward it yourself.

`ADMIN_CHAT_IDS` is comma-separated for multiple admins. The bot is
dependency-free (Telegram Bot API over long polling) and keeps no database —
approvals are encoded in the button, so a restart loses nothing but
not-yet-answered requests.

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
