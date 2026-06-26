'use strict';

const $ = (id) => document.getElementById(id);
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const NAME_HINT = "Letters, digits, '-' and '_' only.";
// Session names additionally allow spaces (groups/folders stay strict).
const SESSION_RE = /^[A-Za-z0-9 _-]+$/;
const SESSION_HINT = "Letters, digits, spaces, '-' and '_' only.";
const DEFAULT_FOLDER = 'General';

let sessions = [];
let active = null;
let activeKind = null;   // 'shell' | 'ui'
let config = { folders: [DEFAULT_FOLDER], root: 'projects' };
let hostInfo = { user: '<user>', host: '<tailscale-hostname>' };

function sshAttachCommand(name) {
  return `ssh -t ${hostInfo.user}@${hostInfo.host} tmux attach -t ${name}`;
}

// remembered UI state (folder open/closed and sidebar collapse only)
const groupState = JSON.parse(localStorage.getItem('agentpeek-groups') || '{}');

// Sidebar grouping mode: false = group by the logical group, true = group by
// each session's actual folder location (its working directory).
let groupByFolder = localStorage.getItem('agentpeek-groupby') === 'folder';

// Last-seen tmux activity epoch per shell session, used to tell "actively
// generating" (timestamp advancing between polls) from "process idle at its
// prompt" (timestamp frozen). UI chat sessions report this precisely via busy.
let prevActivity = {};

// ntfy topics the user has used before, for the create-dialog dropdown.
const NOTIFY_KEY = 'agentpeek-notify-topics';
const ADD_NEW = '__add_new__';
function loadTopics() {
  try { return JSON.parse(localStorage.getItem(NOTIFY_KEY)) || []; }
  catch { return []; }
}
function rememberTopic(topic) {
  const list = loadTopics().filter((t) => t !== topic);
  list.unshift(topic); // most-recently-used first
  localStorage.setItem(NOTIFY_KEY, JSON.stringify(list.slice(0, 20)));
}

/* ---------- API ---------- */

async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const data = await r.json();
      if (typeof data.detail === 'string') detail = data.detail;
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return r.status === 204 ? null : r.json();
}

const api = {
  list: () => req('GET', '/api/sessions'),
  create: (body) => req('POST', '/api/sessions', body),
  rename: (name, newName) =>
    req('PATCH', `/api/sessions/${encodeURIComponent(name)}`, { new_name: newName }),
  move: (name, group) =>
    req('PATCH', `/api/sessions/${encodeURIComponent(name)}`, { group }),
  kill: (name) => req('DELETE', `/api/sessions/${encodeURIComponent(name)}`),
  keys: (name, keys) =>
    req('POST', `/api/sessions/${encodeURIComponent(name)}/keys`, { keys }),
  scroll: (name, dir) =>
    req('POST', `/api/sessions/${encodeURIComponent(name)}/keys`, { scroll: dir }),
  paste: (name, text) =>
    req('POST', `/api/sessions/${encodeURIComponent(name)}/keys`, { text }),
  host: () => req('GET', '/api/host'),
  config: () => req('GET', '/api/config'),
  dirs: (path) => req('GET', `/api/dirs?path=${encodeURIComponent(path)}`),
  mkdir: (path) => req('POST', '/api/dirs', { path }),
  createFolder: (path) => req('POST', '/api/folders', { path }),
  deleteFolder: (path) => req('DELETE', `/api/folders/${encodeURIComponent(path)}`),
  claudeStatus: () => req('GET', '/api/claude/status'),
  claudeStart: () => req('POST', '/api/claude/login/start'),
  claudeCode: (code) => req('POST', '/api/claude/login/code', { code }),
  claudeCancel: () => req('POST', '/api/claude/login/cancel'),
  claudeApiKey: (key) => req('POST', '/api/claude/apikey', { key }),
  claudeDisconnect: () => req('POST', '/api/claude/disconnect'),
  uiFiles: (session, q) =>
    req('GET', `/api/ui/files?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}`),
};

async function loadConfig() {
  try { config = await api.config(); } catch { /* keep current */ }
}

/* ---------- folder helpers ---------- */

const MAX_FOLDER_DEPTH = 3; // top-level + two nested levels

function folderTree() {
  const tops = [];
  const children = new Map();
  for (const f of config.folders) {
    const cut = f.lastIndexOf('/');
    if (cut === -1) {
      tops.push(f);
    } else {
      const parent = f.slice(0, cut);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(f);
    }
  }
  tops.sort((a, b) => a.localeCompare(b));
  children.forEach((list) => list.sort((a, b) => a.localeCompare(b)));
  return { tops, children };
}

async function addFolder(parent) {
  let name = '', error = '';
  for (;;) {
    name = await ask({
      title: parent ? `New subgroup in "${parent}"` : 'New group',
      msg: NAME_HINT, input: name, okLabel: 'Create', error,
    });
    if (name === null) return;
    if (!NAME_RE.test(name)) { error = NAME_HINT; continue; }
    try {
      await api.createFolder(parent ? `${parent}/${name}` : name);
      await loadConfig();
      render();
      return;
    } catch (e) { error = e.message; }
  }
}

async function deleteFolder(path) {
  const ok = await ask({
    title: 'Delete group',
    msg: `Delete group "${path}"?`,
    okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteFolder(path);
  } catch (e) {
    await ask({ title: 'Could not delete', msg: e.message, okLabel: 'OK' });
  }
  await loadConfig();
  render();
}

/* ---------- generic confirm/prompt dialog ---------- */

function ask({ title, msg = '', input = null, okLabel = 'OK', danger = false, error = '' }) {
  return new Promise((resolve) => {
    $('dlg-title').textContent = title;
    $('dlg-msg').textContent = msg;
    $('dlg-error').textContent = error;
    $('dlg-ok').textContent = okLabel;
    $('dlg-ok').classList.toggle('danger', danger);
    const inp = $('dlg-input');
    const wantsInput = input !== null;
    inp.style.display = wantsInput ? '' : 'none';
    inp.value = wantsInput ? input : '';
    const dlg = $('dlg');
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(ok ? (wantsInput ? inp.value.trim() : true) : null);
    }, { once: true });
    dlg.showModal();
    if (wantsInput) { inp.focus(); inp.select(); }
  });
}

/* ---------- create dialog ---------- */

const cstate = { group: null, mode: 'ai', cwd: null, type: 'shell' };

function clearFieldError(el) {
  el.classList.remove('invalid');
  $('c-error').textContent = '';
}

function renderFolderPicker() {
  const box = $('c-folders');
  box.textContent = '';
  const { tops, children } = folderTree();
  const addRow = (path, depth) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.style.paddingLeft = `${8 + depth * 18}px`;
    row.textContent = path.split('/').pop();
    row.addEventListener('click', () => {
      box.querySelectorAll('.folder-row.selected')
        .forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      cstate.group = path;
      clearFieldError(box);
    });
    if (path === cstate.group) row.classList.add('selected');
    box.appendChild(row);
    for (const child of children.get(path) || []) addRow(child, depth + 1);
  };
  for (const top of tops) addRow(top, 0);
}

function setCwd(rel, el) {
  cstate.cwd = rel;
  $('c-dirtree').querySelectorAll('.dirname.selected')
    .forEach((d) => d.classList.remove('selected'));
  el.classList.add('selected');
  $('c-path').textContent = rel ? `${config.root}/${rel}` : config.root;
  clearFieldError($('c-dirtree'));
}

function dirNode(label, rel, selectable = true) {
  const node = document.createElement('div');
  node.className = 'dir';

  const row = document.createElement('div');
  row.className = 'dir-row';

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = '▸';

  const name = document.createElement('span');
  name.className = 'dirname';
  name.textContent = label;
  if (selectable) {
    name.addEventListener('click', () => setCwd(rel, name));
  } else {
    // the projects root is only a container — expandable, not selectable
    name.classList.add('root');
    name.addEventListener('click', () => twisty.click());
  }

  const children = document.createElement('div');
  children.className = 'dir-children';
  children.hidden = true;
  let loaded = false;
  let childRefs = new Map();   // label -> dirNode ref, for programmatic expansion

  // Load this node's children once (resets the 'leaf' marker if reloaded).
  async function load() {
    if (loaded) return childRefs;
    loaded = true;
    try {
      const { dirs } = await api.dirs(rel);
      if (!dirs.length) {
        twisty.classList.add('leaf');
        twisty.textContent = '·';
        return childRefs;
      }
      for (const d of dirs) {
        const child = dirNode(d, rel ? `${rel}/${d}` : d);
        childRefs.set(d, child);
        children.appendChild(child.node);
      }
    } catch {
      loaded = false;
    }
    return childRefs;
  }

  // Ensure loaded + visible (not a toggle); returns child refs for descent.
  async function open() {
    const refs = await load();
    if (!twisty.classList.contains('leaf')) {
      children.hidden = false;
      twisty.classList.add('open');
    }
    return refs;
  }

  twisty.addEventListener('click', async () => {
    await load();
    if (twisty.classList.contains('leaf')) return;
    children.hidden = !children.hidden;
    twisty.classList.toggle('open', !children.hidden);
  });

  row.appendChild(twisty);
  row.appendChild(name);
  node.appendChild(row);
  node.appendChild(children);
  return { node, twisty, name, open };
}

// The create dialog's directory tree root (kept so "New folder" can re-expand it).
let cTreeRoot = null;

// Build the tree rooted at projects/, expanded one level. If `selectRel` is given,
// expand down to it and select it (used right after creating a folder).
async function buildDirTree(selectRel = null) {
  const tree = $('c-dirtree');
  tree.textContent = '';
  cTreeRoot = dirNode(config.root, '', false);
  tree.appendChild(cTreeRoot.node);
  await cTreeRoot.open();
  if (selectRel) {
    await expandAndSelect(selectRel);
  } else {
    cstate.cwd = null;
    $('c-path').textContent = 'choose a directory…';
  }
}

