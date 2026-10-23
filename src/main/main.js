'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { Store } = require('./store');
const { GoogleAuth } = require('./gmail/google-auth');
const { GmailClient } = require('./gmail/gmail-client');
const { OutlookBridge } = require('./outlook/outlook-bridge');
const { SyncEngine } = require('./sync-engine');
const rules = require('./rules');
const { buildMime } = require('./compose');

let win;
let store;
let auth;
let gmail;
let outlook;
let sync;
let profile = null;
let pstReady = null;
const logBuffer = [];

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(line) {
  logBuffer.push(line);
  if (logBuffer.length > 2000) logBuffer.shift();
  send('log', line);
}

function ensurePst() {
  if (!pstReady) {
    pstReady = outlook.init(store.settings.pstPath, store.settings.pstDisplayName).catch((e) => {
      pstReady = null;
      throw e;
    });
  }
  return pstReady;
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

function registerIpc() {
  handle('app:info', async () => ({
    settings: store.settings,
    state: store.state,
    signedIn: auth.isSignedIn(),
    email: profile?.emailAddress || null,
    status: sync.status,
    log: logBuffer.slice(-300),
    meta: { fields: rules.FIELDS, operators: rules.OPERATORS, actions: rules.ACTIONS },
    version: app.getVersion(),
  }));

  handle('settings:save', async (patch) => {
    const before = store.settings.pstPath;
    const s = store.saveSettings(patch);
    if (s.pstPath !== before) pstReady = null;
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

  // ---- PST / folders / items (all via Outlook) ----
  handle('pst:open', async () => ensurePst());
  handle('folders:list', async () => {
    await ensurePst();
    return outlook.call('listFolders');
  });
  handle('folders:create', async (p) => {
    await ensurePst();
    return outlook.call('ensureFolder', { path: p });
  });
  handle('folders:rename', async (p, newName) => {
    await ensurePst();
    return outlook.call('renameFolder', { path: p, newName });
  });
  handle('folders:delete', async (p) => {
    await ensurePst();
    return outlook.call('deleteFolder', { path: p });
  });
  handle('items:list', async (args) => {
    await ensurePst();
    return outlook.call('listItems', args);
  });
  handle('items:get', async (entryId) => {
    await ensurePst();
    return outlook.call('getItem', { entryId });
  });
  handle('items:setRead', async (entryIds, unread) => outlook.call('setRead', { entryIds, unread }));
  handle('items:flag', async (entryIds, flagged) => outlook.call('setFlag', { entryIds, flagged }));
  handle('items:categories', async (entryIds, categories) => outlook.call('setCategories', { entryIds, categories }));
  handle('items:move', async (entryIds, folderPath) => outlook.call('moveItems', { entryIds, folderPath }));
  handle('items:delete', async (entryIds) => outlook.call('deleteItems', { entryIds }));
  handle('items:openInOutlook', async (entryId) => outlook.call('openInOutlook', { entryId }));
  handle('items:saveAttachment', async (entryId, index, name) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
    if (canceled) return null;
    return outlook.call('saveAttachment', { entryId, index, path: filePath });
  });

  // ---- Sync ----
  handle('sync:now', async () => {
    await ensurePst();
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

  // ---- Rules ----
  handle('rules:list', async () => store.rules);
  handle('rules:new', async () => rules.newRule());
  handle('rules:save', async (list) => store.saveRules(list));
  handle('rules:preview', async (rule) => sync.previewRule(rule));
  handle('rules:run', async (rule) => {
    await ensurePst();
    sync.runRuleNow(rule).catch((e) => log(`Rule run failed: ${e.message}`));
    return true;
  });

  // ---- Compose ----
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
      title: 'Choose or create a PST file',
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
  outlook = new OutlookBridge();
  outlook.on('log', log);
  sync = new SyncEngine({ store, gmail, outlook });
  sync.on('log', log);
  sync.on('status', (s) => send('sync:status', s));

  registerIpc();
  createWindow();

  if (auth.isSignedIn()) {
    await loadProfile();
    sync.startPolling();
    // Resume automatically only if the user has already started syncing once.
    if (store.state.initialStartedAt) {
      ensurePst()
        .then(() => sync.syncNow())
        .catch((e) => log(`Startup sync failed: ${e.message}`));
    }
  }
});

app.on('window-all-closed', () => {
  sync?.stop();
  outlook?.stop();
  app.quit();
});
