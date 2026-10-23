'use strict';
/* global openmail */

const api = (channel, ...args) => openmail.call(channel, ...args);
const $ = (sel) => document.querySelector(sel);

const S = {
  info: null,
  tree: null,
  folder: 'Inbox',
  items: [],
  total: 0,
  selected: null, // entryId
  current: null, // full item
  search: '',
  unreadOnly: false,
  allowRemote: new Set(),
  log: [],
};

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v; // only used with trusted, app-generated markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, isError) {
  $('#status-text').textContent = msg;
  $('#status-text').style.color = isError ? 'var(--danger)' : '';
  if (isError) console.error(msg);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}

function fmtDate(iso, long) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (long) return d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString();
}

function fmtSize(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- modal helpers ----------
function modal({ title, body, footer, wide, onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && close() },
    h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('header', {}, title, h('button', { class: 'icon', onclick: close, title: 'Close' }, '✕')),
      h('div', { class: 'body' }, body),
      footer ? h('footer', {}, footer) : null));
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(backdrop);
  return close;
}

function promptModal(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { value, style: 'width:100%' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const close = modal({
      title,
      body: h('div', {}, h('p', {}, label), input),
      footer: [h('button', { onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'primary', onclick: () => finish(input.value.trim()) }, 'OK')],
      onClose: () => finish(null),
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && finish(input.value.trim()));
    setTimeout(() => input.focus(), 0);
  });
}

function confirmModal(title, text, okLabel = 'OK', danger) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const close = modal({
      title,
      body: h('p', {}, text),
      footer: [h('button', { onclick: () => finish(false) }, 'Cancel'), h('button', { class: danger ? 'danger' : 'primary', onclick: () => finish(true) }, okLabel)],
      onClose: () => finish(false),
    });
  });
}

// ---------- folders ----------
function flattenFolders(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    flattenFolders(n.children, out);
  }
  return out;
}

const collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));

function renderTree() {
  const ul = $('#folder-tree');
  ul.replaceChildren();
  $('#store-name').textContent = S.tree?.name || 'Folders';
  const order = ['Inbox', 'Sent Items', 'Archive', 'Deleted Items'];
  const sortNodes = (nodes) =>
    [...nodes].sort((a, b) => {
      const ia = order.indexOf(a.name), ib = order.indexOf(b.name);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.name.localeCompare(b.name);
    });
  const build = (nodes, parent) => {
    for (const n of sortNodes(nodes)) {
      const hasKids = n.children && n.children.length;
      const isCollapsed = collapsed.has(n.path);
      const node = h('div', {
        class: `node ${n.path === S.folder ? 'active' : ''}`,
        title: `${n.count} items`,
        onclick: () => selectFolder(n.path),
        oncontextmenu: (e) => folderMenu(e, n),
        ondragover: (e) => { e.preventDefault(); node.classList.add('drop'); },
        ondragleave: () => node.classList.remove('drop'),
        ondrop: (e) => { e.preventDefault(); node.classList.remove('drop'); moveSelectedTo(n.path, e.dataTransfer.getData('text/entry-id')); },
      },
      h('span', { class: 'twisty', onclick: (e) => {
        e.stopPropagation();
        if (!hasKids) return;
        isCollapsed ? collapsed.delete(n.path) : collapsed.add(n.path);
        localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
        renderTree();
      } }, hasKids ? (isCollapsed ? '▶' : '▼') : ''),
      h('span', {}, n.name),
      n.unread ? h('span', { class: 'count' }, n.unread) : null);
      const li = h('li', {}, node);
      if (hasKids && !isCollapsed) {
        const sub = h('ul');
        build(n.children, sub);
        li.append(sub);
      }
      parent.append(li);
    }
  };
  build(S.tree?.children || [], ul);
}

async function loadFolders() {
  const tree = await api('folders:list');
  S.tree = tree;
  const all = flattenFolders(tree.children);
  if (!all.find((f) => f.path === S.folder)) S.folder = all.find((f) => f.name === 'Inbox')?.path || all[0]?.path || '';
  renderTree();
}

function selectFolder(path) {
  S.folder = path;
  S.search = '';
  $('#search').value = '';
  renderTree();
  loadItems(true);
}

