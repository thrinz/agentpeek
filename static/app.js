'use strict';

const $ = (id) => document.getElementById(id);
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const NAME_HINT = "Letters, digits, '-' and '_' only.";
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
  cstate.type = 'shell';
  cstate.cwd = null;   // mandatory — a real directory, not the projects root

  renderFolderPicker();
  $('c-mode').querySelectorAll('.chip').forEach((b) => {
    b.classList.toggle('selected', b.dataset.mode === cstate.mode);
  });
  $('c-type').querySelectorAll('.chip').forEach((b) => {
    b.classList.toggle('selected', b.dataset.type === cstate.type);
  });
  $('c-start-field').hidden = cstate.type === 'ui';

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
    const mode = cstate.type === 'ui' ? 'ui' : cstate.mode;
    await api.create({ name, group: cstate.group, cwd: cstate.cwd, mode });
  } catch (e) {
    $('c-error').textContent = e.message;
    return;
  }
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

function showView(kind) {
  const main = $('main');
  main.classList.toggle('attached', kind === 'shell');
  main.classList.toggle('chatting', kind === 'ui');
}

function attach(name) {
  if (active === name && activeKind === 'shell') return;
  closeChat();
  active = name; activeKind = 'shell';
  $('term').src = `/term/?arg=${encodeURIComponent(name)}`;
  showView('shell');
  render();
}

function detach() {
  closeChat();
  active = null; activeKind = null;
  $('term').src = 'about:blank';
  showView(null);
  render();
}

/* ---------- rendering ---------- */

function sessionRow(s) {
  const li = document.createElement('div');
  li.className = 'session' + (s.name === active ? ' active' : '');

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

  li.addEventListener('click', () => (s.kind === 'ui' ? openChat(s.name) : attach(s.name)));
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
  const items = [['Rename…', () => renameSession(s), '']];
  if (s.kind !== 'ui') {
    items.push(['Copy SSH attach command', () => copyText(sshAttachCommand(s.name)), '']);
    items.push(['Copy local attach command', () => copyText(s.attach_command), '']);
  }
  items.push(['Terminate…', () => killSession(s), 'danger']);
  showMenu(items, anchor);
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

/* ---------- UI-mode chat ---------- */

let chatWs = null;
let chatSession = null;
let chatReconnectTimer = null;
let chatReconnectDelay = 1000;
let streamingEl = null;
let chatTotalCost = 0;
let chatModel = 'opus';
let ttsOn = false;
let recog = null;
// Cost is only meaningful with an API key; subscription (Pro/Max) usage is
// covered by the plan, so we hide the $ figure unless method === 'api_key'.
let costVisible = false;

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
  else if (ev.role === 'tool_result') el = collapsible('tool-result', 'Tool result', ev.text, false);
  else if (ev.role === 'result') {
    el = resultEl(ev);
    if (typeof ev.cost === 'number') { chatTotalCost += ev.cost; updateCost(); }
  } else if (ev.role === 'error') el = simpleMsg('error', ev.text);
  if (el) log.appendChild(el);
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
  maybeScroll();
}

function clearStreaming() {
  if (streamingEl) { streamingEl.remove(); streamingEl = null; }
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
  $('chat-stop').hidden = !busy;
  $('chat').classList.toggle('busy', !!busy);
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
    updateCost();
    scrollChatBottom();
  } else if (m.type === 'delta') {
    appendDelta(m.text);
  } else if (m.type === 'event') {
    clearStreaming();
    renderChatEvent(m.event, true);
  } else if (m.type === 'status') {
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
  $('chat-title').textContent = name;
  $('chat-log').textContent = '';
  chatTotalCost = 0; updateCost(); applyCostVisibility();
  clearAttachments();
  setChatBusy(false);
  const s = sessions.find((x) => x.name === name && x.kind === 'ui');
  chatModel = (s && s.model) || 'opus';
  $('chat-model').value = chatModel;
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

function chatSend() {
  const ta = $('chat-input');
  let text = ta.value.trim();
  if (!text && !chatAttachments.length) return;
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) { flash('Reconnecting — try again'); return; }
  if (chatAttachments.length) {
    const refs = chatAttachments.map((a) => a.path).join('\n');
    text = (text ? text + '\n\n' : '') + 'Attached image(s):\n' + refs;
  }
  chatWs.send(JSON.stringify({ type: 'send', text }));
  ta.value = ''; autoGrow(ta); hideMentions(); clearAttachments();
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
  ta.value = ta.value.slice(0, mentionStart) + '@' + file + ' ' + ta.value.slice(pos);
  const np = mentionStart + file.length + 2;
  ta.setSelectionRange(np, np);
  hideMentions(); autoGrow(ta); ta.focus();
}

/* --- voice in / out --- */

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('chat-mic').style.display = 'none'; return; }
  recog = new SR();
  recog.lang = 'en-US';
  recog.interimResults = false;
  recog.onresult = (e) => {
    const t = Array.from(e.results).map((r) => r[0].transcript).join(' ');
    const ta = $('chat-input');
    ta.value = (ta.value + ' ' + t).trim();
    autoGrow(ta);
  };
  recog.onend = () => $('chat-mic').classList.remove('on');
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
  if ($('chat-mic').classList.contains('on')) recog.stop();
  else { try { recog.start(); $('chat-mic').classList.add('on'); } catch { /* ignore */ } }
});
$('chat-input').addEventListener('input', onChatInput);
$('chat-input').addEventListener('keydown', (e) => {
  if (mentionActive()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionItems.length; renderMentionSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length; renderMentionSel(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionItems[mentionIndex]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideMentions(); return; }
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
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let had = false;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) { had = true; addAttachment(blob); }
    }
  }
  if (had) e.preventDefault();  // don't also dump binary into the textarea
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
    applyCostVisibility();
    return st;
  } catch { return null; }
}

function clRenderState(st) {
  $('cl-status').textContent = st ? st.detail : '';
  $('cl-error').textContent = '';
  $('cl-code').value = ''; $('cl-key').value = ''; $('cl-url').value = '';
  const managed = st && (st.method === 'oauth_token' || st.method === 'api_key');
  clShow('cl-disconnect', !!managed);
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
  selectClChoice('oauth');
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
$('c-type').querySelectorAll('.chip').forEach((b) => {
  b.addEventListener('click', () => {
    $('c-type').querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
    b.classList.add('selected');
    cstate.type = b.dataset.type;
    $('c-start-field').hidden = cstate.type === 'ui';
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
  refreshClaude();
})();