// Walk the tree from the root, expanding each ancestor, then select the leaf.
async function expandAndSelect(rel) {
  const parts = rel.split('/');
  let node = cTreeRoot, acc = '';
  for (const part of parts) {
    const refs = await node.open();
    node = refs.get(part);
    if (!node) return;   // not found (shouldn't happen right after a create)
    acc = acc ? `${acc}/${part}` : part;
  }
  setCwd(acc, node.name);
}

// Prompt for a name and create a folder under the current selection (or the
// projects root), then re-expand the tree to it and select it.
async function newDir() {
  const parent = cstate.cwd || '';
  const where = parent ? `${config.root}/${parent}` : config.root;
  const raw = await ask({
    title: 'New folder', msg: `Create a folder inside ${where}`,
    input: '', okLabel: 'Create',
  });
  if (raw === null) return;
  if (!NAME_RE.test(raw)) {
    await ask({ title: 'New folder', msg: NAME_HINT });
    return;
  }
  const rel = parent ? `${parent}/${raw}` : raw;
  try {
    await api.mkdir(rel);
  } catch (e) {
    await ask({ title: 'Could not create folder', msg: e.message });
    return;
  }
  await buildDirTree(rel);
}

function openCreateDialog(preselectGroup = null, preselectCwd = null) {
  $('c-name').value = '';
  $('c-error').textContent = '';
  for (const id of ['c-name', 'c-folders', 'c-dirtree']) {
    $(id).classList.remove('invalid');
  }
  // Default to the General group when the caller didn't preselect one (and it
  // still exists); the user can pick another in the folder picker.
  cstate.group = preselectGroup
    || (config.folders.includes(DEFAULT_FOLDER) ? DEFAULT_FOLDER : null);
  cstate.mode = 'ai';
  cstate.type = 'shell';
  cstate.cwd = null;   // mandatory — a real directory, not the projects root

  renderFolderPicker();
  document.querySelectorAll('input[name="c-mode"]').forEach((r) => {
    r.checked = r.value === cstate.mode;
  });
  $('c-type').querySelectorAll('.chip').forEach((b) => {
    b.classList.toggle('selected', b.dataset.type === cstate.type);
  });
  $('c-start-field').hidden = cstate.type === 'ui';

  // notifications: off by default, dropdown of remembered topics + "add new"
  $('c-notify').checked = false;
  $('c-notify-new').value = '';
  renderTopicOptions();
  updateNotifyVisibility();

  // fresh tree rooted at projects/, expanded one level; when launched from a
  // folder-view menu, expand down to and select that directory
  buildDirTree(preselectCwd);

  $('cdlg').showModal();
  $('c-name').focus();
}

// Fill the topic dropdown with remembered topics plus an "add new" entry.
function renderTopicOptions(selected) {
  const sel = $('c-notify-topic');
  const topics = loadTopics();
  sel.textContent = '';
  for (const t of topics) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  }
  const addOpt = document.createElement('option');
  addOpt.value = ADD_NEW;
  addOpt.textContent = topics.length ? '➕ Add new topic…' : '➕ Add a topic…';
  sel.appendChild(addOpt);
  sel.value = selected || (topics.length ? topics[0] : ADD_NEW);
}

// Show notify only for shell+AI sessions (UI chat and plain shells don't run
// the cds hook). The topic row shows when checked; the text box for "add new".
function updateNotifyVisibility() {
  const eligible = cstate.type === 'shell' && cstate.mode === 'ai';
  $('c-notify-field').hidden = !eligible;
  const on = eligible && $('c-notify').checked;
  $('c-notify-row').hidden = !on;
  $('c-notify-new').hidden = !on || $('c-notify-topic').value !== ADD_NEW;
}

async function submitCreate() {
  const name = $('c-name').value.trim();
  if (!SESSION_RE.test(name)) {
    $('c-error').textContent = SESSION_HINT;
    $('c-name').classList.add('invalid');
    return;
  }
  if (!cstate.group) {
    $('c-error').textContent = 'Please choose a group.';
    $('c-folders').classList.add('invalid');
    return;
  }
  if (!cstate.cwd) {
    $('c-error').textContent = 'Please choose a working directory.';
    $('c-dirtree').classList.add('invalid');
    return;
  }
  // Resolve the notification topic (shell + AI mode only).
  let notify_topic = null;
  if (cstate.type === 'shell' && cstate.mode === 'ai' && $('c-notify').checked) {
    const sel = $('c-notify-topic').value;
    notify_topic = (sel === ADD_NEW ? $('c-notify-new').value : sel).trim();
    if (!NAME_RE.test(notify_topic)) {
      $('c-error').textContent = `Topic name: ${NAME_HINT}`;
      $('c-notify-new').classList.add('invalid');
      return;
    }
  }
  try {
    const mode = cstate.type === 'ui' ? 'ui' : cstate.mode;
    await api.create({ name, group: cstate.group, cwd: cstate.cwd, mode, notify_topic });
  } catch (e) {
    $('c-error').textContent = e.message;
    return;
  }
  if (notify_topic) rememberTopic(notify_topic);
  $('cdlg').close();
  await refresh();
  if (cstate.type === 'ui') openChat(name); else attach(name);
}

/* ---------- session actions ---------- */

async function renameSession(s) {
  if (s.busy) {
    const go = await ask({
      title: 'Session is busy',
      msg: `"${s.name}" is running "${s.foreground}" in the foreground. Rename it anyway?`,
      okLabel: 'Rename anyway', danger: true,
    });
    if (!go) return;
  }
  let name = s.name, error = '';
  for (;;) {
    name = await ask({
      title: `Rename "${s.name}"`, msg: SESSION_HINT,
      input: name, okLabel: 'Rename', error,
    });
    if (name === null || name === s.name) return;
    if (!SESSION_RE.test(name)) { error = SESSION_HINT; continue; }
    try {
      await api.rename(s.name, name);
      if (active === s.name) active = name; // tmux keeps the client attached
      await refresh();
      return;
    } catch (e) { error = e.message; }
  }
}

async function killSession(s) {
  const ok = await ask({
    title: 'Terminate session',
    msg: `Terminate "${s.name}"? All processes running in it will be killed.`,
    okLabel: 'Terminate', danger: true,
  });
  if (!ok) return;
  if (s.busy) {
    const really = await ask({
      title: 'Foreground process running',
      msg: `"${s.name}" is still running "${s.foreground}". Terminating will kill it. Continue?`,
      okLabel: `Kill ${s.foreground}`, danger: true,
    });
    if (!really) return;
  }
  try {
    await api.kill(s.name);
  } catch (e) {
    await ask({ title: 'Could not terminate', msg: e.message, okLabel: 'OK' });
  }
  if (active === s.name) detach();
  await refresh();
}

/* ---------- attach / detach ---------- */

function showView(kind) {
  const main = $('main');
  main.classList.toggle('attached', kind === 'shell');
  main.classList.toggle('chatting', kind === 'ui');
}

const PASTE_HINT_KEY = 'agentpeek-paste-hint-off';

function showPasteHint(on) {
  $('term-hint').hidden = !on || localStorage.getItem(PASTE_HINT_KEY) === '1';
}

function attach(name) {
  if (active === name && activeKind === 'shell') return;
  closeChat();
  active = name; activeKind = 'shell';
  $('term').src = `/term/?arg=${encodeURIComponent(name)}`;
  showView('shell');
  showPasteHint(true);
  render();
}

function detach() {
  closeChat();
  active = null; activeKind = null;
  $('term').src = 'about:blank';
  showView(null);
  showPasteHint(false);
  render();
}

/* ---------- rendering ---------- */

function sessionRow(s) {
  const li = document.createElement('div');
  li.className = 'session' + (s.name === active ? ' active' : '')
    + (s.working ? ' working' : '');

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.textContent = s.name === active ? '●' : (s.kind === 'ui' ? '◆' : '○');
  li.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  name.title = s.name;
  li.appendChild(name);

  if (s.kind === 'ui') {
    const tag = document.createElement('span');
    tag.className = 'kind-tag';
    tag.textContent = 'chat';
    li.appendChild(tag);
  }

  if (s.busy) {
    const busy = document.createElement('span');
    busy.className = 'busy';
    busy.textContent = s.foreground;
    busy.title = `foreground: ${s.foreground}`;
    li.appendChild(busy);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'menu-btn';
  menuBtn.textContent = '⋮';
  menuBtn.title = 'Session actions';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionMenu(s, menuBtn);
  });
  li.appendChild(menuBtn);

  li.addEventListener('click', () => {
    if (s.kind === 'ui') openChat(s.name); else attach(s.name);
    collapseSidebarOnMobile(); // give the session full width on touch screens
  });
  return li;
}

function folderSection(path, buckets, children) {
  const childPaths = children.get(path) || [];
  const det = document.createElement('details');
  det.className = 'group' + (path.includes('/') ? ' subgroup' : '');
  det.open = groupState[path] !== false;
  det.addEventListener('toggle', () => {
    groupState[path] = det.open;
    localStorage.setItem('agentpeek-groups', JSON.stringify(groupState));
  });

  const items = buckets.get(path) || [];

  const sum = document.createElement('summary');
  const label = document.createElement('span');
  label.textContent = path.split('/').pop();
  sum.appendChild(label);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = items.length;
  sum.appendChild(count);

  const menuBtn = document.createElement('button');
  menuBtn.className = 'menu-btn';
  menuBtn.textContent = '⋮';
  menuBtn.title = 'Group actions';
  menuBtn.addEventListener('click', (e) => {
    e.preventDefault(); // don't toggle the <details>
    e.stopPropagation();
    openFolderMenu(path, menuBtn);
  });
  sum.appendChild(menuBtn);
  det.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'group-body';
  for (const child of childPaths) {
    body.appendChild(folderSection(child, buckets, children));
  }
  for (const s of items) body.appendChild(sessionRow(s));
  if (!items.length && !childPaths.length) {
    const empty = document.createElement('div');
    empty.className = 'group-empty';
    empty.textContent = 'no sessions';
    body.appendChild(empty);
  }
  det.appendChild(body);
  return det;
}

