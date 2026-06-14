'use strict';

const $ = (id) => document.getElementById(id);
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const NAME_HINT = "Letters, digits, '-' and '_' only.";
const DEFAULT_FOLDER = 'General';

let sessions = [];
let active = null;
let config = { folders: [DEFAULT_FOLDER], root: 'projects' };
let hostInfo = { user: '<user>', host: '<tailscale-hostname>' };

function sshAttachCommand(name) {
  return `ssh -t ${hostInfo.user}@${hostInfo.host} tmux attach -t ${name}`;
}

// remembered UI state (folder open/closed and sidebar collapse only)
const groupState = JSON.parse(localStorage.getItem('agentpeek-groups') || '{}');

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
  kill: (name) => req('DELETE', `/api/sessions/${encodeURIComponent(name)}`),
  host: () => req('GET', '/api/host'),
  config: () => req('GET', '/api/config'),
  dirs: (path) => req('GET', `/api/dirs?path=${encodeURIComponent(path)}`),
  createFolder: (path) => req('POST', '/api/folders', { path }),
  deleteFolder: (path) => req('DELETE', `/api/folders/${encodeURIComponent(path)}`),
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
      title: parent ? `New subfolder in "${parent}"` : 'New folder',
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
    title: 'Delete folder',
    msg: `Delete folder "${path}"?`,
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

const cstate = { group: null, mode: 'ai', cwd: null };

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

  twisty.addEventListener('click', async () => {
    if (!loaded) {
      loaded = true;
      try {
        const { dirs } = await api.dirs(rel);
        if (!dirs.length) {
          twisty.classList.add('leaf');
          twisty.textContent = '·';
          return;
        }
        for (const d of dirs) {
          children.appendChild(dirNode(d, rel ? `${rel}/${d}` : d).node);
        }
      } catch {
        loaded = false;
        return;
      }
    }
    if (twisty.classList.contains('leaf')) return;
    children.hidden = !children.hidden;
    twisty.classList.toggle('open', !children.hidden);
  });

  row.appendChild(twisty);
  row.appendChild(name);
  node.appendChild(row);
  node.appendChild(children);
  return { node, twisty, name };
}

function openCreateDialog() {
  $('c-name').value = '';
  $('c-error').textContent = '';
  for (const id of ['c-name', 'c-folders', 'c-dirtree']) {
    $(id).classList.remove('invalid');
  }
  cstate.group = null; // mandatory — the user must pick a folder every time
  cstate.mode = 'ai';
  cstate.cwd = null;   // mandatory — a real directory, not the projects root

  renderFolderPicker();
  $('c-mode').querySelectorAll('.chip').forEach((b) => {
    b.classList.toggle('selected', b.dataset.mode === cstate.mode);
  });

  // fresh tree rooted at projects/, expanded one level, nothing preselected
  const tree = $('c-dirtree');
  tree.textContent = '';
  const root = dirNode(config.root, '', false);
  tree.appendChild(root.node);
  $('c-path').textContent = 'choose a directory…';
  root.twisty.click();

  $('cdlg').showModal();
  $('c-name').focus();
}

async function submitCreate() {
  const name = $('c-name').value.trim();
  if (!NAME_RE.test(name)) {
    $('c-error').textContent = NAME_HINT;
    $('c-name').classList.add('invalid');
    return;
  }
  if (!cstate.group) {
    $('c-error').textContent = 'Please choose a folder.';
    $('c-folders').classList.add('invalid');
    return;
  }
  if (!cstate.cwd) {
    $('c-error').textContent = 'Please choose a working directory.';
    $('c-dirtree').classList.add('invalid');
    return;
  }
  try {
    await api.create({ name, group: cstate.group, cwd: cstate.cwd, mode: cstate.mode });
  } catch (e) {
    $('c-error').textContent = e.message;
    return;
  }
  $('cdlg').close();
  await refresh();
  attach(name);
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
      title: `Rename "${s.name}"`, msg: NAME_HINT,
      input: name, okLabel: 'Rename', error,
    });
    if (name === null || name === s.name) return;
    if (!NAME_RE.test(name)) { error = NAME_HINT; continue; }
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

function attach(name) {
  if (active === name) return;
  active = name;
  $('term').src = `/term/?arg=${encodeURIComponent(name)}`;
  $('main').classList.add('attached');
  render();
}

function detach() {
  active = null;
  $('term').src = 'about:blank';
  $('main').classList.remove('attached');
  render();
}

/* ---------- rendering ---------- */

function sessionRow(s) {
  const li = document.createElement('div');
  li.className = 'session' + (s.name === active ? ' active' : '');

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.textContent = s.name === active ? '●' : '○';
  li.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  name.title = s.name;
  li.appendChild(name);

  if (s.busy) {
    const busy = document.createElement('span');
    busy.className = 'busy';
    busy.textContent = s.foreground;
    busy.title = `foreground process: ${s.foreground}`;
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

  li.addEventListener('click', () => attach(s.name));
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
  menuBtn.title = 'Folder actions';
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

function render() {
  const list = $('session-list');
  list.textContent = '';
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
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 2}px`;
  menu.style.left = `${Math.max(8, rect.left - 120)}px`;
  document.body.appendChild(menu);
}

function openSessionMenu(s, anchor) {
  showMenu([
    ['Rename…', () => renameSession(s), ''],
    ['Copy SSH attach command', () => copyText(sshAttachCommand(s.name)), ''],
    ['Copy local attach command', () => copyText(s.attach_command), ''],
    ['Terminate…', () => killSession(s), 'danger'],
  ], anchor);
}

function openFolderMenu(path, anchor) {
  const items = [];
  if (path.split('/').length < MAX_FOLDER_DEPTH) {
    items.push(['New subfolder…', () => addFolder(path), '']);
  }
  if (path !== DEFAULT_FOLDER) {
    items.push(['Delete folder…', () => deleteFolder(path), 'danger']);
  }
  if (items.length) showMenu(items, anchor);
}

document.addEventListener('click', closeMenu);

/* ---------- refresh / polling ---------- */

async function refresh() {
  try {
    sessions = await api.list();
  } catch {
    return; // keep last known state; next poll self-corrects (NFR-3)
  }
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

/* ---------- init ---------- */

function setSidebar(collapsed) {
  document.body.classList.toggle('collapsed', collapsed);
  localStorage.setItem('agentpeek-sidebar', collapsed ? 'collapsed' : 'open');
}
$('collapse-btn').addEventListener('click', () => setSidebar(true));
$('expand-btn').addEventListener('click', () => setSidebar(false));
if (localStorage.getItem('agentpeek-sidebar') === 'collapsed') setSidebar(true);

$('create-btn').addEventListener('click', openCreateDialog);
$('add-folder-btn').addEventListener('click', () => addFolder(null));
$('c-ok').addEventListener('click', submitCreate);
$('c-cancel').addEventListener('click', () => $('cdlg').close());
$('c-name').addEventListener('input', () => clearFieldError($('c-name')));
$('c-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitCreate(); }
});
$('c-mode').querySelectorAll('.chip').forEach((b) => {
  b.addEventListener('click', () => {
    $('c-mode').querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
    b.classList.add('selected');
    cstate.mode = b.dataset.mode;
  });
});
$('dlg-cancel').addEventListener('click', () => $('dlg').close('cancel'));

setInterval(refresh, 3000);
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

(async () => {
  await loadConfig();
  try { hostInfo = await api.host(); } catch { /* keep placeholders */ }
  refresh();
})();
