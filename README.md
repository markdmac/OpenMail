# OpenMail

OpenMail is an open-source, Outlook-style desktop mail client for Windows. It downloads your Gmail into an **Outlook PST file**, files messages into folders, and keeps your inbox tidy with **Outlook-style rules**. Gmail becomes the delivery pipe; the PST becomes where your mailbox lives.

> Status: early (0.1). The core pipeline (Gmail → PST, rules, three-pane reader, compose) works. Calendar, contacts and tasks are on the roadmap.

## How it works

1. **Initial sync.** Every message in Gmail (except Spam and Trash) is downloaded and filed into the PST:
   - Gmail labels become PST folders (`Work/Clients` becomes the folder `Work` › `Clients`).
   - Mail with no user label goes to `Inbox`, `Sent Items` or `Archive`.
   - A message with several labels is filed under its first label; the other labels become Outlook **categories**, along with Gmail's Promotions, Social, Updates and Forums tabs.
   - Starred messages are flagged, and read/unread state is preserved.
2. **Ongoing sync** (every few minutes, through the Gmail History API):
   - A new message that is **still unread** is downloaded, filed into the PST, then **moved to Gmail Trash**.
   - A new message that was **already read** by the time OpenMail sees it (say you read it on your phone) **stays in Gmail and is ignored**.
   - Sent mail is archived to `Sent Items` and left in Gmail (configurable).
3. **Rescuing mail.** If you want a message back in Gmail, move it out of Gmail Trash. OpenMail records every message ID it has handled, so it never processes that message again.

### Safety

- **Nothing is ever trashed in Gmail until you turn on "Enable trashing" in Settings.** Until then OpenMail only copies.
- A message is moved to Gmail Trash only after Outlook has confirmed it is saved in the PST.
- An optional raw `.eml` backup of every downloaded message is kept (on by default).
- ⚠️ **Gmail permanently deletes anything that has been in Trash for 30 days.** Rescue messages within that window.
- OpenMail uses the `gmail.modify` scope, which cannot permanently delete mail.

## Features

| Area | What's there |
|---|---|
| Mailbox | Three-pane Outlook-style UI, folder tree with unread counts, search, unread filter, drag-and-drop to folders |
| Reading | HTML mail in a locked-down sandbox; remote images blocked until you allow them; inline images; save attachments |
| Actions | Reply, Reply All, Forward, Delete (PST Deleted Items), Move, Mark read/unread, Flag, Open in Outlook |
| Compose | Rich-text editor, Cc/Bcc, attachments; sends through Gmail so replies thread correctly |
| Folders | Create, rename, delete, nest |
| Rules | Conditions: from, to, cc, subject, body, sender domain, Gmail label, attachment, newsletter, unread, age, size. Actions: move to folder, categorise, mark read, flag, keep in Gmail, trash in Gmail, don't archive, trash without archiving. All/any matching, stop processing, ordering |
| Clean-up | Preview any rule against mail already in Gmail, then run it ("Run on Gmail now") |
| PST | Unicode PST written through your installed Outlook; also browsable in Outlook itself |

## Requirements

- Windows 10 or 11
- **Microsoft Outlook (desktop, 2013 or later)** installed. OpenMail drives it through COM to write the PST.
- Node.js 20+ (only for development and building)
- A Google account, plus a free Google Cloud OAuth client (below)

## 1. Create your Google OAuth client (one time, about 5 minutes)

Each user brings their own OAuth client, so there's no central server and your mail never touches anyone else's infrastructure.

1. Go to <https://console.cloud.google.com/> and create a project (for example "OpenMail").
2. **APIs & Services › Library**: search for **Gmail API** and click **Enable**.
3. **APIs & Services › OAuth consent screen** (or "Google Auth Platform"):
   - User type **External**. Fill in the app name and your email.
   - **Scopes**: add `https://www.googleapis.com/auth/gmail.modify`.
   - **Test users**: add your Gmail address.
4. **Credentials › Create credentials › OAuth client ID** › Application type **Desktop app**. Copy the **Client ID** and **Client secret**.
5. Important: while the consent screen is in **Testing**, Google expires refresh tokens after **7 days**, and you'd have to sign in again weekly. To avoid that, click **Publish app** ("In production"). For personal use you don't need Google's verification. You'll see an "unverified app" warning when you sign in; click *Advanced › Go to OpenMail*.

## 2. Install and run

```bash
git clone <your-fork-url> openmail
cd openmail
npm install
npm start
```

In the app, open **Settings**:

1. Paste the client ID and secret, then click **Sign in with Google**. Your browser opens; approve access.
2. Choose where the PST should live. The default is `Documents\OpenMail\OpenMail.pst`.
3. Review the sync options and click **Save**.
4. Click **Sync Now** (F9). The initial sync is resumable: you can close the app and it will continue next time.
5. Once you're happy with what's in the PST, go back to Settings and turn on **Enable trashing**.

## Build an installer

```bash
npm run dist
```

This produces an NSIS installer and a portable `.exe` in `dist/`.

## Tests

```bash
npm test               # unit tests: CFB/MSG writer, rules engine
npm run test:outlook   # end-to-end: builds a message, imports it into a throwaway PST via Outlook, reads it back
```

## Architecture

```
src/
  main/                     Electron main process
    main.js                 window + IPC
    store.js                settings, sync state, rules, DPAPI-encrypted tokens, processed-message ledger
    sync-engine.js          initial / incremental sync, trash policy, label → folder mapping, rule runs
    rules.js                rule evaluation + compilation to Gmail search queries
    compose.js              outgoing MIME (nodemailer)
    gmail/
      google-auth.js        OAuth 2.0 loopback + PKCE
      gmail-client.js       Gmail REST client with backoff
    msg/
      from-mime.js          RFC 822 → normalized message (mailparser)
      msg-writer.js         normalized message → Outlook .msg (MS-OXMSG)
      cfb-writer.js         Compound File Binary writer (MS-CFB)
    outlook/
      outlook-bridge.js     JSON-lines RPC to a long-lived PowerShell worker
      outlook-worker.ps1    Outlook COM: PST store, folders, import, listing, item ops
  renderer/                 UI (plain HTML/CSS/JS, no framework)
```

**Getting mail into the PST:** each Gmail message is downloaded as raw MIME, converted to an Outlook `.msg` file in-process (headers, HTML and plain-text bodies, recipients, attachments, inline images, sent and received times, read state), opened by Outlook with `Namespace.OpenSharedItem`, and moved into the target PST folder. This keeps the original dates and sender intact, which composing items through the Outlook object model can't do.

**Where state lives** (`%APPDATA%\OpenMail`): `settings.json`, `rules.json`, `sync-state.json`, `tokens.bin` (encrypted with Windows DPAPI), and `processed.log`, an append-only ledger of every Gmail message ID handled.

## Roadmap

- Calendar and contacts (Google Calendar / People API ↔ PST)
- A native PST writer (MS-PST), so Outlook is no longer required
- IMAP accounts besides Gmail
- Multi-select actions, conversation view, signatures, drafts
- Scheduled rule runs, rule import/export

## Contributing

PRs are welcome. Please run `npm test` and, if you touch the MSG writer or the Outlook worker, `npm run test:outlook`.

## License

MIT
