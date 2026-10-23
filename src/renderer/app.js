'use strict';
/* global openmail */

const api = (channel, ...args) => openmail.call(channel, ...args);
const $ = (sel) => document.querySelector(sel);

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('listPrefs') || '{}');
  } catch {
    return {};
  }
})();

const S = {
  info: null,
  tree: null,
  folder: 'Inbox',
  items: [],
  total: 0,
  senders: null,
  selection: new Set(), // selected message ids
  anchor: null, // last clicked id (for Shift-click ranges)
  focused: null, // id shown in the reading pane
  current: null, // full item in the reading pane
  search: '',
  unreadOnly: false,
  sort: prefs.sort || 'date',
  dir: prefs.dir || 'desc',
  groupBySender: !!prefs.groupBySender,
  collapseAll: !!prefs.collapseAll, // sender groups start collapsed when true
  toggledSenders: new Set(), // senders flipped from the collapseAll default
  allowRemote: new Set(),
  log: [],
};

function savePrefs() {
  try {
    localStorage.setItem('listPrefs', JSON.stringify({ sort: S.sort, dir: S.dir, groupBySender: S.groupBySender, collapseAll: S.collapseAll }));
  } catch {
    /* ignore */
  }
}

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
        ondrop: (e) => {
          e.preventDefault();
          node.classList.remove('drop');
          const ids = JSON.parse(e.dataTransfer.getData('text/openmail-ids') || '[]');
          if (ids.length) moveIds(ids, n.path);
        },
      },
      h('span', { class: 'twisty', onclick: (e) => {
        e.stopPropagation();
        if (!hasKids) return;
        isCollapsed ? collapsed.delete(n.path) : collapsed.add(n.path);
        localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
        renderTree();
      } }, hasKids ? (isCollapsed ? '▶' : '▼') : ''),
      h('span', {}, n.isDeletedItems ? `🗑 ${n.name}` : n.name),
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