// One sidebar section per distinct folder location, used when grouping by
// the actual working directory rather than the logical group.
function locationSection(path, items) {
  const det = document.createElement('details');
  det.className = 'group';
  const stateKey = `loc:${path}`;
  det.open = groupState[stateKey] !== false;
  det.addEventListener('toggle', () => {
    groupState[stateKey] = det.open;
    localStorage.setItem('agentpeek-groups', JSON.stringify(groupState));
  });

  const sum = document.createElement('summary');
  const label = document.createElement('span');
  label.textContent = path === NO_LOCATION ? path : path.split('/').filter(Boolean).pop();
  label.title = path; // full path on hover
  sum.appendChild(label);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = items.length;
  sum.appendChild(count);

  // Real directories get a ⋮ menu to spin up a new session there; the synthetic
  // "(no location)" bucket has no directory to create one in.
  if (path !== NO_LOCATION) {
    const menuBtn = document.createElement('button');
    menuBtn.className = 'menu-btn';
    menuBtn.textContent = '⋮';
    menuBtn.title = 'Folder actions';
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault(); // don't toggle the <details>
      e.stopPropagation();
      openLocationMenu(path, menuBtn);
    });
    sum.appendChild(menuBtn);
  }
  det.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'group-body';
  for (const s of items) body.appendChild(sessionRow(s));
  det.appendChild(body);
  return det;
}

const NO_LOCATION = '(no location)';

function renderByFolder(list) {
  const buckets = new Map();
  for (const s of sessions) {
    const key = s.cwd || NO_LOCATION;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  const paths = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  for (const p of paths) list.appendChild(locationSection(p, buckets.get(p)));
}

function render() {
  const list = $('session-list');
  list.textContent = '';
  if (groupByFolder) { renderByFolder(list); return; }
  const valid = new Set(config.folders);
  const buckets = new Map(config.folders.map((f) => [f, []]));
  for (const s of sessions) {
    const g = valid.has(s.group) ? s.group : DEFAULT_FOLDER;
    buckets.get(g).push(s);
  }
  const { tops, children } = folderTree();
  for (const top of tops) {
    list.appendChild(folderSection(top, buckets, children));
  }
}

/* ---------- context menus ---------- */

function closeMenu() {
  document.querySelector('.menu')?.remove();
}

function showMenu(items, anchor) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  for (const [label, fn, cls] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.classList.add(cls);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      fn();
    });
    menu.appendChild(b);
  }
  // measure off-screen, then place — flipping up / clamping to the viewport so
  // menus near the bottom edge stay fully visible.
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight, mw = menu.offsetWidth;
  let top = rect.bottom + 2;
  if (top + mh > window.innerHeight - 8) {
    top = Math.max(8, rect.top - mh - 2);  // not enough room below → flip above
  }
  let left = Math.min(rect.left - 120, window.innerWidth - mw - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.visibility = '';
}

function openSessionMenu(s, anchor) {
  const items = [
    ['Info…', () => sessionInfo(s), ''],
    ['Rename…', () => renameSession(s), ''],
  ];
  if (config.folders.length > 1) {
    items.push(['Move to group…', () => moveSession(s, anchor), '']);
  }
  if (s.kind !== 'ui') {
    items.push(['Copy SSH attach command', () => copyText(sshAttachCommand(s.name)), '']);
    items.push(['Copy local attach command', () => copyText(s.attach_command), '']);
  }
  items.push(['Terminate…', () => killSession(s), 'danger']);
  showMenu(items, anchor);
}

// Show where the session lives: its sidebar folder and the directory it
// was created in.
function sessionInfo(s) {
  const location = s.cwd || 'unknown (created from the CLI)';
  ask({
    title: `"${s.name}"`,
    msg: `Group: ${s.group}\nLocation: ${location}`,
    okLabel: 'OK',
  });
}

// Second-level menu: pick a destination folder for the session.
function moveSession(s, anchor) {
  const targets = config.folders.filter((f) => f !== s.group);
  if (!targets.length) { flash('No other group to move to.'); return; }
  showMenu(targets.map((f) => [f.replaceAll('/', ' / '),
    () => doMove(s, f), '']), anchor);
}

async function doMove(s, group) {
  try {
    await api.move(s.name, group);
    await refresh();
  } catch (e) {
    flash(e.message || 'Could not move the session.');
  }
}

function openFolderMenu(path, anchor) {
  const items = [];
  items.push(['Create session…', () => openCreateDialog(path), '']);
  if (path.split('/').length < MAX_FOLDER_DEPTH) {
    items.push(['New subgroup…', () => addFolder(path), '']);
  }
  if (path !== DEFAULT_FOLDER) {
    items.push(['Delete group…', () => deleteFolder(path), 'danger']);
  }
  if (items.length) showMenu(items, anchor);
}

// Folder-view (group-by-location) menu: create a new session in this directory.
function openLocationMenu(path, anchor) {
  showMenu([
    ['Create session…', () => openCreateDialog(null, cwdToRel(path)), ''],
  ], anchor);
}

// Convert an absolute session cwd to a path relative to the projects root, as
// the create dialog's directory tree expects. Returns null if it doesn't live
// under the root (then the dialog just opens with nothing preselected).
function cwdToRel(abs) {
  const marker = `/${config.root}/`;
  const i = abs.indexOf(marker);
  return i === -1 ? null : abs.slice(i + marker.length);
}

document.addEventListener('click', closeMenu);

/* ---------- refresh / polling ---------- */

async function refresh() {
  try {
    sessions = await api.list();
  } catch {
    return; // keep last known state; next poll self-corrects (NFR-3)
  }
  // Decide which sessions are actively generating. UI chat: busy is exact.
  // Shell: busy means a program is running, so additionally require the pane's
  // activity timestamp to have advanced since the previous poll.
  const nextActivity = {};
  for (const s of sessions) {
    if (s.kind === 'ui') {
      s.working = !!s.busy;
    } else {
      const prev = prevActivity[s.name];
      const generating = !!s.busy && prev !== undefined && s.activity > prev;
      // Also flag sessions blocked on a prompt awaiting the user's answer.
      s.working = generating || !!s.waiting;
    }
    nextActivity[s.name] = s.activity || 0;
  }
  prevActivity = nextActivity;
  if (active && !sessions.some((s) => s.name === active)) {
    detach(); // killed from the CLI while we were attached
  } else {
    render();
  }
}

/* ---------- clipboard / toast ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash('Copied to clipboard');
}

function flash(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1500);
}

/* ---------- UI-mode chat ---------- */

let chatWs = null;
let chatSession = null;
let chatReconnectTimer = null;
let chatReconnectDelay = 1000;
let streamingEl = null;
let chatTotalCost = 0;
let chatModel = 'opus';
// Shell-style input history for the chat composer: ↑ recalls older submitted
// messages, ↓ walks back toward the live draft. Seeded from transcript history.
let chatHistory = [];   // submitted messages, oldest → newest
let histIndex = null;   // position while navigating; null = editing the live draft
let histDraft = '';     // the draft text saved when navigation began
let ttsOn = false;
let recog = null;
let micOn = false;   // user intends to keep dictating (survives silence stops)
let micBase = '';    // stable (finalised) transcript; interim is shown after it
let chatBusy = false;
let _chatPlaceholder = null; // original composer placeholder, restored on unlock
// Cost is only meaningful with an API key; subscription (Pro/Max) usage is
// covered by the plan, so we hide the $ figure unless method === 'api_key'.
let costVisible = false;
// On Bedrock/Vertex, the model is pinned via env and the alias picker / sign-in
// flow don't apply — hide them.
let cloudBackend = false;

function applyBackendUI() {
  $('chat-model').style.display = cloudBackend ? 'none' : '';
}

/* --- minimal, safe markdown renderer (paragraphs, code, lists, GFM tables) --- */

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMd(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return ` ${codes.length - 1} `; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    const safe = /^(https?:|mailto:|\/)/i.test(u) ? u : '#';
    return `<a href="${safe}" target="_blank" rel="noopener">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  s = s.replace(/ (\d+) /g, (m, i) => `<code>${codes[+i]}</code>`);
  return s;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isTableHead(lines, i) {
  return /\|/.test(lines[i]) && i + 1 < lines.length
    && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]);
}

function renderMarkdown(src) {
  const lines = escHtml(src || '').split('\n');
  const n = lines.length;
  let html = '', i = 0;
  while (i < n) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const marker = fence[1];
      i++;
      const buf = [];
      while (i < n && !lines[i].trimStart().startsWith(marker)) { buf.push(lines[i]); i++; }
      i++;
      html += `<div class="code-wrap"><button class="copy-code" title="Copy code">copy</button>`
        + `<pre><code>${buf.join('\n')}</code></pre></div>`;
      continue;
    }
    if (isTableHead(lines, i)) {
      const header = splitRow(lines[i]); i += 2;
      const rows = [];
      while (i < n && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
      html += '<table><thead><tr>' + header.map((c) => `<th>${inlineMd(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>';
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      html += ordered ? '<ol>' : '<ul>';
      while (i < n && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        html += `<li>${inlineMd(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`; i++;
      }
      html += ordered ? '</ol>' : '</ul>';
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [];
    while (i < n && lines[i].trim() !== ''
        && !/^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+\.\s)/.test(lines[i]) && !isTableHead(lines, i)) {
      para.push(lines[i]); i++;
    }
    html += `<p>${inlineMd(para.join('<br>'))}</p>`;
  }
  return html;
}

/* --- message elements --- */

function bubble(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el._raw = text;
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(text);
  el.appendChild(md);
  const copy = document.createElement('button');
  copy.className = 'copy-msg'; copy.title = 'Copy message'; copy.textContent = '⧉';
  copy.addEventListener('click', () => copyText(el._raw));
  el.appendChild(copy);
  return el;
}

