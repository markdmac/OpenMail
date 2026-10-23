'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { Store } = require('./store');
const { GoogleAuth } = require('./gmail/google-auth');
const { GmailClient } = require('./gmail/gmail-client');
const { StoreClient } = require('./store/store-client');
const { SyncEngine } = require('./sync-engine');
const rules = require('./rules');
const { buildMime } = require('./compose');

// Developer/testing aid: run with a separate settings folder (OPENMAIL_PROFILE=C:\path\to\profile).
if (process.env.OPENMAIL_PROFILE) app.setPath('userData', process.env.OPENMAIL_PROFILE);

let win;
let store;
let auth;
let gmail;
let mailbox;
let sync;
let profile = null;
const logBuffer = [];

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(line) {
  logBuffer.push(line);
  if (logBuffer.length > 2000) logBuffer.shift();
  send('log', line);
}

function openMailbox() {
  return mailbox.open(store.settings.pstPath, store.settings.pstDisplayName);
}

async function loadProfile() {
  if (!auth.isSignedIn()) return null;
  try {
    profile = await gmail.profile();
  } catch (e) {
    log(`Could not load Gmail profile: ${e.message}`);
  }
  return profile;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'OpenMail',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon-256.png'),
    backgroundColor: '#f3f2f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links clicked inside messages open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    }
  });
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, result: await fn(...args) };
    } catch (err) {
      log(`${channel} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}

/** Mailbox calls: make sure the PST is open first. */
function mb(cmd, mapArgs = (a) => a) {
  return async (...args) => {
    await openMailbox();
    return mailbox.call(cmd, mapArgs(...args));
  };
}

function registerIpc() {
  handle('app:info', async () => {
    let mailboxInfo = null;
    let mailboxError = null;
    try {
      mailboxInfo = await openMailbox();
    } catch (e) {
      mailboxError = e.message;
    }
    return {
      settings: store.settings,
      state: store.state,
      signedIn: auth.isSignedIn(),
      email: profile?.emailAddress || null,
      status: sync.status,
      log: logBuffer.slice(-300),
      meta: { fields: rules.FIELDS, operators: rules.OPERATORS, actions: rules.ACTIONS },
      version: app.getVersion(),
      mailbox: mailboxInfo,
      mailboxError,
    };
  });

  handle('settings:save', async (patch) => {
    const before = store.settings.pstPath;
    const s = store.saveSettings(patch);
    if (s.pstPath !== before) mailbox.opened = null;
    sync.startPolling();
    return s;
  });

  handle('auth:signIn', async () => {
    await auth.signIn();
    await loadProfile();
    sync.startPolling();
    return { email: profile?.emailAddress };
  });

  handle('auth:signOut', async () => {
    sync.stop();
    sync.stopPolling();
    await auth.signOut();
    profile = null;
    return true;
  });

  // ---- Mailbox (PST)
  handle('mailbox:open', async () => openMailbox());
  handle('mailbox:check', mb('check'));
  handle('mailbox:emptyDeleted', mb('emptyDeletedItems'));
  handle('mailbox:import', async (filePath, prefix) => {
    await openMailbox();
    let src = filePath;
    if (!src) {
      const r = await dialog.showOpenDialog(win, { title: 'Import Outlook data file', filters: [{ name: 'Outlook Data File', extensions: ['pst'] }], properties: ['openFile'] });
      if (r.canceled) return null;
      src = r.filePaths[0];
    }
    if (path.resolve(src).toLowerCase() === path.resolve(store.settings.pstPath).toLowerCase()) throw new Error('That is the mailbox file itself.');
    log(`Importing ${src}${prefix ? ` into "${prefix}"` : ''}…`);
    const result = await mailbox.call('importPst', { path: src, targetPrefix: prefix || '', skipDuplicates: true });
    log(`Import finished: ${result.messages} messages in ${result.folders} new folders, ${result.duplicates} duplicates skipped, ${result.errors} errors.`);
    return result;
  });
  /** Converts an old ANSI mailbox to a new Unicode PST next to it and switches to it. */
  handle('mailbox:convert', async () => {
    const info = await openMailbox();
    if (info.unicode) return info;
    const oldPath = info.path;
    const dir = path.dirname(oldPath);
    let newPath = path.join(dir, `${path.basename(oldPath, '.pst')} (Unicode).pst`);
    for (let i = 2; fs.existsSync(newPath); i++) newPath = path.join(dir, `${path.basename(oldPath, '.pst')} (Unicode ${i}).pst`);
    await mailbox.call('close');
    mailbox.opened = null;
    await mailbox.open(newPath, store.settings.pstDisplayName);
    log(`Converting ${oldPath} → ${newPath}…`);
    const result = await mailbox.call('importPst', { path: oldPath, targetPrefix: '', skipDuplicates: true });
    store.saveSettings({ pstPath: newPath });
    log(`Converted: ${result.messages} messages copied. The old file was left unchanged at ${oldPath}.`);
    return { ...(await mailbox.call('info')), converted: result };
  });

  handle('folders:list', mb('folders'));
  handle('folders:create', mb('ensureFolder', (p) => ({ path: p })));
  handle('folders:rename', mb('renameFolder', (p, newName) => ({ path: p, newName })));
  handle('folders:delete', mb('deleteFolder', (p) => ({ path: p })));
  handle('folders:move', mb('moveFolder', (p, newParentPath) => ({ path: p, newParentPath })));

  handle('items:list', mb('listItems'));
  handle('items:get', mb('getItem', (id) => ({ id })));
  handle('items:idsFromSender', mb('idsFromSender', (folderPath, from) => ({ folderPath, from })));
  handle('items:setRead', mb('setRead', (ids, read) => ({ ids, read })));
  handle('items:flag', mb('setFlag', (ids, flagged) => ({ ids, flagged })));
  handle('items:categories', mb('setCategories', (ids, categories) => ({ ids, categories })));
  handle('items:move', mb('moveItems', (ids, folderPath) => ({ ids, folderPath })));
  handle('items:delete', mb('deleteItems', (ids) => ({ ids })));
  handle('items:saveAttachment', async (id, attachmentId, name) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
    if (canceled) return null;
    await openMailbox();
    return mailbox.call('saveAttachment', { id, attachmentId, path: filePath });
  });
  handle('items:openAttachment', async (id, attachmentId, name) => {
    await openMailbox();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmail-att-'));
    const file = path.join(dir, name.replace(/[\\/:*?"<>|]/g, '_'));
    await mailbox.call('saveAttachment', { id, attachmentId, path: file });
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return file;
  });

  // ---- Sync
  handle('sync:now', async () => {
    const info = await openMailbox();
    if (!info.unicode) throw new Error('Your mailbox is in the old ANSI format. Convert it first (Settings → Mailbox).');
    sync.syncNow().catch((e) => log(`Sync failed: ${e.message}`));
    return true;
  });
  handle('sync:stop', async () => {
    sync.stop();
    return true;
  });
  handle('sync:resetInitial', async () => {
    if (sync.running) throw new Error('Pause the sync first');
    store.resetSync();
    return store.state;
  });

  // ---- Rules
  handle('rules:list', async () => store.rules);
  handle('rules:new', async () => rules.newRule());
  handle('rules:save', async (list) => store.saveRules(list));
  handle('rules:preview', async (rule) => sync.previewRule(rule));
  handle('rules:run', async (rule) => {
    await openMailbox();
    sync.runRuleNow(rule).catch((e) => log(`Rule run failed: ${e.message}`));
    return true;
  });

  // ---- Compose
  handle('mail:send', async (draft) => {
    if (!profile) await loadProfile();
    const raw = await buildMime({ ...draft, from: profile.emailAddress });
    const res = await gmail.send(raw);
    log(`Sent "${draft.subject}" to ${draft.to}`);
    return res;
  });
  handle('dialog:pickFiles', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return canceled ? [] : filePaths;
  });
  handle('dialog:pickPst', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Choose or create the mailbox PST file',
      defaultPath: store.settings.pstPath,
      filters: [{ name: 'Outlook Data File', extensions: ['pst'] }],
    });
    return canceled ? null : filePath;
  });
  handle('dialog:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return canceled ? null : filePaths[0];
  });
  handle('shell:openPath', async (p) => shell.openPath(p));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  store = new Store();
  auth = new GoogleAuth(store);
  gmail = new GmailClient(auth);
  mailbox = new StoreClient();
  mailbox.on('log', log);
  mailbox.on('error', log);
  mailbox.on('import-progress', (p) => send('import:progress', p));
  sync = new SyncEngine({ store, gmail, mailbox });
  sync.on('log', log);
  sync.on('status', (s) => send('sync:status', s));

  registerIpc();
  createWindow();

  if (auth.isSignedIn()) {
    await loadProfile();
    sync.startPolling();
    // Resume automatically only if the user has already started syncing once.
    if (store.state.initialStartedAt) {
      openMailbox()
        .then((info) => (info.unicode ? sync.syncNow() : log('Sync paused until the mailbox is converted to Unicode.')))
        .catch((e) => log(`Startup sync failed: ${e.message}`));
    }
  }
});

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  sync?.stop();
  try {
    await sync?.flushTrash();
  } catch {
    /* ignore */
  }
  await mailbox?.stop();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