function contextMenu(e, entries) {
  e.preventDefault();
  document.querySelector('.ctx')?.remove();
  const menu = h('div', { class: 'ctx modal', style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:240px;z-index:20;padding:4px` },
    entries.filter(Boolean).map(([label, fn, danger]) => h('button', { style: `width:100%;text-align:left;${danger ? 'color:var(--danger)' : ''}`, onclick: fn }, label)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(0, innerHeight - r.height - 8)}px`;
  if (r.right > innerWidth) menu.style.left = `${Math.max(0, innerWidth - r.width - 8)}px`;
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function folderMenu(e, n) {
  contextMenu(e, [
    ['New subfolder…', () => newFolder(n.path)],
    n.isDeletedItems ? null : ['Rename…', () => renameFolder(n)],
    n.isDeletedItems ? ['Empty Deleted Items…', emptyDeletedItems, true] : ['Delete folder', () => deleteFolder(n), true],
  ]);
}

async function newFolder(parent = '') {
  const name = await promptModal('New folder', parent ? `Create a folder inside "${parent}":` : 'Folder name:');
  if (!name) return;
  if (name.includes('/')) return toast('Folder names cannot contain "/"', true);
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
  if (!(await confirmModal('Delete folder', `Move "${n.path}" and everything in it to Deleted Items?`, 'Delete', true))) return;
  await guard(async () => {
    await api('folders:delete', n.path);
    await loadFolders();
    loadItems(true);
  });
}

async function emptyDeletedItems() {
  if (!(await confirmModal('Empty Deleted Items', 'Permanently delete everything in Deleted Items? This cannot be undone.', 'Empty', true))) return;
  await guard(async () => {
    await api('mailbox:emptyDeleted');
    await loadFolders();
    loadItems(true);
    toast('Deleted Items emptied');
  });
}

// ---------- message list ----------
const PAGE_SIZE = 300;
let listToken = 0;

async function loadItems(reset) {
  const token = ++listToken;
  if (reset) {
    S.items = [];
    S.selection.clear();
    S.anchor = null;
    S.toggledSenders.clear();
    $('#message-list').replaceChildren(h('li', { class: 'empty' }, 'Loading…'));
  }
  $('#folder-title').textContent = S.folder ? S.folder.split('/').pop() : 'Folders';
  renderListHeader();
  if (!S.folder) {
    $('#message-list').replaceChildren(h('li', { class: 'empty' }, 'No folders yet. Run a sync to download your mail.'));
    return;
  }
  const limit = grouped() ? 50000 : PAGE_SIZE;
  const res = await guard(() => api('items:list', { folderPath: S.folder, offset: S.items.length, limit, sort: S.sort, dir: S.dir, search: S.search, unreadOnly: S.unreadOnly }));
  if (!res || token !== listToken) return;
  S.items = S.items.concat(res.items || []);
  S.total = res.total;
  S.senders = res.senders;
  renderList();
}

function grouped() {
  return S.groupBySender && S.sort === 'from';
}

function isCollapsed(sender) {
  return S.collapseAll !== S.toggledSenders.has(sender);
}

function renderListHeader() {
  const head = $('#list-columns');
  const col = (key, label, cls) => h('button', {
    class: `col ${cls || ''} ${S.sort === key ? 'sorted' : ''}`,
    title: `Sort by ${label.toLowerCase()}`,
    onclick: () => {
      if (S.sort === key) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
      else {
        S.sort = key;
        S.dir = key === 'date' || key === 'size' ? 'desc' : 'asc';
      }
      savePrefs();
      loadItems(true);
    },
  }, label, S.sort === key ? (S.dir === 'asc' ? ' ▲' : ' ▼') : '');
  head.replaceChildren(
    h('input', { type: 'checkbox', class: 'select-all', title: 'Select all loaded messages', checked: S.items.length > 0 && S.selection.size === S.items.length, onchange: (e) => { if (e.target.checked) S.items.forEach((m) => S.selection.add(m.id)); else S.selection.clear(); renderList(); } }),
    col('from', 'From', 'grow'),
    col('subject', 'Subject', 'grow'),
    col('date', 'Received'),
    col('size', 'Size'),
    h('label', { class: 'filter', title: 'Group messages from the same sender together' }, h('input', { type: 'checkbox', checked: S.groupBySender, onchange: (e) => {
      S.groupBySender = e.target.checked;
      if (S.groupBySender && S.sort !== 'from') { S.sort = 'from'; S.dir = 'asc'; }
      savePrefs();
      loadItems(true);
    } }), ' Group by sender'),
    grouped() ? h('button', { class: 'col', title: 'Collapse every sender group', onclick: () => { S.collapseAll = true; S.toggledSenders.clear(); savePrefs(); renderList(); } }, '⊟ Collapse all') : null,
    grouped() ? h('button', { class: 'col', title: 'Expand every sender group', onclick: () => { S.collapseAll = false; S.toggledSenders.clear(); savePrefs(); renderList(); } }, '⊞ Expand all') : null);
}

function rowFor(it) {
  const selected = S.selection.has(it.id);
  return h('li', {
    class: `${it.unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${it.id === S.focused ? 'focused' : ''}`,
    draggable: 'true',
    ondragstart: (e) => {
      if (!S.selection.has(it.id)) selectOnly(it.id);
      e.dataTransfer.setData('text/openmail-ids', JSON.stringify([...S.selection]));
      e.dataTransfer.effectAllowed = 'move';
    },
    onclick: (e) => onRowClick(e, it),
    oncontextmenu: (e) => {
      if (!S.selection.has(it.id)) selectOnly(it.id);
      itemMenu(e, it);
    },
    'data-id': it.id,
  },
  h('input', { type: 'checkbox', class: 'pick', checked: selected, onclick: (e) => { e.stopPropagation(); toggleSelect(it.id); } }),
  h('div', { class: 'cells' },
    h('div', { class: 'row1' }, h('span', { class: 'from' }, it.from || '(no sender)'),
      h('span', { class: 'icons' }, it.importance === 2 ? h('span', { class: 'flag', title: 'High importance' }, '! ') : '', it.hasAttachments ? '📎' : '')),
    h('div', { class: 'row2' }, h('span', { class: 'subject' }, it.subject || '(no subject)'), h('span', { class: 'date' }, fmtDate(it.date)), h('span', { class: 'size' }, fmtSize(it.size || 0)))));
}

function renderList() {
  const ul = $('#message-list');
  ul.replaceChildren();
  if (!S.items.length) ul.append(h('li', { class: 'empty' }, S.search ? 'No matches.' : 'This folder is empty.'));
  const groups = new Map(); // sender → loaded message ids
  if (grouped()) for (const it of S.items) (groups.get(it.from || '') || groups.set(it.from || '', []).get(it.from || '')).push(it.id);
  let lastSender = null;
  for (const it of S.items) {
    const sender = it.from || '';
    if (grouped() && sender !== lastSender) {
      lastSender = sender;
      ul.append(groupHeader(sender, groups.get(sender)));
    }
    if (grouped() && isCollapsed(sender)) continue;
    ul.append(rowFor(it));
  }
  $('#load-more').hidden = S.items.length >= S.total;
  $('#load-more').textContent = `Load more (${(S.total - S.items.length).toLocaleString()} remaining)`;
  $('#list-count').textContent = S.total ? `${S.total.toLocaleString()} message${S.total === 1 ? '' : 's'}${S.selection.size ? ` · ${S.selection.size.toLocaleString()} selected` : ''}` : '';
  const all = document.querySelector('.select-all');
  if (all) all.checked = S.items.length > 0 && S.items.every((m) => S.selection.has(m.id));
  updateRibbon();
}

function groupHeader(sender, ids) {
  const count = (S.senders && S.senders[sender]) || ids.length;
  const picked = ids.filter((id) => S.selection.has(id)).length;
  const collapsed = isCollapsed(sender);
  const label = sender || '(no sender)';
  const toggle = () => {
    if (S.toggledSenders.has(sender)) S.toggledSenders.delete(sender);
    else S.toggledSenders.add(sender);
    renderList();
  };
  const box = h('input', {
    type: 'checkbox',
    class: 'group-pick',
    title: `Select all ${count} message(s) from ${label}`,
    checked: ids.length > 0 && picked === ids.length,
    onclick: async (e) => {
      e.stopPropagation();
      const on = e.target.checked;
      // Every message from the sender, including any not loaded in the list.
      const all = ids.length >= count ? ids : await guard(() => senderIds(sender));
      if (!all) return;
      for (const id of all) on ? S.selection.add(id) : S.selection.delete(id);
      renderList();
      if (S.selection.size > 1) renderSelectionPane();
    },
  });
  box.indeterminate = picked > 0 && picked < ids.length;
  return h('li', { class: `group ${collapsed ? 'collapsed' : ''}`, 'data-sender': sender },
    box,
    h('button', { class: 'caret', title: collapsed ? 'Expand' : 'Collapse', 'aria-expanded': String(!collapsed), onclick: toggle }, collapsed ? '▶' : '▼'),
    h('span', { class: 'name', title: label, onclick: toggle }, label),
    h('span', { class: 'count' }, `${count}`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'link', title: 'Move every message from this sender', onclick: async () => { const all = await senderIds(sender); const p = await pickFolder(`Move ${all.length} message(s) from ${label}`); if (p) moveIds(all, p); } }, 'Move all…'),
    h('button', { class: 'link danger-link', title: 'Delete every message from this sender', onclick: async () => deleteIds(await senderIds(sender), `all ${count} message(s) from ${label}`) }, 'Delete all'));
}

async function senderIds(sender) {
  return api('items:idsFromSender', S.folder, sender);
}

async function selectSender(sender) {
  const ids = await guard(() => senderIds(sender));
  if (!ids) return;
  S.selection = new Set(ids);
  renderList();
  renderSelectionPane();
  toast(`${ids.length} message(s) from ${sender || '(no sender)'} selected`);
}

function selectOnly(id) {
  S.selection = new Set([id]);
  S.anchor = id;
}

function toggleSelect(id) {
  if (S.selection.has(id)) S.selection.delete(id);
  else S.selection.add(id);
  S.anchor = id;
  renderList();
  renderSelectionPane();
}

function onRowClick(e, it) {
  if (e.shiftKey && S.anchor !== null) {
    const a = S.items.findIndex((m) => m.id === S.anchor);
    const b = S.items.findIndex((m) => m.id === it.id);
    if (!(e.ctrlKey || e.metaKey)) S.selection.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selection.add(S.items[i].id);
    renderList();
    renderSelectionPane();
    return;
  }
  if (e.ctrlKey || e.metaKey) return toggleSelect(it.id);
  selectOnly(it.id);
  renderList();
  openItem(it.id);
}

function itemMenu(e, it) {
  const n = S.selection.size;
  const label = n > 1 ? `${n} messages` : 'message';
  contextMenu(e, [
    n === 1 ? ['Reply', () => openItem(it.id).then(() => compose('reply'))] : null,
    [`Mark ${label} as read`, () => setRead([...S.selection], true)],
    [`Mark ${label} as unread`, () => setRead([...S.selection], false)],
    [`Flag ${label}`, () => setFlag([...S.selection], true)],
    [`Move ${label}…`, async () => { const p = await pickFolder('Move to folder'); if (p) moveIds([...S.selection], p); }],
    [`Select all from ${it.from || '(no sender)'}`, () => selectSender(it.from || '')],
    [`Delete ${label}`, () => deleteIds([...S.selection]), true],
  ]);
}

function updateRibbon() {
  const n = S.selection.size;
  document.querySelectorAll('[data-needs-item]').forEach((b) => (b.disabled = n === 0));
  document.querySelectorAll('[data-needs-one]').forEach((b) => (b.disabled = !S.current || n > 1));
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

async function openItem(id) {
  S.focused = id;
  document.querySelectorAll('#message-list li[data-id]').forEach((li) => li.classList.toggle('focused', Number(li.dataset.id) === id));
  const item = await guard(() => api('items:get', id));
  if (!item || S.focused !== id) return;
  S.current = item;
  renderReader();
  updateRibbon();
  if (item.unread) {
    setTimeout(async () => {
      if (S.focused !== id) return;
      await guard(() => api('items:setRead', [id], true));
      markLocal([id], { unread: false });
    }, 1200);
  }
}

function markLocal(ids, patch) {
  const set = new Set(ids);
  for (const it of S.items) if (set.has(it.id)) Object.assign(it, patch);
  if (S.current && set.has(S.current.id)) Object.assign(S.current, patch);
  renderList();
  loadFolders().catch(() => {});
}

function renderSelectionPane() {
  if (S.selection.size <= 1) return;
  const n = S.selection.size;
  S.current = null;
  S.focused = null;
  $('#reader').replaceChildren(h('div', { class: 'multi' },
    h('h2', {}, `${n.toLocaleString()} messages selected`),
    h('div', { class: 'row' },
      h('button', { onclick: async () => { const p = await pickFolder(`Move ${n} messages`); if (p) moveIds([...S.selection], p); } }, '📁 Move…'),
      h('button', { onclick: () => setRead([...S.selection], true) }, 'Mark read'),
      h('button', { onclick: () => setRead([...S.selection], false) }, 'Mark unread'),
      h('button', { class: 'danger', onclick: () => deleteIds([...S.selection]) }, '🗑 Delete')),
    h('p', { class: 'hint' }, 'Tip: sort by From (or turn on "Group by sender") to clean up everything from one sender at once.')));
  updateRibbon();
}

function renderReader() {
  const item = S.current;
  const reader = $('#reader');
  reader.replaceChildren();
  if (!item) {
    reader.append(h('div', { class: 'empty' }, 'Select a message to read it'));
    return;
  }
  const allow = S.allowRemote.has(item.id);
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(item.html || '') || /url\(\s*['"]?https?:/i.test(item.html || '');
  // DOM append() would print missing sections as the text "null", so filter them out.
  reader.append(...[
    h('div', { class: 'head' },
      h('h1', {}, item.subject || '(no subject)'),
      h('div', { class: 'meta' },
        h('span', { class: 'k' }, 'From'), h('span', {}, item.from, item.fromAddress && item.fromAddress !== item.from ? ` <${item.fromAddress}>` : ''), h('span', { class: 'k' }, fmtDate(item.date, true)),
        h('span', { class: 'k' }, 'To'), h('span', {}, item.to || ''), h('span'),
        item.cc ? [h('span', { class: 'k' }, 'Cc'), h('span', {}, item.cc), h('span')] : null,
        item.categories ? [h('span', { class: 'k' }, 'Categories'), h('span', {}, item.categories), h('span')] : null,
        h('span', { class: 'k' }, 'Folder'), h('span', {}, item.folderPath), h('span'))),
    item.attachments?.length
      ? h('div', { class: 'attachments' }, item.attachments.map((a) =>
        h('button', { title: 'Click to open · right-click to save', onclick: () => guard(() => api('items:openAttachment', item.id, a.id, a.name)), oncontextmenu: (e) => { e.preventDefault(); guard(() => api('items:saveAttachment', item.id, a.id, a.name)); } }, `📎 ${a.name} (${fmtSize(a.size)})`)))
      : null,
    hasRemote && !allow
      ? h('div', { class: 'notice' }, 'Remote images were blocked to protect your privacy. ',
        h('button', { class: 'link', onclick: () => { S.allowRemote.add(item.id); renderReader(); } }, 'Show images'))
      : null,
    h('iframe', { sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: buildSrcdoc(item, allow), title: 'Message body' }),
  ].filter(Boolean));
}

// ---------- item actions (all work on the current selection) ----------
function selectedIds() {
  return [...S.selection];
}

function removeFromList(ids) {
  const set = new Set(ids);
  const firstIdx = S.items.findIndex((x) => set.has(x.id));
  S.items = S.items.filter((x) => !set.has(x.id));
  S.total = Math.max(0, S.total - ids.length);
  S.selection.clear();
  const next = S.items[Math.min(Math.max(firstIdx, 0), S.items.length - 1)];
  S.current = null;
  S.focused = null;
  renderList();
  renderReader();
  if (next && ids.length === 1) {
    selectOnly(next.id);
    renderList();
    openItem(next.id);
  }
}

async function deleteIds(ids, what) {
  if (!ids.length) return;
  const inDeleted = flattenFolders(S.tree?.children).find((f) => f.path === S.folder)?.isDeletedItems || false;
  let label = what || (ids.length === 1 ? 'this message' : `${ids.length.toLocaleString()} messages`);
  if (!what && ids.length > 1 && grouped()) {
    const set = new Set(ids);
    const senders = new Set(S.items.filter((m) => set.has(m.id)).map((m) => m.from || ''));
    if (senders.size > 1) label += ` from ${senders.size.toLocaleString()} senders`;
  }
  if (inDeleted && !(await confirmModal('Delete permanently', `Permanently delete ${label}? They are already in Deleted Items.`, 'Delete', true))) return;
  if (!inDeleted && ids.length > 1 && !(await confirmModal('Delete messages', `Move ${label} to Deleted Items?`, 'Delete', true))) return;
  await guard(async () => {
    await api('items:delete', ids);
    removeFromList(ids);
    loadFolders();
    toast(inDeleted ? `Deleted ${ids.length} message(s)` : `Moved ${ids.length} message(s) to Deleted Items`);
  });
}

async function moveIds(ids, folderPath) {
  if (!ids.length || folderPath === S.folder) return;
  await guard(async () => {
    await api('items:move', ids, folderPath);
    removeFromList(ids);
    loadFolders();
    toast(`Moved ${ids.length} message(s) to ${folderPath}`);
  });
}

async function setRead(ids, read) {
  if (!ids.length) return;
  await guard(async () => {
    await api('items:setRead', ids, read);
    markLocal(ids, { unread: !read });
  });
}

async function setFlag(ids, flagged) {
  if (!ids.length) return;
  await guard(async () => {
    await api('items:flag', ids, flagged);
    if (S.current && ids.includes(S.current.id)) S.current.flagged = flagged;
    toast(flagged ? 'Flagged' : 'Flag cleared');
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
  const ids = selectedIds();
  if (!ids.length) return;
  const anyUnread = S.items.some((m) => ids.includes(m.id) && m.unread);
  await setRead(ids, anyUnread);
}

async function toggleFlag() {
  const ids = selectedIds();
  if (!ids.length) return;
  await setFlag(ids, !(S.current && S.current.flagged && ids.length === 1));
}

// ---------- compose ----------
function quoteBlock(item) {
  return `<p><br></p><hr><p style="font-size:12px"><b>From:</b> ${escapeHtml(item.from)} &lt;${escapeHtml(item.fromAddress)}&gt;<br>` +
    `<b>Sent:</b> ${escapeHtml(fmtDate(item.date, true))}<br><b>To:</b> ${escapeHtml(item.to)}<br>` +
    (item.cc ? `<b>Cc:</b> ${escapeHtml(item.cc)}<br>` : '') +
    `<b>Subject:</b> ${escapeHtml(item.subject)}</p><blockquote>${sanitizeForQuote(item)}</blockquote>`;
}

/** Strips scripts, event handlers and javascript: links from user or email HTML. */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,base').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => [...n.attributes].forEach((a) => {
    if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
  }));
  return doc.body.innerHTML;
}

function signatureHtml() {
  const sig = S.info.settings.signature || {};
  const html = sanitizeHtml(sig.html || '');
  return html.replace(/<br\s*\/?>|&nbsp;|\s/gi, '') ? html : '';
}

function signatureBlock() {
  const html = signatureHtml();
  return html ? '<div class="om-signature" data-om-signature="1">' + html + '</div>' : '';
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

// ---------- recipient autocomplete ----------
let recipientCache = null;
async function loadRecipients() {
  if (!recipientCache) recipientCache = await api('recipients:list').catch(() => []);
  return recipientCache;
}

function formatRecipient(r) {
  if (!r.name) return r.address;
  const name = /[,;<>"@()]/.test(r.name) ? '"' + r.name.replace(/"/g, '') + '"' : r.name;
  return name + ' <' + r.address + '>';
}

/** Wraps an address input with a suggestion list of remembered recipients. Returns the wrapper element. */
function withAutocomplete(input) {
  const list = h('ul', { class: 'ac-list', role: 'listbox' });
  list.hidden = true;
  const wrap = h('div', { class: 'ac-wrap' }, input, list);
  let items = [];
  let active = -1;

  // The address being typed: from the last ";" or "," before the cursor up to the cursor.
  const currentToken = () => {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const start = Math.max(v.lastIndexOf(';', caret - 1), v.lastIndexOf(',', caret - 1)) + 1;
    return { start, end: caret, text: v.slice(start, caret).trim() };
  };
  const hide = () => {
    list.hidden = true;
    items = [];
    active = -1;
  };
  const render = () => {
    list.replaceChildren(...items.map((r, i) => h('li', {
      class: i === active ? 'active' : '',
      role: 'option',
      onmousedown: (e) => { e.preventDefault(); accept(i); },
    },
    h('span', { class: 'ac-name' }, r.name || r.address),
    r.name ? h('span', { class: 'ac-addr' }, r.address) : null,
    h('button', { class: 'ac-forget', title: 'Stop suggesting this address', onmousedown: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await guard(() => api('recipients:forget', r.address));
      recipientCache = (recipientCache || []).filter((x) => x.address !== r.address);
      update();
    } }, '×'))));
    list.hidden = items.length === 0;
  };
  const update = async () => {
    const tok = currentToken();
    const q = tok.text.toLowerCase();
    if (!q) return hide();
    const already = new Set((input.value.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map((a) => a.toLowerCase()));
    const all = await loadRecipients();
    const starts = [];
    const contains = [];
    for (const r of all) {
      if (already.has(r.address) && r.address !== q) continue;
      const name = (r.name || '').toLowerCase();
      if (r.address.startsWith(q) || name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) starts.push(r);
      else if (r.address.includes(q) || name.includes(q)) contains.push(r);
      if (starts.length >= 8) break;
    }
    items = starts.concat(contains).slice(0, 8);
    active = items.length ? 0 : -1;
    render();
  };
  const accept = (i) => {
    const r = items[i];
    if (!r) return;
    const tok = currentToken();
    const before = input.value.slice(0, tok.start).replace(/\s*$/, '');
    const after = input.value.slice(tok.end).replace(/^\s*[;,]?\s*/, '');
    const insert = (before ? before + ' ' : '') + formatRecipient(r) + '; ';
    input.value = insert + after;
    input.setSelectionRange(insert.length, insert.length);
    hide();
  };

  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', update);
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => {
    if (list.hidden || e.ctrlKey || e.metaKey) return; // Ctrl+Enter still sends
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
      e.preventDefault();
      accept(active);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // close the suggestions, not the message
      hide();
    }
  });
  return wrap;
}

function compose(kind) {
  const item = S.current;
  const sig = S.info.settings.signature || {};
  const draft = { to: '', cc: '', bcc: '', subject: '', html: '<p><br></p>' + (sig.newMessages !== false ? signatureBlock() : ''), inReplyTo: '', references: '' };
  const me = (S.info.email || '').toLowerCase();
  if (item && kind) {
    const prefix = kind === 'forward' ? 'FW: ' : 'RE: ';
    draft.subject = /^(re|fw|fwd):/i.test(item.subject || '') && kind !== 'forward' ? item.subject : prefix + (item.subject || '');
    // Typing space, then the signature, then the quoted message.
    draft.html = '<p><br></p>' + (sig.replies !== false ? signatureBlock() : '') + quoteBlock(item).replace(/^<p><br><\/p>/, '');
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
    h('button', { onclick: async () => { const p = await api('dialog:pickFiles'); files.push(...p); renderChips(); }, title: 'Attach files' }, '📎 Attach'),
    h('button', { title: 'Insert your signature (set it up in Settings → Signature)', onclick: () => {
      const block = signatureBlock();
      if (!block) { toast('No signature yet: add one in Settings → Signature'); return; }
      if (editor.querySelector('[data-om-signature]')) { toast('This message already has your signature'); return; }
      editor.focus();
      document.execCommand('insertHTML', false, block);
    } }, '✍ Signature'));

  let close;
  const sendBtn = h('button', { class: 'primary', title: 'Send (Ctrl+Enter)', onclick: async () => {
    if (sendBtn.disabled) return; // already sending
    if (!to.value.trim()) return toast('Add at least one recipient', true);
    sendBtn.disabled = true;
    const ok = await guard(() => api('mail:send', {
      to: to.value, cc: cc.value, bcc: bcc.value, subject: subject.value,
      html: editor.innerHTML, text: editor.innerText,
      inReplyTo: draft.inReplyTo, references: draft.references, attachments: files,
    }));
    sendBtn.disabled = false;
    if (ok) { recipientCache = null; toast('Message sent'); close(); }
  } }, 'Send');
  loadRecipients();

  close = modal({
    title: kind === 'forward' ? 'Forward' : kind ? 'Reply' : 'New message',
    wide: true,
    body: h('div', {
      class: 'compose',
      // Ctrl+Enter sends from anywhere in the compose window.
      onkeydown: (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          sendBtn.click();
        }
      },
    },
    h('div', { class: 'fields' }, h('label', {}, 'To'), withAutocomplete(to), h('label', {}, 'Cc'), withAutocomplete(cc), h('label', {}, 'Bcc'), withAutocomplete(bcc), h('label', {}, 'Subject'), subject),
    toolbar, editor, chips),
    footer: [h('span', { class: 'hint', style: 'margin-right:auto' }, `Sends from ${S.info.email || 'your Gmail account'} via Gmail · Ctrl+Enter to send`), h('button', { onclick: () => close() }, 'Discard'), sendBtn],
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
  s.signature = { html: '', newMessages: true, replies: true, ...(s.signature || {}) };
  const sigEditor = h('div', { class: 'editor sig-editor', contenteditable: 'true', html: sanitizeHtml(s.signature.html), 'aria-label': 'Signature' });
  sigEditor.addEventListener('input', () => (s.signature.html = sanitizeHtml(sigEditor.innerHTML)));
  const sigCmd = (c, v) => () => { sigEditor.focus(); document.execCommand(c, false, v); s.signature.html = sanitizeHtml(sigEditor.innerHTML); };
  const sigToolbar = h('div', { class: 'toolbar' },
    h('button', { onclick: sigCmd('bold'), title: 'Bold' }, h('b', {}, 'B')),
    h('button', { onclick: sigCmd('italic'), title: 'Italic' }, h('i', {}, 'I')),
    h('button', { onclick: sigCmd('underline'), title: 'Underline' }, h('u', {}, 'U')),
    h('button', { onclick: async () => { const url = await promptModal('Insert link', 'URL:', 'https://'); if (url) sigCmd('createLink', url)(); }, title: 'Link' }, '🔗'),
    h('button', { onclick: sigCmd('removeFormat'), title: 'Clear formatting' }, 'Tx'));
  s.backup = { folder: '', keep: 3, ...(s.backup || {}) };
  const backupInput = field(s.backup, 'folder', { placeholder: 'e.g. G:\\My Drive\\OpenMail Backups' });
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

  const mb = S.info.mailbox;
  const mailboxStatus = h('span', {},
    S.info.mailboxError ? h('span', { style: 'color:var(--danger)' }, S.info.mailboxError)
      : mb ? `${mb.unicode ? 'Unicode PST' : 'Old ANSI PST (read-only, 2 GB limit)'} · ${fmtSize(mb.size)}` : '');
  const checkResult = h('div', { class: 'full hint' });

  const trashWarn = h('div', { class: 'warn full' },
    'Gmail permanently deletes messages that have been in Trash for 30 days. Once trashing is on, check the mailbox (or the .eml backup) before Gmail empties its Trash. To keep a message in Gmail, move it out of Trash within 30 days; OpenMail will not process it again.');

  const close = modal({
    title: 'Settings',
    wide: true,
    body: h('div', { class: 'form-grid' },
      h('h3', {}, 'Gmail account'),
      h('label', {}, 'OAuth client ID'), field(s.google, 'clientId', { placeholder: 'xxxxxxxx.apps.googleusercontent.com' }),
      h('label', {}, 'OAuth client secret'), field(s.google, 'clientSecret', { type: 'password', placeholder: 'from Google Cloud Console (Desktop app client)' }),
      h('span'), h('span', { class: 'hint' }, 'Create a "Desktop app" OAuth client in Google Cloud Console with the Gmail API enabled. Step-by-step instructions are in the README.'),
      h('label', {}, 'Account'), account,

      h('h3', {}, 'Mailbox (PST file)'),
      h('label', {}, 'PST file'), h('div', { class: 'row' }, pstInput, h('button', { onclick: async () => { const p = await api('dialog:pickPst'); if (p) { s.pstPath = p; pstInput.value = p; } } }, 'Browse…')),
      h('label', {}, 'Status'), mailboxStatus,
      h('label', {}, 'Display name'), field(s, 'pstDisplayName'),
      h('span'), h('span', { class: 'hint' }, 'OpenMail reads and writes the PST itself; Outlook is not needed. You can also open the same file in Outlook, but not while OpenMail has it open.'),
      h('label', {}, 'Tools'), h('div', { class: 'row' },
        h('button', { onclick: () => { close(); importPstFlow(); } }, 'Import a PST…'),
        mb && !mb.unicode ? h('button', { class: 'primary', onclick: () => { close(); convertFlow(); } }, 'Convert to Unicode PST…') : null,
        h('button', { onclick: async () => {
          checkResult.textContent = 'Checking the mailbox file…';
          const r = await guard(() => api('mailbox:check'));
          if (!r) return (checkResult.textContent = '');
          checkResult.textContent = r.problems.length ? `Found ${r.problems.length} problem(s): ${r.problems.slice(0, 5).join('; ')}` : 'No problems found.';
        } }, 'Check file')),
      checkResult,

      h('h3', {}, 'Signature'),
      h('label', {}, 'Your signature'), h('div', { class: 'sig-edit' }, sigToolbar, sigEditor),
      h('label', {}, 'Add it to'), h('div', { class: 'row' },
        check(s.signature, 'newMessages', 'New messages'),
        check(s.signature, 'replies', 'Replies and forwards')),
      h('span'), h('span', { class: 'hint' }, 'Formatting, links and pasted images are kept. You can also insert the signature with the ✍ Signature button while writing.'),

      h('h3', {}, 'Backup'),
      h('label', {}, 'Backup folder'), h('div', { class: 'row' }, backupInput, h('button', { onclick: async () => { const p = await api('dialog:pickFolder'); if (p) { s.backup.folder = p; backupInput.value = p; } } }, 'Browse…')),
      h('label', {}, 'Copies to keep'), h('div', { class: 'row' }, field(s.backup, 'keep', { type: 'number', min: 1, max: 50, style: 'width:80px' }), 'most recent backups (older ones are removed)'),
      h('span'), h('span', { class: 'hint' }, 'Pick a folder that your cloud app syncs, such as "G:\\My Drive\\OpenMail Backups" (Google Drive for desktop), a OneDrive folder or a Dropbox folder. When the "Back up on exit" switch at the top of the main window is on, OpenMail copies the mailbox here as it closes, once the file is no longer in use. The switch is always off when OpenMail starts.'),
      h('label', {}, 'Last backup'), h('span', {}, S.info.state.lastBackup ? `${new Date(S.info.state.lastBackup.at).toLocaleString()} · ${fmtSize(S.info.state.lastBackup.bytes)} · ${S.info.state.lastBackup.path}` : 'Never'),

      h('h3', {}, 'Sync behaviour'),
      h('label', {}, 'Check for new mail every'), h('div', { class: 'row' }, field(s, 'pollMinutes', { type: 'number', min: 1, style: 'width:80px' }), 'minutes'),
      h('label', {}, 'Initial sync'), check(s.sync, 'trashDuringInitialSync', 'Also move messages to Gmail Trash during the initial sync'),
      h('label', {}, 'New mail'), check(s.sync, 'newMailUnreadOnly', 'Only download new mail that is still unread (already-read mail stays in Gmail and is ignored)'),
      h('span'), check(s.sync, 'trashNewMail', 'Move new mail to Gmail Trash after it is safely saved in the mailbox'),
      h('label', {}, 'Sent mail'), check(s.sync, 'archiveSent', 'Archive sent mail to "Sent Items"'),
      h('span'), check(s.sync, 'trashSent', 'Also move sent mail to Gmail Trash'),
      h('label', {}, 'Spam'), check(s.sync, 'excludeSpam', 'Never download Gmail Spam'),
      h('label', {}, 'Safety net'), check(s.sync, 'keepEmlBackup', 'Keep a raw .eml copy of every downloaded message'),
      h('label', {}, 'Backup folder'), h('div', { class: 'row' }, emlInput, h('button', { onclick: async () => { const p = await api('dialog:pickFolder'); if (p) { s.sync.emlBackupDir = p; emlInput.value = p; } } }, 'Browse…')),

      h('h3', {}, 'Gmail Trash'),
      h('label', {}, h('strong', {}, 'Enable trashing')), check(s.sync, 'trashingEnabled', 'Allow OpenMail to move messages to Gmail Trash. While this is off, OpenMail only copies mail and Gmail is left untouched.'),
      h('label', {}, 'Starred messages'), check(s.sync, 'keepStarredInGmail', 'Always keep starred messages in Gmail. They are still copied to OpenMail, but never moved to Gmail Trash, even if a rule says so.'),
      trashWarn,

      h('h3', {}, 'About'),
      h('label', {}, 'OpenMail'), h('span', {}, `Version ${S.info.version} · `,
        h('a', { href: 'https://markdmac.github.io/OpenMail/privacy.html', target: '_blank' }, 'Privacy policy'), ' · ',
        h('a', { href: 'https://markdmac.github.io/OpenMail/terms.html', target: '_blank' }, 'Terms of service'), ' · ',
        h('a', { href: 'https://github.com/markdmac/OpenMail', target: '_blank' }, 'GitHub')),

      h('h3', {}, 'Maintenance'),
      h('label', {}, 'Initial sync status'), h('span', {}, S.info.state.initialSyncComplete ? `Complete. Last sync ${S.info.state.lastSyncAt ? new Date(S.info.state.lastSyncAt).toLocaleString() : 'never'}` : S.info.state.initialStartedAt ? 'In progress (resumes automatically)' : 'Not started'),
      h('span'), h('div', { class: 'row' },
        h('button', { onclick: async () => { if (await confirmModal('Restart initial sync', 'Run a fresh initial sync? Messages already downloaded are skipped.', 'Restart')) { await guard(() => api('sync:resetInitial')); toast('Initial sync will restart on next sync'); } } }, 'Restart initial sync'),
        h('button', { onclick: () => api('shell:openPath', s.sync.emlBackupDir) }, 'Open backup folder'))),
    footer: [
      h('button', { onclick: () => close() }, 'Cancel'),
      h('button', { class: 'primary', onclick: async () => {
        if (s.sync.trashingEnabled && !S.info.settings.sync.trashingEnabled) {
          const ok = await confirmModal('Enable Gmail trashing?', 'OpenMail will move downloaded messages to Gmail Trash, and Gmail permanently deletes Trash after 30 days. Make sure your mailbox and backups look right first.', 'Enable trashing', true);
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

async function importPstFlow() {
  const prefix = await promptModal('Import a PST', 'Import into a folder named (leave empty to merge into your existing folders):', 'Imported');
  if (prefix === null) return;
  toast('Choose the PST file to import…');
  const r = await guard(() => api('mailbox:import', null, prefix));
  if (!r) return;
  await loadFolders();
  loadItems(true);
  toast(`Imported ${r.messages.toLocaleString()} messages (${r.duplicates.toLocaleString()} duplicates skipped${r.errors ? `, ${r.errors} errors — see Activity` : ''})`, r.errors > 0);
}

async function convertFlow() {
  const ok = await confirmModal('Convert mailbox',
    'Your mailbox is in the old ANSI PST format, which OpenMail can read but not write, and which is limited to 2 GB. OpenMail will copy everything into a new Unicode PST next to it and switch to that. The old file is left unchanged.', 'Convert');
  if (!ok) return;
  const r = await guard(() => api('mailbox:convert'));
  if (!r) return;
  S.info = await api('app:info');
  hideBanner();
  await loadFolders();
  loadItems(true);
  toast(`Converted: ${r.converted ? r.converted.messages.toLocaleString() : 0} messages copied to ${r.path}`);
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

function showBanner(content, kind = 'warn') {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.replaceChildren(...[].concat(content));
  b.hidden = false;
}

function hideBanner() {
  $('#banner').hidden = true;
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    S.info = await api('app:info');
    renderAccountBadge();
    await loadFolders().catch(() => {});
    if (!S.search && S.items.length <= PAGE_SIZE && S.selection.size <= 1) loadItems(true);
  }, 3000);
}

// ---------- startup ----------
async function initMailbox() {
  renderAccountBadge();
  const s = S.info.settings;
  if (!s.google.clientId || !S.info.signedIn) {
    $('#reader').replaceChildren($('#tpl-setup').content.cloneNode(true));
  }
  if (S.info.mailboxError) {
    showBanner([h('span', {}, `Could not open the mailbox: ${S.info.mailboxError} `), h('button', { onclick: async () => { S.info = await api('app:info'); initMailbox(); } }, 'Try again')], 'error');
    return;
  }
  const mb = S.info.mailbox;
  if (mb && !mb.unicode) {
    showBanner([h('span', {}, 'This mailbox is in the old ANSI PST format: read-only here and limited to 2 GB. '), h('button', { class: 'primary', onclick: convertFlow }, 'Convert to Unicode…')]);
  } else {
    hideBanner();
  }
  const ok = await guard(async () => {
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
  $('#btn-delete').onclick = () => deleteIds(selectedIds());
  $('#btn-move').onclick = async () => { const ids = selectedIds(); const p = await pickFolder(`Move ${ids.length} message(s)`); if (p) moveIds(ids, p); };
  $('#btn-unread').onclick = toggleUnread;
  $('#btn-flag').onclick = toggleFlag;
  $('#btn-import').onclick = importPstFlow;
  $('#btn-sync').onclick = () => guard(async () => {
    if (!S.info.signedIn) return openSettings();
    await api('sync:now');
  });
  $('#btn-stop').onclick = () => api('sync:stop');
  $('#btn-rules').onclick = () => openRules();
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-log').onclick = openLog;
  $('#btn-newfolder').onclick = () => newFolder('');
  $('#backup-toggle').onchange = async (e) => {
    const want = e.target.checked;
    try {
      const r = await api('backup:set', want);
      e.target.checked = r.enabled;
      toast(r.enabled ? 'Your mailbox will be backed up when you close OpenMail' : 'Back up on exit is off');
    } catch (err) {
      e.target.checked = false;
      toast(err.message, true);
      openSettings();
    }
  };
  $('#backup-skip').onclick = () => { $('#backup-skip').disabled = true; $('#backup-text').textContent = 'Cancelling…'; api('backup:cancel'); };
  openmail.on('backup:progress', (p) => {
    $('#modal-root').replaceChildren();
    $('#backup-overlay').hidden = false;
    const bar = $('#backup-progress');
    if (p.phase === 'stopping') {
      $('#backup-text').textContent = 'Finishing the current sync and closing the mailbox…';
      bar.removeAttribute('value');
    } else if (p.phase === 'copying') {
      $('#backup-dest').textContent = `To: ${p.folder}`;
      if (p.total) {
        bar.max = p.total;
        bar.value = p.copied;
        $('#backup-text').textContent = `Copied ${fmtSize(p.copied)} of ${fmtSize(p.total)} (${Math.floor((100 * p.copied) / p.total)}%)`;
      } else {
        $('#backup-text').textContent = 'Starting the copy…';
        bar.removeAttribute('value');
      }
    } else if (p.phase === 'done') {
      bar.max = 1;
      bar.value = 1;
      $('#backup-text').textContent = 'Backup complete. Closing…';
      $('#backup-skip').hidden = true;
    }
  });
  $('#load-more').onclick = () => loadItems(false);
  $('#unread-only').onchange = (e) => { S.unreadOnly = e.target.checked; loadItems(true); };
  let searchTimer;
  $('#search').oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.search = e.target.value.trim(); loadItems(true); }, 350); };

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.backdrop') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'n') { e.preventDefault(); compose(); }
    else if (ctrl && e.shiftKey && key === 'r') { e.preventDefault(); S.current && compose('replyAll'); }
    else if (ctrl && key === 'r') { e.preventDefault(); S.current && compose('reply'); }
    else if (ctrl && key === 'f') { e.preventDefault(); S.current && compose('forward'); }
    else if (ctrl && key === 'q') { e.preventDefault(); setRead(selectedIds(), true); }
    else if (ctrl && key === 'u') { e.preventDefault(); setRead(selectedIds(), false); }
    else if (ctrl && key === 'a') { e.preventDefault(); S.items.forEach((m) => S.selection.add(m.id)); renderList(); renderSelectionPane(); }
    else if (ctrl && key === 'e') { e.preventDefault(); $('#search').focus(); }
    else if (ctrl && e.shiftKey && key === 'v') { e.preventDefault(); $('#btn-move').click(); }
    else if (e.key === 'Delete') deleteIds(selectedIds());
    else if (e.key === 'F9') $('#btn-sync').click();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const idx = S.items.findIndex((x) => x.id === (S.focused ?? S.anchor));
      const next = S.items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      if (e.shiftKey) { S.selection.add(next.id); S.anchor = next.id; S.focused = next.id; renderList(); renderSelectionPane(); }
      else { selectOnly(next.id); renderList(); openItem(next.id); }
      document.querySelector(`#message-list li[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  });

  openmail.on('sync:status', (st) => {
    renderStatus(st);
    if (st.phase === 'idle' || st.done % 50 === 0) scheduleRefresh();
  });
  openmail.on('import:progress', (p) => {
    $('#status-text').textContent = `Importing ${p.folder || ''}: ${p.done.toLocaleString()} of ${p.total.toLocaleString()} (${p.messages.toLocaleString()} copied, ${p.duplicates.toLocaleString()} duplicates)`;
    const prog = $('#status-progress');
    prog.hidden = p.done >= p.total;
    prog.max = p.total || 1;
    prog.value = p.done;
    if (p.error) S.log.push(`Import error: ${p.error}`);
  });
  openmail.on('log', (line) => { S.log.push(line); if (S.log.length > 2000) S.log.shift(); });
}

(async function main() {
  bindUi();
  updateRibbon();
  S.info = await api('app:info');
  S.log = S.info.log || [];
  renderStatus(S.info.status);
  const b = await api('backup:get');
  $('#backup-toggle').checked = b.enabled;
  $('#backup-switch').title = b.folder ? `When on, OpenMail copies the mailbox to "${b.folder}" as it closes. Always starts off.` : 'Set a backup folder in Settings → Backup to use this. Always starts off.';
  if (!S.info.settings.google.clientId || !S.info.signedIn) openSettings();
  await initMailbox();
})();