// Collapse an over-long message to a few lines with a "Show more" toggle, so a
// big pasted block doesn't dominate the log. The full text stays available (and
// the copy button always copies it). Measured after layout so it's accurate.
const CLAMP_PX = 200;            // collapsed height (~10 lines)
function maybeClamp(el) {
  const md = el && el.querySelector('.md');
  if (!md) return;
  requestAnimationFrame(() => {
    if (md.scrollHeight <= CLAMP_PX + 48) return;  // only slightly over → leave it
    md.classList.add('clampable', 'clamped');
    const btn = document.createElement('button');
    btn.className = 'msg-more';
    btn.textContent = 'Show more';
    btn.addEventListener('click', () => {
      const clamped = md.classList.toggle('clamped');
      btn.textContent = clamped ? 'Show more' : 'Show less';
      if (clamped) el.scrollIntoView({ block: 'nearest' });
    });
    el.appendChild(btn);
  });
}

function collapsible(cls, label, text, asMd) {
  const d = document.createElement('details');
  d.className = 'msg ' + cls;
  const s = document.createElement('summary');
  s.textContent = label;
  d.appendChild(s);
  const body = document.createElement('div');
  body.className = 'md';
  body.innerHTML = asMd ? renderMarkdown(text) : `<pre>${escHtml(text)}</pre>`;
  d.appendChild(body);
  return d;
}

function toolUseEl(ev) {
  let inp = '';
  try { inp = JSON.stringify(ev.input, null, 2); } catch { inp = String(ev.input); }
  const d = collapsible('tool-use', `⚙ ${ev.name}`, inp.slice(0, 4000), false);
  return d;
}

/* --- interactive ask_user card (tabs + options + custom "Other" + submit) --- */

// Build the per-question selection state and an interactive tabbed card. Each
// question is a tab; options are chips; an "Other…" box accepts a custom answer.
function askCard(ev) {
  const questions = ev.questions || [];
  const card = document.createElement('div');
  card.className = 'msg ask';
  card.dataset.askId = ev.id;
  card.tabIndex = -1; // focusable so it can capture keyboard nav like the terminal
  // selection model: per question, a Set of chosen option labels + custom text
  card._sel = questions.map(() => new Set());
  card._custom = questions.map(() => '');
  card._questions = questions;
  card._active = 0;   // active question/tab index
  card._hl = questions.map(() => 0); // highlighted option per question (keyboard)

  const tabs = document.createElement('div');
  tabs.className = 'ask-tabs';
  // single-question cards don't need a tab strip
  tabs.hidden = questions.length < 2;
  const panels = document.createElement('div');
  panels.className = 'ask-panels';

  questions.forEach((q, qi) => {
    const tab = document.createElement('button');
    tab.className = 'ask-tab' + (qi === 0 ? ' active' : '');
    tab.textContent = q.header || `Q${qi + 1}`;
    tab.addEventListener('click', () => activateTab(card, qi));
    tabs.appendChild(tab);

    const panel = document.createElement('div');
    panel.className = 'ask-panel' + (qi === 0 ? ' active' : '');

    const qtext = document.createElement('div');
    qtext.className = 'ask-q';
    qtext.textContent = q.question || '';
    panel.appendChild(qtext);
    if (q.multiSelect) {
      const hint = document.createElement('div');
      hint.className = 'ask-hint';
      hint.textContent = 'Select all that apply';
      panel.appendChild(hint);
    }

    (q.options || []).forEach((opt, oi) => {
      const o = document.createElement('button');
      o.className = 'ask-opt' + (oi === 0 ? ' hl' : '');
      o.dataset.label = opt.label;
      const lab = document.createElement('div');
      lab.className = 'ask-opt-label';
      lab.textContent = opt.label;
      o.appendChild(lab);
      if (opt.description) {
        const d = document.createElement('div');
        d.className = 'ask-opt-desc';
        d.textContent = opt.description;
        o.appendChild(d);
      }
      o.addEventListener('click', () => {
        card._hl[qi] = oi;
        panel.querySelectorAll('.ask-opt').forEach((b, i) => b.classList.toggle('hl', i === oi));
        toggleOpt(card, qi, panel, opt.label, q.multiSelect);
      });
      panel.appendChild(o);
    });

    // "Other…" free-text answer
    const other = document.createElement('input');
    other.className = 'ask-other';
    other.placeholder = 'Other… (type your own answer)';
    other.addEventListener('input', () => {
      card._custom[qi] = other.value.trim();
      // a non-empty custom answer clears option picks in single-select mode
      if (!q.multiSelect && card._custom[qi]) {
        card._sel[qi].clear();
        panel.querySelectorAll('.ask-opt.sel').forEach((b) => b.classList.remove('sel'));
      }
      markTabDone(tab, hasAnswer(card, qi));
    });
    panel.appendChild(other);
    panels.appendChild(panel);
  });

  card.appendChild(tabs);
  card.appendChild(panels);

  const footer = document.createElement('div');
  footer.className = 'ask-footer';
  const err = document.createElement('span');
  err.className = 'ask-error';
  const keyhint = document.createElement('span');
  keyhint.className = 'ask-keyhint';
  keyhint.textContent = '↑/↓ select · Enter submit · Esc cancel'
    + (questions.length > 1 ? ' · ←/→ tabs' : '');
  const submit = document.createElement('button');
  submit.className = 'ask-submit';
  submit.textContent = 'Submit';
  submit.addEventListener('click', () => submitAsk(card, err));
  footer.appendChild(err);
  footer.appendChild(keyhint);
  footer.appendChild(submit);
  card.appendChild(footer);

  card.addEventListener('keydown', (e) => askCardKeydown(card, e));
  return card;
}

function hasAnswer(card, qi) {
  return card._sel[qi].size > 0 || !!card._custom[qi];
}

function markTabDone(tab, done) {
  tab.classList.toggle('done', done);
}

// Show question `qi`'s tab/panel and remember it as active (mouse + keyboard).
function activateTab(card, qi) {
  if (qi < 0 || qi >= card._questions.length) return;
  card._active = qi;
  card.querySelectorAll('.ask-tab').forEach((t, i) => t.classList.toggle('active', i === qi));
  card.querySelectorAll('.ask-panel').forEach((p, i) => p.classList.toggle('active', i === qi));
}

function activePanel(card) {
  return card.querySelectorAll('.ask-panel')[card._active] || null;
}

// Move the keyboard highlight within the active question by `delta` (wraps).
function moveHighlight(card, delta) {
  const panel = activePanel(card);
  if (!panel) return;
  const opts = panel.querySelectorAll('.ask-opt');
  if (!opts.length) return;
  const qi = card._active;
  const next = (card._hl[qi] + delta + opts.length) % opts.length;
  card._hl[qi] = next;
  opts.forEach((b, i) => b.classList.toggle('hl', i === next));
  opts[next].scrollIntoView({ block: 'nearest' });
}

// Index of the first question with no answer yet, or -1 when all are answered.
function firstUnanswered(card) {
  for (let qi = 0; qi < card._questions.length; qi++) {
    if (!hasAnswer(card, qi)) return qi;
  }
  return -1;
}

function askCardKeydown(card, e) {
  if (card.classList.contains('answered')) return;
  const inOther = document.activeElement
    && document.activeElement.classList.contains('ask-other');
  const err = card.querySelector('.ask-error');

  if (e.key === 'Escape') {        // bail out, like the terminal
    e.preventDefault();
    chatStop();
    return;
  }
  if (e.key === 'Enter') {
    // In the "Other…" box, Enter submits the whole card (type-to-answer).
    // On a highlighted option, Enter selects it, then advances or submits.
    e.preventDefault();
    if (!inOther) {
      const q = card._questions[card._active];
      const opts = activePanel(card).querySelectorAll('.ask-opt');
      const hl = opts[card._hl[card._active]];
      if (hl) hl.click();
      if (q && q.multiSelect) return; // stay so more can be toggled
    }
    const next = firstUnanswered(card);
    if (next === -1) submitAsk(card, err);
    else activateTab(card, next);
    return;
  }
  if (inOther) return; // let the text box handle arrows/typing itself
  if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(card, 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(card, -1); }
  else if (e.key === ' ') {        // Space toggles (handy for multi-select)
    e.preventDefault();
    const opts = activePanel(card).querySelectorAll('.ask-opt');
    const hl = opts[card._hl[card._active]];
    if (hl) hl.click();
  } else if (e.key === 'ArrowRight') { e.preventDefault(); activateTab(card, card._active + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); activateTab(card, card._active - 1); }
}

function toggleOpt(card, qi, panel, label, multi) {
  const sel = card._sel[qi];
  if (multi) {
    if (sel.has(label)) sel.delete(label); else sel.add(label);
  } else {
    sel.clear();
    sel.add(label);
    card._custom[qi] = '';
    const ob = panel.querySelector('.ask-other');
    if (ob) ob.value = '';
  }
  panel.querySelectorAll('.ask-opt').forEach((b) => {
    b.classList.toggle('sel', sel.has(b.dataset.label));
  });
  const tab = card.querySelectorAll('.ask-tab')[qi];
  if (tab) markTabDone(tab, hasAnswer(card, qi));
}

// Collect [labels…, custom?] per question; return null if any is unanswered.
function collectAnswers(card) {
  const out = [];
  for (let qi = 0; qi < card._questions.length; qi++) {
    const picks = [...card._sel[qi]];
    if (card._custom[qi]) picks.push(card._custom[qi]);
    if (!picks.length) return { error: qi };
    out.push(picks);
  }
  return { answers: out };
}

function submitAsk(card, err) {
  const res = collectAnswers(card);
  if (res.error !== undefined) {
    err.textContent = 'Please answer every question.';
    const tab = card.querySelectorAll('.ask-tab')[res.error];
    if (tab) tab.click();
    return;
  }
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
    err.textContent = 'Reconnecting — try again in a moment.';
    return;
  }
  chatWs.send(JSON.stringify({ type: 'answer', id: card.dataset.askId, answers: res.answers }));
  lockAskCardEl(card, res.answers); // optimistic; server echoes ask_answered
}