function folderMenu(e, n) {
  e.preventDefault();
  document.querySelector('.ctx')?.remove();
  const menu = h('div', { class: 'ctx modal', style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:200px;z-index:20;padding:4px` },
    h('button', { style: 'width:100%;text-align:left', onclick: () => newFolder(n.path) }, 'New subfolder…'),
    h('button', { style: 'width:100%;text-align:left', onclick: () => renameFolder(n) }, 'Rename…'),
    h('button', { style: 'width:100%;text-align:left;color:var(--danger)', onclick: () => deleteFolder(n) }, 'Delete folder'));
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function newFolder(parent = '') {
  const name = await promptModal('New folder', parent ? `Create a folder inside "${parent}":` : 'Folder name:');
  if (!name) return;
  await guard(async () => {
    await api('folders:create', parent ? `${parent}/${name}` : name);
    await loadFolders();
  });
}

async function renameFolder(n) {
  const name = await promptModal('Rename folder', 'New name:', n.name);
  if (!name || name === n.name) return;
  await guard(async () => {
    await api('folders:rename', n.path, name);
    if (S.folder === n.path) S.folder = n.path.replace(/[^/]+$/, name);
    await loadFolders();
  });
}

async function deleteFolder(n) {
  if (!(await confirmModal('Delete folder', `Delete "${n.path}" and everything in it? Outlook moves it to Deleted Items.`, 'Delete', true))) return;
  await guard(async () => {
    await api('folders:delete', n.path);
    await loadFolders();
    loadItems(true);
  });
}

// ---------- message list ----------
let listToken = 0;
async function loadItems(reset) {
  const token = ++listToken;
  if (reset) {
    S.items = [];
    S.selected = null;
    $('#message-list').replaceChildren(h('li', { class: 'empty' }, 'Loading…'));
  }
  $('#folder-title').textContent = S.folder ? S.folder.split('/').pop() : 'Folders';
  if (!S.folder) {
    $('#message-list').replaceChildren(h('li', { class: 'empty' }, 'No folders yet. Run a sync to download your mail.'));
    return;
  }
  const res = await guard(() => api('items:list', { folderPath: S.folder, offset: S.items.length, limit: 150, search: S.search, unreadOnly: S.unreadOnly }));
  if (!res || token !== listToken) return;
  S.items = S.items.concat(res.items || []);
  S.total = res.total;
  renderList();
}

function renderList() {
  const ul = $('#message-list');
  ul.replaceChildren();
  if (!S.items.length) ul.append(h('li', { class: 'empty' }, S.search ? 'No matches.' : 'This folder is empty.'));
  for (const it of S.items) {
    ul.append(h('li', {
      class: `${it.unread ? 'unread' : ''} ${it.entryId === S.selected ? 'selected' : ''}`,
      draggable: 'true',
      ondragstart: (e) => e.dataTransfer.setData('text/entry-id', it.entryId),
      onclick: () => openItem(it.entryId),
      'data-id': it.entryId,
    },
    h('div', { class: 'row1' }, h('span', { class: 'from' }, it.from || it.fromAddress || '(no sender)'),
      h('span', { class: 'icons' }, it.hasAttachments ? '📎' : '', it.flagged ? h('span', { class: 'flag' }, ' ⚑') : '')),
    h('div', { class: 'row2' }, h('span', { class: 'subject' }, it.subject || '(no subject)'), h('span', { class: 'date' }, fmtDate(it.date))),
    it.categories ? h('div', { class: 'cats' }, it.categories) : null));
  }
  $('#load-more').hidden = S.items.length >= S.total;
  updateRibbon();
}

function updateRibbon() {
  document.querySelectorAll('[data-needs-item]').forEach((b) => (b.disabled = !S.selected));
}

// ---------- reading pane ----------
function buildSrcdoc(item, allowRemote) {
  let html = item.html;
  if (!html || !/<[a-z][\s\S]*>/i.test(html)) {
    html = `<pre style="white-space:pre-wrap;font-family:Segoe UI,sans-serif">${escapeHtml(item.text || '')}</pre>`;
  }
  for (const [cid, uri] of Object.entries(item.inlineImages || {})) {
    html = html.split(`cid:${cid}`).join(uri);
  }
  const csp = allowRemote
    ? "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline' https:; font-src data: https:"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    '<style>body{font-family:Segoe UI,sans-serif;font-size:14px;margin:16px 20px;color:#242424;word-wrap:break-word}img{max-width:100%;height:auto}</style>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

async function openItem(entryId) {
  S.selected = entryId;
  document.querySelectorAll('#message-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === entryId));
  updateRibbon();
  const item = await guard(() => api('items:get', entryId));
  if (!item || S.selected !== entryId) return;
  S.current = item;
  renderReader();
  if (item.unread) {
    setTimeout(async () => {
      if (S.selected !== entryId) return;
      await guard(() => api('items:setRead', [entryId], false));
      markLocal(entryId, { unread: false });
    }, 1200);
  }
}

function markLocal(entryId, patch) {
  const it = S.items.find((x) => x.entryId === entryId);
  if (it) Object.assign(it, patch);
  if (S.current?.entryId === entryId) Object.assign(S.current, patch);
  renderList();
  loadFolders().catch(() => {});
}

function renderReader() {
  const item = S.current;
  const reader = $('#reader');
  reader.replaceChildren();
  if (!item) {
    reader.append(h('div', { class: 'empty' }, 'Select a message to read it'));
    return;
  }
  const allow = S.allowRemote.has(item.entryId);
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(item.html || '') || /url\(\s*['"]?https?:/i.test(item.html || '');
  reader.append(
    h('div', { class: 'head' },
      h('h1', {}, item.subject || '(no subject)'),
      h('div', { class: 'meta' },
        h('span', { class: 'k' }, 'From'), h('span', {}, item.from, item.fromAddress && item.fromAddress !== item.from ? ` <${item.fromAddress}>` : ''), h('span', { class: 'k' }, fmtDate(item.date, true)),
        h('span', { class: 'k' }, 'To'), h('span', {}, item.to || ''), h('span'),
        item.cc ? [h('span', { class: 'k' }, 'Cc'), h('span', {}, item.cc), h('span')] : null,
        item.categories ? [h('span', { class: 'k' }, 'Categories'), h('span', {}, item.categories), h('span')] : null)),
    item.attachments?.length
      ? h('div', { class: 'attachments' }, item.attachments.map((a) =>
        h('button', { title: 'Save attachment', onclick: () => guard(() => api('items:saveAttachment', item.entryId, a.index, a.name)) }, `📎 ${a.name} (${fmtSize(a.size)})`)))
      : null,
    hasRemote && !allow
      ? h('div', { class: 'notice' }, 'Remote images were blocked to protect your privacy. ',
        h('button', { class: 'link', onclick: () => { S.allowRemote.add(item.entryId); renderReader(); } }, 'Show images'))
      : null,
    h('iframe', { sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: buildSrcdoc(item, allow), title: 'Message body' }));
}

// ---------- item actions ----------
function selectedIds() {
  return S.selected ? [S.selected] : [];
}

function selectNeighbour(removedId) {
  const idx = S.items.findIndex((x) => x.entryId === removedId);
  S.items = S.items.filter((x) => x.entryId !== removedId);
  S.total--;
  const next = S.items[Math.min(idx, S.items.length - 1)];
  S.selected = null;
  S.current = null;
  renderList();
  renderReader();
  if (next) openItem(next.entryId);
}

async function deleteSelected() {
  const id = S.selected;
  if (!id) return;
  const inDeleted = /deleted items$/i.test(S.folder);
  if (inDeleted && !(await confirmModal('Delete permanently', 'This message is in Deleted Items. Delete it permanently from the PST?', 'Delete', true))) return;
  await guard(async () => {
    await api('items:delete', [id]);
    selectNeighbour(id);
    loadFolders();
  });
}

async function moveSelectedTo(folderPath, entryId) {
  const id = entryId || S.selected;
  if (!id || folderPath === S.folder) return;
  await guard(async () => {
    await api('items:move', [id], folderPath);
    selectNeighbour(id);
    loadFolders();
    toast(`Moved to ${folderPath}`);
  });
}

function pickFolder(title) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const build = (nodes) => h('ul', {}, nodes.map((n) => h('li', {}, h('div', { onclick: () => finish(n.path) }, '📁 ', n.name), n.children?.length ? build(n.children) : null)));
    const close = modal({
      title,
      body: h('div', { class: 'folder-picker' }, build(S.tree?.children || [])),
      footer: [h('button', { onclick: async () => { const p = await promptModal('New folder', 'Folder path (use / for subfolders):'); if (p) finish(p); } }, 'New folder…'), h('button', { onclick: () => finish(null) }, 'Cancel')],
      onClose: () => finish(null),
    });
  });
}

async function toggleUnread() {
  const it = S.items.find((x) => x.entryId === S.selected);
  if (!it) return;
  await guard(async () => {
    await api('items:setRead', [it.entryId], !it.unread);
    markLocal(it.entryId, { unread: !it.unread });
  });
}

async function toggleFlag() {
  const it = S.items.find((x) => x.entryId === S.selected);
  if (!it) return;
  await guard(async () => {
    await api('items:flag', [it.entryId], !it.flagged);
    markLocal(it.entryId, { flagged: !it.flagged });
  });
}

// ---------- compose ----------
function quoteBlock(item) {
  return `<p><br></p><hr><p style="font-size:12px"><b>From:</b> ${escapeHtml(item.from)} &lt;${escapeHtml(item.fromAddress)}&gt;<br>` +
    `<b>Sent:</b> ${escapeHtml(fmtDate(item.date, true))}<br><b>To:</b> ${escapeHtml(item.to)}<br>` +
    (item.cc ? `<b>Cc:</b> ${escapeHtml(item.cc)}<br>` : '') +
    `<b>Subject:</b> ${escapeHtml(item.subject)}</p><blockquote>${sanitizeForQuote(item)}</blockquote>`;
}

function sanitizeForQuote(item) {
  if (!item.html) return `<pre style="white-space:pre-wrap">${escapeHtml(item.text || '')}</pre>`;
  const doc = new DOMParser().parseFromString(item.html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => [...n.attributes].forEach((a) => /^on/i.test(a.name) && n.removeAttribute(a.name)));
  for (const [cid, uri] of Object.entries(item.inlineImages || {})) {
    doc.querySelectorAll(`img[src="cid:${cid}"]`).forEach((img) => img.setAttribute('src', uri));
  }
  return doc.body.innerHTML;
}

function compose(kind) {
  const item = S.current;
  const draft = { to: '', cc: '', bcc: '', subject: '', html: '<p><br></p>', inReplyTo: '', references: '' };
  const me = (S.info.email || '').toLowerCase();
  if (item && kind) {
    const prefix = kind === 'forward' ? 'FW: ' : 'RE: ';
    draft.subject = /^(re|fw|fwd):/i.test(item.subject || '') && kind !== 'forward' ? item.subject : prefix + (item.subject || '');
    draft.html = quoteBlock(item);
    if (kind !== 'forward') {
      draft.to = item.fromAddress || item.from;
      draft.inReplyTo = item.messageId || '';
      draft.references = item.messageId || '';
    }
    if (kind === 'replyAll') {
      const others = [item.to, item.cc].join(';').split(/[;,]/).map((s) => s.trim()).filter((s) => s && !s.toLowerCase().includes(me));
      draft.cc = others.join('; ');
    }
  }
  const to = h('input', { value: draft.to });
  const cc = h('input', { value: draft.cc });
  const bcc = h('input', { value: draft.bcc });
  const subject = h('input', { value: draft.subject });
  const editor = h('div', { class: 'editor', contenteditable: 'true', html: draft.html });
  const files = [];
  const chips = h('div', { class: 'chips' });
  const renderChips = () => chips.replaceChildren(...files.map((f, i) => h('span', { class: 'chip' }, f.split(/[\\/]/).pop(), ' ', h('button', { class: 'link', onclick: () => { files.splice(i, 1); renderChips(); } }, '✕'))));
  const cmd = (c, v) => () => { editor.focus(); document.execCommand(c, false, v); };
  const toolbar = h('div', { class: 'toolbar' },
    h('button', { onclick: cmd('bold'), title: 'Bold' }, h('b', {}, 'B')),
    h('button', { onclick: cmd('italic'), title: 'Italic' }, h('i', {}, 'I')),
    h('button', { onclick: cmd('underline'), title: 'Underline' }, h('u', {}, 'U')),
    h('button', { onclick: cmd('insertUnorderedList'), title: 'Bullets' }, '• List'),
    h('button', { onclick: cmd('insertOrderedList'), title: 'Numbering' }, '1. List'),
    h('button', { onclick: async () => { const url = await promptModal('Insert link', 'URL:', 'https://'); if (url) cmd('createLink', url)(); }, title: 'Link' }, '🔗'),
    h('button', { onclick: cmd('removeFormat'), title: 'Clear formatting' }, 'Tx'),
    h('button', { onclick: async () => { const p = await api('dialog:pickFiles'); files.push(...p); renderChips(); }, title: 'Attach files' }, '📎 Attach'));

  let close;
  const sendBtn = h('button', { class: 'primary', onclick: async () => {
    if (!to.value.trim()) return toast('Add at least one recipient', true);
    sendBtn.disabled = true;
    const ok = await guard(() => api('mail:send', {
      to: to.value, cc: cc.value, bcc: bcc.value, subject: subject.value,
      html: editor.innerHTML, text: editor.innerText,
      inReplyTo: draft.inReplyTo, references: draft.references, attachments: files,
    }));
    sendBtn.disabled = false;
    if (ok) { toast('Message sent'); close(); }
  } }, 'Send');

  close = modal({
    title: kind === 'forward' ? 'Forward' : kind ? 'Reply' : 'New message',
    wide: true,
    body: h('div', { class: 'compose' },
      h('div', { class: 'fields' }, h('label', {}, 'To'), to, h('label', {}, 'Cc'), cc, h('label', {}, 'Bcc'), bcc, h('label', {}, 'Subject'), subject),
      toolbar, editor, chips),
    footer: [h('span', { class: 'hint', style: 'margin-right:auto' }, `Sends from ${S.info.email || 'your Gmail account'} via Gmail`), h('button', { onclick: () => close() }, 'Discard'), sendBtn],
  });
  setTimeout(() => (kind && kind !== 'forward' ? editor : to).focus(), 0);
}

// ---------- settings ----------
async function openSettings() {
  S.info = await api('app:info');
  const s = structuredClone(S.info.settings);
  const field = (obj, key, attrs = {}) => {
    const input = h('input', { value: obj[key] ?? '', ...attrs, oninput: (e) => (obj[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value) });
    return input;
  };
  const check = (obj, key, label, onchange) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; onchange && onchange(e); } }), label);

  const pstInput = field(s, 'pstPath');
  const emlInput = field(s.sync, 'emlBackupDir');
  const account = h('div', { class: 'row' });
  const renderAccount = () => {
    account.replaceChildren(
      S.info.signedIn
        ? [h('span', {}, `Signed in as ${S.info.email || '(loading)'}`), h('button', { onclick: async () => { await guard(() => api('auth:signOut')); S.info = await api('app:info'); renderAccount(); renderAccountBadge(); } }, 'Sign out')]
        : h('button', { class: 'primary', onclick: async () => {
          await guard(() => api('settings:save', { google: s.google }));
          toast('Complete sign-in in your browser…');
          const r = await guard(() => api('auth:signIn'));
          if (r) { S.info = await api('app:info'); renderAccount(); renderAccountBadge(); toast(`Signed in as ${r.email}`); }
        } }, 'Sign in with Google'));
  };
  renderAccount();

  const trashWarn = h('div', { class: 'warn full' },
    'Gmail permanently deletes messages that have been in Trash for 30 days. Once trashing is on, check the PST (or the .eml backup) before Gmail empties its Trash. To keep a message in Gmail, move it out of Trash within 30 days; OpenMail will not process it again.');

  const close = modal({
    title: 'Settings',
    wide: true,
    body: h('div', { class: 'form-grid' },
      h('h3', {}, 'Gmail account'),
      h('label', {}, 'OAuth client ID'), field(s.google, 'clientId', { placeholder: 'xxxxxxxx.apps.googleusercontent.com' }),
      h('label', {}, 'OAuth client secret'), field(s.google, 'clientSecret', { type: 'password', placeholder: 'from Google Cloud Console (Desktop app client)' }),
      h('span'), h('span', { class: 'hint' }, 'Create a "Desktop app" OAuth client in Google Cloud Console with the Gmail API enabled. Step-by-step instructions are in the README.'),
      h('label', {}, 'Account'), account,

      h('h3', {}, 'Mailbox (PST)'),
      h('label', {}, 'PST file'), h('div', { class: 'row' }, pstInput, h('button', { onclick: async () => { const p = await api('dialog:pickPst'); if (p) { s.pstPath = p; pstInput.value = p; } } }, 'Browse…')),
      h('label', {}, 'Display name in Outlook'), field(s, 'pstDisplayName'),
      h('span'), h('span', { class: 'hint' }, 'The PST opens in your installed Outlook, so you can also browse it there. A Unicode PST holds up to 50 GB by default.'),

      h('h3', {}, 'Sync behaviour'),
      h('label', {}, 'Check for new mail every'), h('div', { class: 'row' }, field(s, 'pollMinutes', { type: 'number', min: 1, style: 'width:80px' }), 'minutes'),
      h('label', {}, 'Initial sync'), check(s.sync, 'trashDuringInitialSync', 'Also move messages to Gmail Trash during the initial sync'),
      h('label', {}, 'New mail'), check(s.sync, 'newMailUnreadOnly', 'Only download new mail that is still unread (already-read mail stays in Gmail and is ignored)'),
      h('span'), check(s.sync, 'trashNewMail', 'Move new mail to Gmail Trash after it is safely in the PST'),
      h('label', {}, 'Sent mail'), check(s.sync, 'archiveSent', 'Archive sent mail to "Sent Items"'),
      h('span'), check(s.sync, 'trashSent', 'Also move sent mail to Gmail Trash'),
      h('label', {}, 'Spam'), check(s.sync, 'excludeSpam', 'Never download Gmail Spam'),
      h('label', {}, 'Safety net'), check(s.sync, 'keepEmlBackup', 'Keep a raw .eml copy of every downloaded message'),
      h('label', {}, 'Backup folder'), h('div', { class: 'row' }, emlInput, h('button', { onclick: async () => { const p = await api('dialog:pickFolder'); if (p) { s.sync.emlBackupDir = p; emlInput.value = p; } } }, 'Browse…')),

      h('h3', {}, 'Gmail Trash'),
      h('label', {}, h('strong', {}, 'Enable trashing')), check(s.sync, 'trashingEnabled', 'Allow OpenMail to move messages to Gmail Trash. While this is off, OpenMail only copies mail and Gmail is left untouched.'),
      trashWarn,

      h('h3', {}, 'Maintenance'),
      h('label', {}, 'Initial sync status'), h('span', {}, S.info.state.initialSyncComplete ? `Complete. Last sync ${S.info.state.lastSyncAt ? new Date(S.info.state.lastSyncAt).toLocaleString() : 'never'}` : S.info.state.initialStartedAt ? 'In progress (resumes automatically)' : 'Not started'),
      h('span'), h('div', { class: 'row' },
        h('button', { onclick: async () => { if (await confirmModal('Restart initial sync', 'Run a fresh initial sync? Messages already in the PST are skipped.', 'Restart')) { await guard(() => api('sync:resetInitial')); toast('Initial sync will restart on next sync'); } } }, 'Restart initial sync'),
        h('button', { onclick: () => api('shell:openPath', s.sync.emlBackupDir) }, 'Open backup folder'))),
    footer: [
      h('button', { onclick: () => close() }, 'Cancel'),
      h('button', { class: 'primary', onclick: async () => {
        if (s.sync.trashingEnabled && !S.info.settings.sync.trashingEnabled) {
          const ok = await confirmModal('Enable Gmail trashing?', 'OpenMail will move downloaded messages to Gmail Trash, and Gmail permanently deletes Trash after 30 days. Make sure the PST and backups look right first.', 'Enable trashing', true);
          if (!ok) return;
        }
        const saved = await guard(() => api('settings:save', s));
        if (saved) {
          S.info = await api('app:info');
          close();
          toast('Settings saved');
          initMailbox();
        }
      } }, 'Save'),
    ],
  });
}

// ---------- rules ----------
async function openRules() {
  let rules = structuredClone(await api('rules:list'));
  const meta = S.info.meta;
  let activeIdx = rules.length ? 0 : -1;
  const listEl = h('ul');
  const editorEl = h('div', { class: 'rule-editor' });

  const sel = (options, value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
    Object.entries(options).map(([k, label]) => { const o = h('option', { value: k }, label); if (k === value) o.selected = true; return o; }));

  const renderList = () => {
    listEl.replaceChildren(...rules.map((r, i) => h('li', { class: i === activeIdx ? 'active' : '', onclick: () => { activeIdx = i; renderAll(); } },
      h('input', { type: 'checkbox', checked: r.enabled, onclick: (e) => { e.stopPropagation(); r.enabled = e.target.checked; } }),
      h('span', {}, r.name))));
    if (!rules.length) listEl.append(h('li', { class: 'hint' }, 'No rules yet.'));
  };

  const renderEditor = () => {
    editorEl.replaceChildren();
    const r = rules[activeIdx];
    if (!r) {
      editorEl.append(h('p', { class: 'hint', style: 'padding:20px' }, 'Rules run on every message as it is downloaded, in order from top to bottom. Use them to file mail into folders, categorise it, decide what stays in Gmail, or clean out junk. You can also run a rule against mail already in Gmail.'));
      return;
    }
    const condRows = h('div');
    const renderConds = () => condRows.replaceChildren(...r.conditions.map((c, i) => {
      const boolish = ['hasAttachment', 'isNewsletter', 'unread'].includes(c.field);
      const numeric = ['olderThanDays', 'largerThanKB'].includes(c.field);
      return h('div', { class: 'cond' },
        sel(meta.fields, c.field, (v) => { c.field = v; renderConds(); }),
        boolish || numeric ? null : sel(meta.operators, c.op, (v) => (c.op = v)),
        boolish
          ? sel({ true: 'yes', false: 'no' }, String(c.value === '' || c.value === undefined ? true : c.value), (v) => (c.value = v))
          : h('input', { value: c.value ?? '', type: numeric ? 'number' : 'text', placeholder: numeric ? 'number' : 'text', oninput: (e) => (c.value = e.target.value) }),
        h('button', { class: 'icon', title: 'Remove', onclick: () => { r.conditions.splice(i, 1); renderConds(); } }, '✕'));
    }));
    renderConds();

    const actRows = h('div');
    const folders = flattenFolders(S.tree?.children || []).map((f) => f.path);
    const renderActs = () => actRows.replaceChildren(...r.actions.map((a, i) => {
      const needsValue = ['moveToFolder', 'addCategory'].includes(a.type);
      const input = h('input', { value: a.value ?? '', list: a.type === 'moveToFolder' ? 'folder-options' : null, placeholder: a.type === 'moveToFolder' ? 'Folder path, e.g. Receipts/Amazon' : 'Category name', oninput: (e) => (a.value = e.target.value) });
      return h('div', { class: 'act' },
        sel(meta.actions, a.type, (v) => { a.type = v; renderActs(); }),
        needsValue ? input : h('span', { style: 'flex:1' }),
        h('button', { class: 'icon', title: 'Remove', onclick: () => { r.actions.splice(i, 1); renderActs(); } }, '✕'));
    }));
    renderActs();

    const preview = h('div', { class: 'preview' });
    editorEl.append(
      h('datalist', { id: 'folder-options' }, folders.map((f) => h('option', { value: f }))),
      h('h4', {}, 'Name'), h('input', { value: r.name, style: 'width:100%', oninput: (e) => { r.name = e.target.value; renderList(); } }),
      h('h4', {}, 'When a message matches ', sel({ all: 'all', any: 'any' }, r.match, (v) => (r.match = v)), ' of these conditions'),
      condRows, h('button', { class: 'link', onclick: () => { r.conditions.push({ field: 'subject', op: 'contains', value: '' }); renderConds(); } }, '+ Add condition'),
      h('h4', {}, 'Do the following'),
      actRows, h('button', { class: 'link', onclick: () => { r.actions.push({ type: 'addCategory', value: '' }); renderActs(); } }, '+ Add action'),
      h('h4', {}, 'Options'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: r.stopProcessing, onchange: (e) => (r.stopProcessing = e.target.checked) }), 'Stop processing more rules'),
      h('h4', {}, 'Mail already in Gmail'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => {
          preview.replaceChildren(h('p', { class: 'hint' }, 'Searching Gmail…'));
          const res = await guard(() => api('rules:preview', r));
          if (!res) return preview.replaceChildren();
          preview.replaceChildren(
            h('p', { class: 'hint' }, `Gmail query: ${res.query} · about ${res.estimate}${res.hasMore ? '+' : ''} candidates · showing up to 25 matches`),
            h('table', {}, h('tr', {}, h('th', {}, 'From'), h('th', {}, 'Subject'), h('th', {}, 'Date'), h('th', {}, 'In PST')),
              res.sample.map((m) => h('tr', {}, h('td', {}, m.from), h('td', {}, m.subject), h('td', {}, fmtDate(m.date)), h('td', {}, m.archived ? '✓' : '')))));
        } }, 'Preview matches'),
        h('button', { onclick: async () => {
          const destructive = r.actions.some((a) => ['deleteWithoutArchive', 'trashInGmail'].includes(a.type));
          const ok = await confirmModal('Run rule now', `Run "${r.name}" against every matching message in Gmail?${destructive ? ' Matching messages will be moved to Gmail Trash (if trashing is enabled in Settings).' : ''}`, 'Run now', destructive);
          if (!ok) return;
          await guard(async () => { await api('rules:save', rules); await api('rules:run', r); toast(`Running rule "${r.name}"… see Activity for progress`); });
        } }, 'Run on Gmail now')),
      preview);
  };

  const renderAll = () => { renderList(); renderEditor(); };
  renderAll();

  const close = modal({
    title: 'Rules',
    wide: true,
    body: h('div', { class: 'rules-layout' },
      h('div', { class: 'rules-list' },
        h('div', { class: 'row', style: 'padding:8px' },
          h('button', { onclick: async () => { rules.push(await api('rules:new')); activeIdx = rules.length - 1; renderAll(); } }, '+ New'),
          h('button', { title: 'Move up', onclick: () => { if (activeIdx > 0) { [rules[activeIdx - 1], rules[activeIdx]] = [rules[activeIdx], rules[activeIdx - 1]]; activeIdx--; renderAll(); } } }, '▲'),
          h('button', { title: 'Move down', onclick: () => { if (activeIdx >= 0 && activeIdx < rules.length - 1) { [rules[activeIdx + 1], rules[activeIdx]] = [rules[activeIdx], rules[activeIdx + 1]]; activeIdx++; renderAll(); } } }, '▼'),
          h('button', { class: 'danger', title: 'Delete rule', onclick: () => { if (activeIdx >= 0) { rules.splice(activeIdx, 1); activeIdx = Math.min(activeIdx, rules.length - 1); renderAll(); } } }, '🗑')),
        listEl),
      editorEl),
    footer: [h('button', { onclick: () => close() }, 'Cancel'), h('button', { class: 'primary', onclick: async () => { if (await guard(() => api('rules:save', rules))) { toast('Rules saved'); close(); } } }, 'Save rules')],
  });
}

// ---------- activity log ----------
function openLog() {
  const pre = h('pre', { class: 'log' }, S.log.join('\n'));
  const off = openmail.on('log', (line) => { pre.textContent += '\n' + line; pre.parentElement && (pre.parentElement.scrollTop = pre.parentElement.scrollHeight); });
  modal({ title: 'Activity', wide: true, body: pre, onClose: off });
  setTimeout(() => (pre.parentElement.scrollTop = pre.parentElement.scrollHeight), 0);
}

// ---------- status ----------
function renderStatus(st) {
  const text = $('#status-text');
  text.style.color = st.phase === 'error' ? 'var(--danger)' : '';
  const busy = ['initial', 'incremental', 'rule'].includes(st.phase);
  text.textContent = busy && st.total ? `${st.message}: ${st.done.toLocaleString()} of ${st.total.toLocaleString()}` : st.message || 'Ready';
  const prog = $('#status-progress');
  prog.hidden = !busy;
  if (busy && st.total) { prog.max = st.total; prog.value = st.done; } else prog.removeAttribute('value');
  $('#btn-stop').hidden = !busy;
  $('#btn-sync').disabled = busy;
}

function renderAccountBadge() {
  $('#account').textContent = S.info.signedIn ? S.info.email || 'Signed in' : 'Not signed in';
  const t = S.info.state.totals || {};
  $('#totals').textContent = `Downloaded ${t.downloaded || 0} · Trashed in Gmail ${t.trashed || 0} · Ignored ${t.ignored || 0}${t.errors ? ` · Errors ${t.errors}` : ''}${S.info.settings.sync.trashingEnabled ? '' : ' · Gmail trashing OFF'}`;
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    S.info = await api('app:info');
    renderAccountBadge();
    await loadFolders().catch(() => {});
    if (!S.search && S.items.length < 150) loadItems(true);
  }, 3000);
}

// ---------- startup ----------
async function initMailbox() {
  renderAccountBadge();
  const s = S.info.settings;
  if (!s.google.clientId || !S.info.signedIn) {
    $('#reader').replaceChildren($('#tpl-setup').content.cloneNode(true));
  }
  toast('Opening PST in Outlook…');
  const ok = await guard(async () => {
    await api('pst:open');
    await loadFolders();
    return true;
  });
  if (ok) {
    toast('Ready');
    loadItems(true);
  }
}

function bindUi() {
  $('#btn-new').onclick = () => compose();
  $('#btn-reply').onclick = () => S.current && compose('reply');
  $('#btn-replyall').onclick = () => S.current && compose('replyAll');
  $('#btn-forward').onclick = () => S.current && compose('forward');
  $('#btn-delete').onclick = deleteSelected;
  $('#btn-move').onclick = async () => { const p = await pickFolder('Move to folder'); if (p) moveSelectedTo(p); };
  $('#btn-unread').onclick = toggleUnread;
  $('#btn-flag').onclick = toggleFlag;
  $('#btn-outlook').onclick = () => S.selected && guard(() => api('items:openInOutlook', S.selected));
  $('#btn-sync').onclick = () => guard(async () => {
    if (!S.info.signedIn) return openSettings();
    await api('sync:now');
  });
  $('#btn-stop').onclick = () => api('sync:stop');
  $('#btn-rules').onclick = () => openRules();
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-log').onclick = openLog;
  $('#btn-newfolder').onclick = () => newFolder('');
  $('#load-more').onclick = () => loadItems(false);
  $('#unread-only').onchange = (e) => { S.unreadOnly = e.target.checked; loadItems(true); };
  let searchTimer;
  $('#search').oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.search = e.target.value.trim(); loadItems(true); }, 350); };

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.backdrop') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); compose(); }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); S.current && compose('replyAll'); }
    else if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); S.current && compose('reply'); }
    else if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); S.current && compose('forward'); }
    else if (ctrl && (e.key.toLowerCase() === 'q' || e.key.toLowerCase() === 'u')) { e.preventDefault(); toggleUnread(); }
    else if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === 'Delete') deleteSelected();
    else if (e.key === 'F9') $('#btn-sync').click();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const idx = S.items.findIndex((x) => x.entryId === S.selected);
      const next = S.items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); openItem(next.entryId); document.querySelector(`#message-list li[data-id="${CSS.escape(next.entryId)}"]`)?.scrollIntoView({ block: 'nearest' }); }
    }
  });

  openmail.on('sync:status', (st) => {
    renderStatus(st);
    if (st.phase === 'idle' || st.done % 50 === 0) scheduleRefresh();
  });
  openmail.on('log', (line) => { S.log.push(line); if (S.log.length > 2000) S.log.shift(); });
}

(async function main() {
  bindUi();
  updateRibbon();
  S.info = await api('app:info');
  S.log = S.info.log || [];
  renderStatus(S.info.status);
  if (!S.info.settings.google.clientId || !S.info.signedIn) openSettings();
  await initMailbox();
})();
