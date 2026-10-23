# OpenMail

OpenMail is an open-source, Outlook-style desktop mail client for Windows. It downloads your Gmail into a **standard Outlook PST file**, files messages into folders, and keeps your inbox tidy with **Outlook-style rules**. Gmail becomes the delivery pipe; the PST becomes where your mailbox lives.

**Outlook is not required.** OpenMail has its own PST engine that reads and writes PST files directly. The files are fully compatible with Outlook, so you can open them in Outlook, and you can import any existing PST (including old Outlook 97–2002 ANSI files) into OpenMail.

> Status: early (0.2). Gmail → PST sync, rules, the three-pane reader, compose, PST import and the native PST engine all work. Calendar, contacts and tasks are on the roadmap.

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
| Reading | HTML mail in a locked-down sandbox; remote images blocked until you allow them; inline images; open or save attachments |
| Actions | Reply, Reply All, Forward, Delete (to Deleted Items; permanent from there), Move, Mark read/unread, Flag |
| Compose | Rich-text editor, Cc/Bcc, attachments; sends through Gmail so replies thread correctly |
| Folders | Create, rename, delete, nest |
| Rules | Conditions: from, to, cc, subject, body, sender domain, Gmail label, attachment, newsletter, unread, age, size. Actions: move to folder, categorise, mark read, flag, keep in Gmail, trash in Gmail, don't archive, trash without archiving. All/any matching, stop processing, ordering |
| Clean-up | Preview any rule against mail already in Gmail, then run it ("Run on Gmail now") |
| PST | Native read/write PST engine (no Outlook needed); Outlook-compatible Unicode files; reads old ANSI PSTs; import any PST with folders, attachments and categories; built-in file integrity check |
| Bulk clean-up | Sort by sender, subject, date or size; group by sender with "select all / move all / delete all"; Ctrl/Shift multi-select; drag many messages onto a folder |

## Requirements

- Windows 10 or 11 (the PST engine itself is plain JavaScript and also runs on macOS/Linux)
- Node.js 20+ (only for development and building)
- Microsoft Outlook is **not** required
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
2. Choose where the PST should live. The default is `Documents\OpenMail\Mailbox.pst` (created automatically).
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
npm test    # PST engine (create/read/write/stress, checked by an integrity checker and by pst-extractor), rules engine
```

Developer tools (optional; the Outlook-based ones are only for cross-checking compatibility):

| Command | Purpose |
|---|---|
| `node src/main/pst/pst-check.js file.pst` | Integrity check (B-trees, checksums, reference counts, allocation maps) |
| `node scripts/pst-dump.js file.pst [--ltp] [--blocks]` | Dump a PST's internal structure |
| `powershell -File scripts/outlook-verify.ps1 -Pst copy.pst` | Open a PST in Outlook and list what Outlook sees (needs Outlook) |
| `node scripts/make-reference-psts.js` | Have Outlook generate reference PSTs (needs Outlook) |
| `node scripts/gen-pst-template.js empty.pst` | Regenerate the new-PST template from an empty Outlook PST |

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
    store/
      store-worker.js       worker thread that owns the open PST (the UI never blocks)
      store-client.js       promise API used by the main process
      pst-import.js         copies another PST into the mailbox, property for property
    pst/                    native PST engine ([MS-PST])
      ndb.js, ndb-writer.js node database: header, B-trees, blocks, allocation maps, copy-on-write commits
      ltp.js                heap-on-node, BTH, property and table contexts
      pst-store.js          messaging layer: folders, messages, recipients, attachments
      named-props.js        named property map (categories etc.)
      pst-create.js         new empty PSTs (from pst-template.json)
      pst-check.js          integrity checker
  renderer/                 UI (plain HTML/CSS/JS, no framework)
```

**Getting mail into the PST:** each Gmail message is downloaded as raw MIME, parsed, and written straight into the PST by OpenMail's engine: headers, HTML and plain-text bodies, recipients, attachments, inline images, sent and received times, read state, categories and flags.

**The PST engine** implements Microsoft's published [MS-PST] format. Its output was verified against files Outlook itself creates, by having Outlook open OpenMail-written files, and with an independent reader ([pst-extractor](https://github.com/epfromer/pst-extractor)). Commits are copy-on-write and crash-safe: the header is switched to the new trees first and the allocation maps are flagged as "being updated", so an interrupted write is detected and repaired on the next open, the same way Outlook does it. Messages are moved to Gmail Trash only after the PST holding them has been committed to disk.

**One program at a time:** don't open the same PST in Outlook while OpenMail has it open. OpenMail detects Outlook's file lock and asks you to close the file there.

**Where state lives** (`%APPDATA%\OpenMail`): `settings.json`, `rules.json`, `sync-state.json`, `tokens.bin` (encrypted with Windows DPAPI), and `processed.log`, an append-only ledger of every Gmail message ID handled.

## Roadmap

- Calendar and contacts (Google Calendar / People API ↔ PST)
- Open additional PSTs side by side (read-only browsing without importing)
- IMAP accounts besides Gmail
- Multi-select actions, conversation view, signatures, drafts
- Scheduled rule runs, rule import/export

## Contributing

PRs are welcome. Please run `npm test` and, if you touch the MSG writer or the Outlook worker, `npm run test:outlook`.

## License

MIT