// Lock a card by id (used when ask_answered arrives from history or live). Ids can
// repeat when an API error/resume restarts the server's ask counter, so prefer the
// last not-yet-answered card with this id — a first-match querySelector would mark
// an already-answered duplicate and leave the real open card stuck.
function lockAskCard(id, answers) {
  const cards = $('chat-log').querySelectorAll(`.msg.ask[data-ask-id="${CSS.escape(id)}"]`);
  let card = null;
  for (const c of cards) if (!c.classList.contains('answered')) card = c;
  if (!card && cards.length) card = cards[cards.length - 1];
  if (card) lockAskCardEl(card, answers);
}

function lockAskCardEl(card, answers) {
  if (card.classList.contains('answered')) return;
  card.classList.add('answered');
  const chosen = new Set();
  (answers || []).forEach((picks) => (picks || []).forEach((p) => chosen.add(p)));
  card.querySelectorAll('.ask-opt').forEach((b) => {
    b.disabled = true;
    b.classList.toggle('sel', chosen.has(b.dataset.label));
  });
  // options/free-text locked; tabs stay clickable so answers can be reviewed
  card.querySelectorAll('.ask-other').forEach((e) => { e.disabled = true; });
  const footer = card.querySelector('.ask-footer');
  if (footer) {
    footer.textContent = '';
    const done = document.createElement('span');
    done.className = 'ask-done';
    done.textContent = '✓ Answered';
    footer.appendChild(done);
  }
  updateComposerLock(); // the question is resolved — let the user type again
}

/* --- plan approval card (ExitPlanMode) --- */

// Send a plan response as an ordinary user turn (the agent is idle after
// presenting its plan, so approval is just the next message). Returns false if
// the socket isn't open so the caller can leave the card actionable.
function sendPlanResponse(text) {
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
    flash('Reconnecting — try again'); return false;
  }
  chatWs.send(JSON.stringify({ type: 'send', text }));
  scrollChatBottom();
  return true;
}

// Render the agent's plan with an Approve / Keep-planning control. Approval and
// "keep planning" both just send a normal message; the card then locks. (On a
// later reconnect the card re-renders unlocked — the follow-up user message in
// the transcript makes the outcome clear.)
function planCard(ev) {
  const card = document.createElement('div');
  card.className = 'msg plan';

  const head = document.createElement('div');
  head.className = 'plan-head';
  head.textContent = 'Plan ready for approval';
  card.appendChild(head);

  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(ev.text || '');
  card.appendChild(md);

  const note = document.createElement('textarea');
  note.className = 'plan-note';
  note.rows = 2;
  note.placeholder = 'What to change about the plan…';
  note.hidden = true;
  card.appendChild(note);

  const footer = document.createElement('div');
  footer.className = 'plan-footer';

  const approve = document.createElement('button');
  approve.className = 'plan-approve';
  approve.textContent = 'Approve & implement';

  const keep = document.createElement('button');
  keep.className = 'plan-keep';
  keep.textContent = 'Keep planning';

  function lock(label) {
    approve.disabled = keep.disabled = note.disabled = true;
    note.hidden = true;
    footer.textContent = '';
    const done = document.createElement('span');
    done.className = 'plan-done';
    done.textContent = label;
    footer.appendChild(done);
  }

  approve.addEventListener('click', () => {
    if (sendPlanResponse('Approved — implement the plan now. You may edit files.')) {
      lock('✓ Approved — implementing');
    }
  });

  keep.addEventListener('click', () => {
    // First click reveals the note box; the second sends it.
    if (note.hidden) {
      note.hidden = false;
      keep.textContent = 'Send notes';
      note.focus();
      return;
    }
    const txt = note.value.trim();
    if (sendPlanResponse('Keep planning.' + (txt ? ' ' + txt : ''))) {
      lock('✓ Sent to planner');
    }
  });

  footer.appendChild(approve);
  footer.appendChild(keep);
  card.appendChild(footer);
  return card;
}

function resultEl(ev) {
  const el = document.createElement('div');
  el.className = 'msg result' + (ev.is_error ? ' err' : '');
  const cost = (costVisible && typeof ev.cost === 'number') ? ` · $${ev.cost.toFixed(4)}` : '';
  el.textContent = (ev.is_error ? '⚠ ended with error' : 'done') + cost;
  return el;
}

function simpleMsg(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  return el;
}

/* --- rendering / streaming --- */

function renderChatEvent(ev, scroll) {
  const log = $('chat-log');
  let el = null;
  if (ev.role === 'user') el = bubble('user', ev.text);
  else if (ev.role === 'assistant') {
    el = bubble('assistant', ev.text);
    if (ttsOn) speak(ev.text);
  } else if (ev.role === 'thinking') el = collapsible('thinking', 'Thinking', ev.text, true);
  else if (ev.role === 'tool_use') el = toolUseEl(ev);
  else if (ev.role === 'ask') { retireOpenAsks(); el = askCard(ev); }
  else if (ev.role === 'ask_answered') { lockAskCard(ev.id, ev.answers); return; }
  else if (ev.role === 'plan') el = planCard(ev);
  else if (ev.role === 'tool_result') el = collapsible('tool-result', 'Tool result', ev.text, false);
  else if (ev.role === 'result') {
    el = resultEl(ev);
    if (typeof ev.cost === 'number') { chatTotalCost += ev.cost; updateCost(); }
  } else if (ev.role === 'error') el = simpleMsg('error', ev.text);
  if (el) log.appendChild(el);
  if (ev.role === 'ask') focusAskCard(el);
  // Reconcile the composer lock on every event (not just 'ask'): the agent stays
  // busy for a whole turn without sending a 'status', so a lock set by an earlier
  // ask must be cleared by the next event once no question is open — otherwise the
  // composer stays stuck disabled until the turn ends. (A genuinely pending ask
  // blocks the agent, so no other events arrive to unlock it prematurely.)
  updateComposerLock();
  if (ev.role === 'user') maybeClamp(el);  // collapse long pasted input
  updateWorkingIndicator();   // keep the processing cursor below the newest event
  if (scroll) maybeScroll();
}

function appendDelta(text) {
  if (!streamingEl) {
    streamingEl = document.createElement('div');
    streamingEl.className = 'msg assistant streaming';
    streamingEl._raw = '';
    const md = document.createElement('div'); md.className = 'md';
    streamingEl.appendChild(md);
    const cur = document.createElement('span'); cur.className = 'cursor'; cur.textContent = '▋';
    streamingEl.appendChild(cur);
    $('chat-log').appendChild(streamingEl);
  }
  streamingEl._raw += text;
  streamingEl.querySelector('.md').innerHTML = renderMarkdown(streamingEl._raw);
  updateWorkingIndicator();   // streaming text takes over → hide the cursor bubble
  maybeScroll();
}

function clearStreaming() {
  if (streamingEl) { streamingEl.remove(); streamingEl = null; }
  updateWorkingIndicator();   // back to "processing" between text and tools
}

// A blinking-cursor bubble shown while the agent is processing (thinking or
// running tools) but not yet streaming text — so an idle-looking chat is clearly
// distinguished from "your turn to answer". Hidden while streaming, when idle,
// and when an ask card is waiting on the user.
function updateWorkingIndicator() {
  const log = $('chat-log');
  const show = chatBusy && !streamingEl && !pendingAskOpen();
  let el = $('chat-working');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'chat-working';
      el.className = 'msg assistant working';
      el.innerHTML = '<span class="cursor">▋</span>';
    }
    log.appendChild(el);   // keep it at the bottom (appendChild moves it)
    maybeScroll();
  } else if (el) {
    el.remove();
  }
}

/* --- scroll --- */

function nearBottom() {
  const log = $('chat-log');
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}
function scrollChatBottom() {
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
  $('chat-jump').hidden = true;
}
function maybeScroll() {
  if (nearBottom()) scrollChatBottom();
  else $('chat-jump').hidden = false;
}

/* --- status / cost / connection --- */

function setChatBusy(busy) {
  chatBusy = !!busy;
  $('chat-stop').hidden = !busy;
  $('chat').classList.toggle('busy', !!busy);
  updateComposerLock();
  updateWorkingIndicator();
}

// True while the agent is blocked on an unanswered ask card (so we must not let
// the user send an unrelated message — it would queue behind the blocked tool
// call and deadlock the session, exactly the bug this guards against).
function pendingAskOpen() {
  // Only the most recent ask card can be genuinely open: the agent blocks while
  // waiting for an answer, so nothing renders after a live ask. An earlier
  // unanswered card followed by newer content is stale (e.g. an API error/resume
  // restarted the server's ask counter, orphaning the old card) and must not keep
  // the composer locked.
  const asks = $('chat-log').querySelectorAll('.msg.ask');
  const last = asks[asks.length - 1];
  return !!last && !last.classList.contains('answered');
}

// Lock the composer while a question is pending, mirroring the terminal where an
// open prompt captures input. Unlocks the moment it's answered or interrupted.
function updateComposerLock() {
  const ta = $('chat-input');
  if (_chatPlaceholder === null) _chatPlaceholder = ta.getAttribute('placeholder') || '';
  const locked = chatBusy && pendingAskOpen();
  ta.disabled = locked;
  for (const id of ['chat-send', 'chat-attach', 'chat-mic']) $(id).disabled = locked;
  ta.placeholder = locked ? 'Answer the question above to continue…' : _chatPlaceholder;
  $('chat').classList.toggle('awaiting-answer', locked);
}

// Focus a freshly rendered, still-open ask card so keyboard nav works at once.
function focusAskCard(card) {
  if (card && !card.classList.contains('answered')) card.focus({ preventScroll: false });
}

// The agent stopped waiting (answered elsewhere, interrupted, or errored) while
// a card is still open — retire any unanswered cards so the composer can't stay
// stuck disabled and a stale card can't be "submitted" into the void.
function retireOpenAsks() {
  $('chat-log').querySelectorAll('.msg.ask:not(.answered)').forEach((card) => {
    card.classList.add('answered', 'stale');
    card.querySelectorAll('.ask-opt, .ask-other, .ask-submit').forEach((e) => { e.disabled = true; });
    const footer = card.querySelector('.ask-footer');
    if (footer) {
      footer.textContent = '';
      const s = document.createElement('span');
      s.className = 'ask-done stale';
      s.textContent = '⌀ No longer waiting for an answer';
      footer.appendChild(s);
    }
  });
}
function updateCost() { $('chat-cost').textContent = '$' + chatTotalCost.toFixed(3); }
function applyCostVisibility() { $('chat-cost').style.display = costVisible ? '' : 'none'; }
function setConn(state) {
  const dot = $('chat-conn');
  dot.classList.remove('open', 'connecting', 'closed');
  dot.classList.add(state);
}

/* --- websocket --- */

function handleChatMsg(m) {
  if (m.type === 'history') {
    $('chat-log').textContent = '';
    streamingEl = null;
    chatTotalCost = 0;
    for (const ev of m.events) renderChatEvent(ev, false);
    // Seed ↑/↓ recall with this conversation's past user messages.
    chatHistory = m.events
      .filter((ev) => ev.role === 'user')
      .map((ev) => (ev.text || '').trim())
      .filter(Boolean);
    histIndex = null; histDraft = '';
    updateCost();
    scrollChatBottom();
  } else if (m.type === 'delta') {
    appendDelta(m.text);
  } else if (m.type === 'event') {
    clearStreaming();
    renderChatEvent(m.event, true);
  } else if (m.type === 'status') {
    // Agent idle while a card is still open ⇒ it was interrupted/abandoned;
    // retire the card so the composer can't stay stuck disabled.
    if (!m.busy && pendingAskOpen()) retireOpenAsks();
    setChatBusy(m.busy);
    if (m.model && m.model !== chatModel) { chatModel = m.model; $('chat-model').value = m.model; }
  }
}

function connectChat(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ui/ws?session=${encodeURIComponent(name)}`);
  chatWs = ws;
  setConn('connecting');
  ws.onopen = () => { chatReconnectDelay = 1000; setConn('open'); };
  ws.onmessage = (e) => {
    if (chatWs !== ws || activeKind !== 'ui') return;
    try { handleChatMsg(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  ws.onclose = () => {
    if (chatWs !== ws) return;
    setConn('closed');
    if (!ws._intentional && activeKind === 'ui' && chatSession === name) {
      chatReconnectTimer = setTimeout(() => connectChat(name), chatReconnectDelay);
      chatReconnectDelay = Math.min(chatReconnectDelay * 2, 15000);
    }
  };
}

function openChat(name) {
  if (active === name && activeKind === 'ui') return;
  $('term').src = 'about:blank';
  closeChat();
  active = name; activeKind = 'ui'; chatSession = name;
  showView('ui');
  showPasteHint(false);
  const s = sessions.find((x) => x.name === name && x.kind === 'ui');
  // Show the session's folder location in the header; fall back to the name
  // for sessions created from the CLI that have no recorded cwd.
  $('chat-title').textContent = (s && s.cwd) || name;
  $('chat-title').title = name;
  $('chat-log').textContent = '';
  chatHistory = []; histIndex = null; histDraft = '';  // per-session; history reseeds it
  chatTotalCost = 0; updateCost(); applyCostVisibility();
  clearAttachments();
  setChatBusy(false);
  chatModel = (s && s.model) || 'opus';
  $('chat-model').value = chatModel;
  applyBackendUI();
  connectChat(name);
  render();
}

function closeChat() {
  if (chatReconnectTimer) { clearTimeout(chatReconnectTimer); chatReconnectTimer = null; }
  if (chatWs) { chatWs._intentional = true; try { chatWs.close(); } catch { /* ignore */ } chatWs = null; }
  streamingEl = null;
}

/* --- send / stop / model --- */

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

/* --- collapsed long-text pastes (terminal-style [Pasted text #N +L lines]) --- */

const PASTE_LINE_MIN = 6;     // collapse a paste with at least this many lines…
const PASTE_CHAR_MIN = 800;   // …or this many characters
let chatPastes = [];          // { id, text }
let pasteSeq = 0;
const PASTE_RE = /\[Pasted text #(\d+) \+\d+ (?:lines|chars)\]/g;

function pasteLabel(id, text) {
  const lines = text.split('\n').length;
  const unit = lines > 1 ? `+${lines} lines` : `+${text.length} chars`;
  return `[Pasted text #${id} ${unit}]`;
}

// Replace each surviving marker with its stored text; a marker the user deleted
// simply drops its paste. Run at send time.
function expandPastes(text) {
  return text.replace(PASTE_RE, (m, n) => {
    const p = chatPastes.find((x) => String(x.id) === n);
    return p ? p.text : m;
  });
}

function clearPastes() { chatPastes = []; pasteSeq = 0; renderPastes(); }

function insertAtCursor(ta, str) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + str + ta.value.slice(e);
  const pos = s + str.length;
  ta.setSelectionRange(pos, pos);
  autoGrow(ta);
}

// A removable chip per pending paste (mirrors the image-attachment chips). The
// inline [Pasted text #N …] marker is the source of truth for position; the chip
// is just an easy remove affordance and a preview of the line/char count.
function renderPastes() {
  const box = $('chat-pastes');
  if (!box) return;
  box.textContent = '';
  box.hidden = !chatPastes.length;
  chatPastes.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'paste-chip';
    const lines = p.text.split('\n').length;
    const label = document.createElement('span');
    label.className = 'paste-chip-label';
    label.textContent = `#${p.id} · ${lines > 1 ? lines + ' lines' : p.text.length + ' chars'}`;
    label.title = p.text.slice(0, 4000);
    chip.appendChild(label);
    const rm = document.createElement('button');
    rm.className = 'paste-rm'; rm.textContent = '×'; rm.title = 'Remove paste';
    rm.addEventListener('click', () => removePaste(p.id));
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

// Remove a paste by id: drop it and strip its marker from the composer.
function removePaste(id) {
  chatPastes = chatPastes.filter((p) => p.id !== id);
  const ta = $('chat-input');
  ta.value = ta.value.replace(
    new RegExp(`\\[Pasted text #${id} \\+\\d+ (?:lines|chars)\\]`, 'g'), '');
  autoGrow(ta);
  renderPastes();
}

// Keep chips in sync when the user manually edits/deletes a marker in the textarea.
function reconcilePastes() {
  if (!chatPastes.length) return;
  const present = new Set();
  let m;
  PASTE_RE.lastIndex = 0;
  while ((m = PASTE_RE.exec($('chat-input').value)) !== null) present.add(m[1]);
  const before = chatPastes.length;
  chatPastes = chatPastes.filter((p) => present.has(String(p.id)));
  if (chatPastes.length !== before) renderPastes();
}

/* --- composer input history (↑/↓ recall, shell-style) --- */

// History recall only kicks in at the text edges, so ↑/↓ still move the caret
// between lines of a multi-line draft. Collapsed selection only.
function caretOnFirstLine(ta) {
  return ta.selectionStart === ta.selectionEnd
    && ta.value.lastIndexOf('\n', ta.selectionStart - 1) === -1;
}
function caretOnLastLine(ta) {
  return ta.selectionStart === ta.selectionEnd
    && ta.value.indexOf('\n', ta.selectionEnd) === -1;
}

function setComposer(ta, val) {
  ta.value = val;
  autoGrow(ta);
  const end = ta.value.length;
  ta.setSelectionRange(end, end);   // caret at end, like a shell recall
  hideMentions();
}

// dir: -1 = older (↑), +1 = newer (↓). Returns true if it consumed the key.
function chatHistoryNav(dir, ta) {
  if (!chatHistory.length) return false;
  if (dir < 0) {
    if (histIndex === null) { histDraft = ta.value; histIndex = chatHistory.length - 1; }
    else if (histIndex > 0) { histIndex--; }
    else { return true; }                 // already at the oldest — just hold
  } else {
    if (histIndex === null) return false; // not navigating — let the caret move
    if (histIndex < chatHistory.length - 1) { histIndex++; }
    else { histIndex = null; setComposer(ta, histDraft); return true; }  // back to draft
  }
  setComposer(ta, chatHistory[histIndex]);
  return true;
}

function pushChatHistory(text) {
  text = (text || '').trim();
  if (!text) return;
  if (chatHistory[chatHistory.length - 1] !== text) chatHistory.push(text); // skip dup of last
  if (chatHistory.length > 200) chatHistory.shift();
  histIndex = null; histDraft = '';
}

function chatSend() {
  const ta = $('chat-input');
  // A pending question owns the input; answer it (or Esc) before chatting.
  if (chatBusy && pendingAskOpen()) { flash('Answer the question above first'); return; }
  let text = expandPastes(ta.value).trim();
  if (!text && !chatAttachments.length) return;
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) { flash('Reconnecting — try again'); return; }
  pushChatHistory(text);   // remember the message for ↑/↓ recall (before image refs)
  if (chatAttachments.length) {
    const refs = chatAttachments.map((a) => a.path).join('\n');
    text = (text ? text + '\n\n' : '') + 'Attached image(s):\n' + refs;
  }
  chatWs.send(JSON.stringify({ type: 'send', text }));
  ta.value = ''; autoGrow(ta); hideMentions(); clearAttachments(); clearPastes();
  scrollChatBottom();
}

/* --- image attachments (paste / drop / attach) --- */

let chatAttachments = [];  // { path, url }

function clearAttachments() {
  for (const a of chatAttachments) { try { URL.revokeObjectURL(a.url); } catch { /* */ } }
  chatAttachments = [];
  renderAttachments();
}

function renderAttachments() {
  const box = $('chat-attachments');
  box.textContent = '';
  box.hidden = !chatAttachments.length;
  chatAttachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const img = document.createElement('img');
    img.src = a.url;
    chip.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'attach-rm'; rm.textContent = '×'; rm.title = 'Remove';
    rm.addEventListener('click', () => removeAttachment(i));
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

function removeAttachment(i) {
  const a = chatAttachments[i];
  if (a) { try { URL.revokeObjectURL(a.url); } catch { /* */ } }
  chatAttachments.splice(i, 1);
  renderAttachments();
}

async function addAttachment(blob) {
  if (!chatSession || !blob || !/^image\//.test(blob.type)) return;
  const url = URL.createObjectURL(blob);
  try {
    const fd = new FormData();
    fd.append('file', blob, blob.name || 'paste.png');
    const r = await fetch(`/api/ui/paste?session=${encodeURIComponent(chatSession)}`,
      { method: 'POST', body: fd });
    if (!r.ok) {
      let d = `${r.status}`;
      try { d = (await r.json()).detail || d; } catch { /* */ }
      throw new Error(d);
    }
    const { path } = await r.json();
    chatAttachments.push({ path, url });
    renderAttachments();
  } catch (e) {
    try { URL.revokeObjectURL(url); } catch { /* */ }
    flash('Image upload failed: ' + e.message);
  }
}

function chatStop() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'interrupt' }));
  }
}

/* --- @-mention file autocomplete --- */

let mentionItems = [], mentionIndex = 0, mentionStart = -1;
const mentionActive = () => !$('chat-mentions').hidden;

async function onChatInput() {
  autoGrow($('chat-input'));
  histIndex = null;   // editing the live draft again — next ↑ starts from newest
  reconcilePastes();  // a manually-deleted marker drops its chip
  const ta = $('chat-input');
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/@([^\s@]*)$/);
  if (!m || !chatSession) { hideMentions(); return; }
  mentionStart = ta.selectionStart - m[0].length;
  try {
    const { files } = await api.uiFiles(chatSession, m[1]);
    mentionItems = files.slice(0, 8);
    if (!mentionItems.length) { hideMentions(); return; }
    mentionIndex = 0;
    showMentions();
  } catch { hideMentions(); }
}

function showMentions() {
  const box = $('chat-mentions');
  box.textContent = '';
  mentionItems.forEach((f, idx) => {
    const row = document.createElement('div');
    row.className = 'mention' + (idx === mentionIndex ? ' sel' : '');
    row.textContent = f;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(f); });
    box.appendChild(row);
  });
  box.hidden = false;
}
function renderMentionSel() {
  [...$('chat-mentions').children].forEach((r, idx) => r.classList.toggle('sel', idx === mentionIndex));
}
function hideMentions() { $('chat-mentions').hidden = true; }
function pickMention(file) {
  const ta = $('chat-input');
  const pos = ta.selectionStart;
  // A directory (suffixed '/') keeps the picker open so you can drill into it;
  // a file is inserted with a trailing space and the picker closes.
  const isDir = file.endsWith('/');
  const insert = '@' + file + (isDir ? '' : ' ');
  ta.value = ta.value.slice(0, mentionStart) + insert + ta.value.slice(pos);
  const np = mentionStart + insert.length;
  ta.setSelectionRange(np, np);
  autoGrow(ta); ta.focus();
  if (isDir) onChatInput();   // re-query and list that folder's contents
  else hideMentions();
}

/* --- voice in / out --- */

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('chat-mic').style.display = 'none'; return; }
  recog = new SR();
  recog.lang = 'en-US';
  recog.continuous = true;        // keep listening through pauses
  recog.interimResults = true;    // show words live as they're recognised
  recog.onresult = (e) => {
    // Split the new results into finalised vs still-interim. Finalised text is
    // committed to micBase (the stable transcript so far); interim is shown
    // after it as a live preview and replaced as the engine refines it.
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const tr = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += tr; else interim += tr;
    }
    if (final) micBase = (micBase + ' ' + final).trim();
    const ta = $('chat-input');
    ta.value = (micBase + (interim ? ' ' + interim : '')).trim();
    autoGrow(ta);
  };
  recog.onerror = (e) => {
    if (e && e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
      micOn = false; $('chat-mic').classList.remove('on');
    }
  };
  recog.onend = () => {
    // restart through the browser's silence-timeout until the user taps it off
    if (micOn) { try { recog.start(); } catch { /* already restarting */ } }
    else $('chat-mic').classList.remove('on');
  };
}
function speak(text) {
  try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* ignore */ }
}

/* --- listeners --- */

$('chat-send').addEventListener('click', chatSend);
$('chat-stop').addEventListener('click', chatStop);
$('chat-jump').addEventListener('click', scrollChatBottom);
$('chat-log').addEventListener('scroll', () => { if (nearBottom()) $('chat-jump').hidden = true; });
$('chat-log').addEventListener('click', (e) => {
  if (e.target.classList.contains('copy-code')) {
    const code = e.target.parentElement.querySelector('code');
    if (code) copyText(code.textContent);
  }
});
$('chat-model').addEventListener('change', () => {
  chatModel = $('chat-model').value;
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'set_model', model: chatModel }));
  }
});
$('chat-tts').addEventListener('click', () => {
  ttsOn = !ttsOn;
  $('chat-tts').classList.toggle('on', ttsOn);
  if (!ttsOn) try { speechSynthesis.cancel(); } catch { /* ignore */ }
});
$('chat-mic').addEventListener('click', () => {
  if (!recog) return;
  if (micOn) { micOn = false; recog.stop(); $('chat-mic').classList.remove('on'); }
  else {
    micOn = true; micBase = $('chat-input').value.trim(); // dictate after existing text
    $('chat-mic').classList.add('on');
    try { recog.start(); } catch { /* ignore */ }
  }
});
$('chat-input').addEventListener('input', onChatInput);
$('chat-input').addEventListener('keydown', (e) => {
  if (mentionActive()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionItems.length; renderMentionSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length; renderMentionSel(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionItems[mentionIndex]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideMentions(); return; }
  }
  const ta = e.currentTarget;
  // ↑/↓ recall previous submissions — only at the text edges, so they still move
  // the caret within a multi-line draft.
  if (e.key === 'ArrowUp' && caretOnFirstLine(ta)) {
    if (chatHistoryNav(-1, ta)) { e.preventDefault(); return; }
  } else if (e.key === 'ArrowDown' && caretOnLastLine(ta)) {
    if (chatHistoryNav(1, ta)) { e.preventDefault(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  else if (e.key === 'Escape') { e.preventDefault(); chatStop(); }
});
$('chat-attach').addEventListener('click', () => $('chat-file').click());
$('chat-file').addEventListener('change', (e) => {
  for (const f of e.target.files) addAttachment(f);
  e.target.value = '';
});
$('chat-input').addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  const items = (dt && dt.items) || [];
  let had = false;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) { had = true; addAttachment(blob); }
    }
  }
  if (had) { e.preventDefault(); return; }  // image paste: don't dump binary
  // Long text → collapse into an inline [Pasted text #N +L lines] marker (like the
  // terminal UI) instead of flooding the composer; expanded back to the real text
  // on send. Select + delete the marker to drop the paste.
  const text = dt ? dt.getData('text') : '';
  if (!text) return;
  if (text.split('\n').length >= PASTE_LINE_MIN || text.length >= PASTE_CHAR_MIN) {
    e.preventDefault();
    const id = ++pasteSeq;
    chatPastes.push({ id, text });
    insertAtCursor($('chat-input'), pasteLabel(id, text));
    renderPastes();
  }
});
(() => {
  const chat = $('chat');
  chat.addEventListener('dragover', (e) => { e.preventDefault(); chat.classList.add('dragging'); });
  chat.addEventListener('dragleave', (e) => { if (e.target === chat) chat.classList.remove('dragging'); });
  chat.addEventListener('drop', (e) => {
    e.preventDefault(); chat.classList.remove('dragging');
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    for (const f of files) addAttachment(f);
  });
})();
setupRecognition();

/* ---------- Claude connection ---------- */

let clMode = 'oauth';   // 'oauth' | 'apikey'
let clStep = 'start';   // oauth sub-step: 'start' | 'code'

const clShow = (id, on) => { $(id).hidden = !on; };

function setClaudeChip(st) {
  const chip = $('claude-status');
  const txt = $('claude-status-text');
  if (!st) { txt.textContent = 'Claude…'; return; }
  chip.classList.toggle('connected', !!st.connected);
  chip.classList.toggle('disconnected', !st.connected);
  txt.textContent = st.connected ? 'Claude connected' : 'Claude — sign in';
}

async function refreshClaude() {
  try {
    const st = await api.claudeStatus();
    setClaudeChip(st);
    costVisible = !!(st && st.method === 'api_key');
    cloudBackend = !!(st && (st.method === 'bedrock' || st.method === 'vertex'));
    applyCostVisibility();
    applyBackendUI();
    return st;
  } catch { return null; }
}

function clRenderState(st) {
  $('cl-status').textContent = st ? st.detail : '';
  $('cl-error').textContent = '';
  $('cl-code').value = ''; $('cl-key').value = ''; $('cl-url').value = '';
  const cloud = st && (st.method === 'bedrock' || st.method === 'vertex');
  // Cloud backends authenticate via the provider, not the in-app sign-in.
  clShow('cl-connect', !cloud);
  const managed = st && (st.method === 'oauth_token' || st.method === 'api_key');
  clShow('cl-disconnect', !!managed && !cloud);
}

function selectClChoice(mode) {
  clMode = mode; clStep = 'start';
  $('cl-signin').classList.toggle('selected', mode === 'oauth');
  $('cl-use-key').classList.toggle('selected', mode === 'apikey');
  clShow('cl-oauth', false);
  clShow('cl-apikey', mode === 'apikey');
  clShow('cl-submit', true);
  $('cl-submit').disabled = false;
  $('cl-submit').textContent = mode === 'apikey' ? 'Save key' : 'Start sign-in';
  $('cl-error').textContent = '';
}

async function openClaudeDialog() {
  const st = await refreshClaude();
  clRenderState(st);
  if (cloudBackend) clShow('cl-submit', false);
  else selectClChoice('oauth');
  $('claude-dlg').showModal();
}

function finishClaude(st) {
  setClaudeChip(st);
  clRenderState(st);
  $('cl-submit').disabled = false;
  if (st && st.connected) { $('claude-dlg').close(); flash('Claude connected'); }
}

async function clSubmit() {
  const btn = $('cl-submit');
  $('cl-error').textContent = '';
  try {
    if (clMode === 'apikey') {
      btn.disabled = true;
      finishClaude(await api.claudeApiKey($('cl-key').value.trim()));
      return;
    }
    if (clStep === 'start') {
      btn.disabled = true; btn.textContent = 'Starting…';
      const { url } = await api.claudeStart();
      $('cl-url').value = url;
      clShow('cl-oauth', true);
      clStep = 'code';
      btn.textContent = 'Connect'; btn.disabled = false;
      $('cl-code').focus();
    } else {
      const code = $('cl-code').value.trim();
      if (!code) { $('cl-error').textContent = 'Paste the code first.'; return; }
      btn.disabled = true; btn.textContent = 'Connecting…';
      finishClaude(await api.claudeCode(code));
    }
  } catch (e) {
    $('cl-error').textContent = e.message;
    btn.disabled = false;
    btn.textContent = clMode === 'apikey' ? 'Save key'
      : (clStep === 'code' ? 'Connect' : 'Start sign-in');
  }
}

async function closeClaudeDialog() {
  if (clMode === 'oauth' && clStep === 'code') { try { await api.claudeCancel(); } catch { /* ignore */ } }
  $('claude-dlg').close();
}

async function clDisconnect() {
  try {
    const st = await api.claudeDisconnect();
    setClaudeChip(st); clRenderState(st); selectClChoice('oauth');
  } catch (e) { $('cl-error').textContent = e.message; }
}

$('claude-status').addEventListener('click', openClaudeDialog);
$('cl-signin').addEventListener('click', () => selectClChoice('oauth'));
$('cl-use-key').addEventListener('click', () => selectClChoice('apikey'));
$('cl-submit').addEventListener('click', clSubmit);
$('cl-cancel').addEventListener('click', closeClaudeDialog);
$('cl-disconnect').addEventListener('click', clDisconnect);
$('cl-url-open').addEventListener('click', () => {
  const u = $('cl-url').value; if (u) window.open(u, '_blank', 'noopener');
});
$('cl-url-copy').addEventListener('click', () => {
  const u = $('cl-url').value; if (u) copyText(u);
});
for (const id of ['cl-code', 'cl-key']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clSubmit(); }
  });
}

/* ---------- init ---------- */

function setSidebar(collapsed) {
  document.body.classList.toggle('collapsed', collapsed);
  localStorage.setItem('agentpeek-sidebar', collapsed ? 'collapsed' : 'open');
}
// On touch screens the sidebar and the attached session share one narrow
// column, so activating a session collapses the sidebar to hand it the full
// width (the » button brings it back). No-op on desktop / wide pointers.
function collapseSidebarOnMobile() {
  if (window.matchMedia('(pointer: coarse)').matches) setSidebar(true);
}
$('collapse-btn').addEventListener('click', () => setSidebar(true));
$('expand-btn').addEventListener('click', () => setSidebar(false));
// On load no session is attached yet. On touch screens the sidebar only
// collapses to make room for an open session, so with nothing attached we must
// start expanded — otherwise there's no way to pick one. Desktop keeps the
// remembered collapsed state (there it's a deliberate space-saving choice).
if (localStorage.getItem('agentpeek-sidebar') === 'collapsed'
    && !window.matchMedia('(pointer: coarse)').matches) {
  setSidebar(true);
}

$('theme-toggle').addEventListener('click', () => {
  const light = document.documentElement.classList.toggle('light');
  localStorage.setItem('agentpeek-theme', light ? 'light' : 'dark');
});

$('create-btn').addEventListener('click', () => openCreateDialog());
$('add-folder-btn').addEventListener('click', () => addFolder(null));

$('folder-view-btn').classList.toggle('active', groupByFolder);
$('folder-view-btn').addEventListener('click', () => {
  groupByFolder = !groupByFolder;
  localStorage.setItem('agentpeek-groupby', groupByFolder ? 'folder' : 'group');
  $('folder-view-btn').classList.toggle('active', groupByFolder);
  render();
});
$('c-ok').addEventListener('click', submitCreate);
$('c-cancel').addEventListener('click', () => $('cdlg').close());
$('c-newdir').addEventListener('click', newDir);
$('term-hint-x').addEventListener('click', () => {
  localStorage.setItem(PASTE_HINT_KEY, '1');
  $('term-hint').hidden = true;
});
$('c-name').addEventListener('input', () => clearFieldError($('c-name')));
$('c-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitCreate(); }
});
document.querySelectorAll('input[name="c-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    cstate.mode = r.value;
    updateNotifyVisibility();
  });
});
$('c-type').querySelectorAll('.chip').forEach((b) => {
  b.addEventListener('click', () => {
    $('c-type').querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
    b.classList.add('selected');
    cstate.type = b.dataset.type;
    $('c-start-field').hidden = cstate.type === 'ui';
    updateNotifyVisibility();
  });
});
$('c-notify').addEventListener('change', () => {
  updateNotifyVisibility();
  if ($('c-notify').checked && $('c-notify-topic').value === ADD_NEW) {
    $('c-notify-new').focus();
  }
});
$('c-notify-topic').addEventListener('change', () => {
  updateNotifyVisibility();
  if ($('c-notify-topic').value === ADD_NEW) $('c-notify-new').focus();
});
$('c-notify-new').addEventListener('input', () => clearFieldError($('c-notify-new')));
$('dlg-cancel').addEventListener('click', () => $('dlg').close('cancel'));

/* ---------- mobile key bar ---------- */
// Buttons send keys straight to tmux (api.keys/scroll/paste), which is reliable
// on iOS Safari where the soft keyboard's modifier keys are not. Only active for
// shell (terminal) sessions — UI chat sessions have their own input. The Ctrl
// button is a sticky modifier: the next character typed into the hidden capture
// input is sent as Ctrl+<char>, then it disarms.

let ctrlArmed = false;

function setCtrlArmed(on) {
  ctrlArmed = on;
  $('kb-ctrl').classList.toggle('armed', on);
  if (on) { $('kb-capture').value = ''; $('kb-capture').focus(); }
}

function shellActive() { return active && activeKind === 'shell'; }

async function sendKeys(keys) {
  if (!shellActive()) return;
  try { await api.keys(active, keys); } catch (e) { flash(e.message); }
}

// Paste the clipboard into the session. The Clipboard API needs a secure
// context (https/localhost); when unavailable we fall back to a prompt the
// user can long-press → Paste into.
async function pasteIntoSession() {
  if (!shellActive()) return;
  let text = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }
  } catch { /* blocked or denied — fall through to manual prompt */ }
  if (!text) {
    text = await ask({ title: 'Paste', msg: 'Paste your text here, then OK.',
      input: '', okLabel: 'Paste' });
    if (text === null) return; // cancelled
  }
  if (!text) return;
  try { await api.paste(active, text); } catch (e) { flash(e.message); }
}

function setupKeybar() {
  const bar = $('keybar');
  bar.querySelectorAll('button[data-key]').forEach((b) => {
    b.addEventListener('click', () => sendKeys([b.dataset.key]));
  });
  bar.querySelectorAll('button[data-scroll]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!shellActive()) return;
      try { await api.scroll(active, b.dataset.scroll); } catch (e) { flash(e.message); }
    });
  });
  $('kb-ctrl').addEventListener('click', () => setCtrlArmed(!ctrlArmed));
  $('kb-paste').addEventListener('click', pasteIntoSession);

  const cap = $('kb-capture');
  cap.addEventListener('input', () => {
    const ch = cap.value.slice(-1).toLowerCase();
    cap.value = '';
    if (ch && /[a-z0-9]/.test(ch)) sendKeys([`C-${ch}`]);
    setCtrlArmed(false);
  });
  cap.addEventListener('blur', () => setCtrlArmed(false));
}
setupKeybar();

/* ---------- talk button (voice → terminal) ---------- */
// Mobile-only: the keybar (and so this button) is only shown on touch screens.
// Records a phrase with the Web Speech API and types the transcript verbatim
// into the shell session via api.paste (send-keys -l), so it lands in Claude's
// input box. We don't auto-press Enter — the user reviews the text and taps the
// "enter" key to send, since recognition isn't always perfect.

let talkRecog = null;
let talkOn = false;   // user intends to keep recording (survives silence stops)

function setupTalk() {
  const btn = $('kb-talk');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // No speech support (or insecure context) → hide the button rather than
  // offer something that silently fails.
  if (!SR) { btn.style.display = 'none'; return; }
  talkRecog = new SR();
  talkRecog.lang = 'en-US';
  talkRecog.continuous = true;       // keep listening through pauses
  talkRecog.interimResults = false;
  talkRecog.onresult = async (e) => {
    // continuous mode appends to e.results — paste only the newly finalized
    // segments (from resultIndex) so we don't re-send earlier phrases.
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) text += e.results[i][0].transcript;
    }
    text = text.trim();
    if (!text || !shellActive()) return;
    try { await api.paste(active, text + ' '); } catch (err) { flash(err.message); }
  };
  talkRecog.onerror = (e) => {
    // A real error (e.g. permission denied) stops for good; 'no-speech' during a
    // pause is normal — let onend restart it.
    if (e && e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
      talkOn = false; btn.classList.remove('on');
      flash(`Voice input: ${e.error}`);
    }
  };
  talkRecog.onend = () => {
    // Browsers end the session on silence even with continuous=true; restart
    // until the user taps the button off, so a small pause won't stop dictation.
    if (talkOn) { try { talkRecog.start(); } catch { /* already restarting */ } }
    else btn.classList.remove('on');
  };

  btn.addEventListener('click', () => {
    if (!shellActive()) return;
    if (talkOn) { talkOn = false; talkRecog.stop(); btn.classList.remove('on'); return; }
    talkOn = true; btn.classList.add('on');
    try { talkRecog.start(); }
    catch { /* start() throws if already running — ignore */ }
  });
}
setupTalk();

setInterval(refresh, 3000);
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

(async () => {
  await loadConfig();
  try { hostInfo = await api.host(); } catch { /* keep placeholders */ }
  refresh();
  refreshClaude();
})();
