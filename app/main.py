"""agentpeek — control plane for tmux sessions + reverse proxy in front of ttyd.

Everything is served from one port (default 8090):
  /                  static frontend (sidebar + iframe)
  /api/sessions      REST session lifecycle (list/create/rename/kill)
  /api/host          user@host info for the manual SSH instructions
  /term/...          proxied to ttyd (HTTP assets and the /term/ws websocket),
                     so the terminal iframe is same-origin and a single
                     `tailscale serve` command exposes the whole app.
"""

import asyncio
import getpass
import json
import os
import secrets
import socket
import subprocess
import threading
from functools import lru_cache
from pathlib import Path

import httpx
import websockets
from fastapi import (
    FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect,
)
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth
from . import claude_auth
from . import multiplexer as mux
from . import ui_agent

# ttyd's port is configurable (AGENTPEEK_TTYD_PORT); the systemd unit passes the
# same value to ttyd's --port, so the proxy target stays in sync.
TTYD_PORT = os.environ.get("AGENTPEEK_TTYD_PORT", "7681")
TTYD_HTTP = f"http://127.0.0.1:{TTYD_PORT}"
TTYD_WS = f"ws://127.0.0.1:{TTYD_PORT}"
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Root of the working-directory picker in the create dialog. Created on startup
# so a fresh install can always browse it (and create folders under it).
DIRS_ROOT = Path.home() / "projects"
DIRS_ROOT.mkdir(parents=True, exist_ok=True)
SKIP_DIRS = {"node_modules", "__pycache__"}
# Working-directory folder names: a single path segment, conservative charset.
_DIR_NAME_OK = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")

# Sidebar folders are user-defined (max two levels, "Parent/Child"), persisted
# as a JSON list of paths. General always exists as the catch-all for sessions
# created outside the UI.
FOLDERS_FILE = Path.home() / ".config" / "agentpeek" / "folders.json"
DEFAULT_FOLDER = "General"
MAX_FOLDER_DEPTH = 3  # top-level + two nested levels
_folders_lock = threading.Lock()


def _load_folders() -> list[str]:
    try:
        folders = [f for f in json.loads(FOLDERS_FILE.read_text())
                   if isinstance(f, str)]
    except (OSError, json.JSONDecodeError):
        folders = []  # nothing pre-created; users add their own folders
    if DEFAULT_FOLDER not in folders:
        folders.append(DEFAULT_FOLDER)
    return sorted(set(folders))


def _save_folders(folders: list[str]) -> None:
    FOLDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    FOLDERS_FILE.write_text(json.dumps(sorted(set(folders)), indent=2) + "\n")


def _validate_folder_path(path: str) -> str:
    path = path.strip().strip("/")
    segments = path.split("/")
    if not path or len(segments) > MAX_FOLDER_DEPTH:
        raise HTTPException(
            422, f"Groups can nest at most {MAX_FOLDER_DEPTH - 1} levels "
                 "below a top-level group.")
    for seg in segments:
        if not mux.NAME_RE.match(seg):
            raise HTTPException(
                422, "Group names may only contain letters, digits, '-' and '_'.")
    return path

app = FastAPI(title="agentpeek")


@app.on_event("startup")
async def _start_sweeper():
    ui_agent.manager.start_sweeper()


@app.middleware("http")
async def no_stale_cache(request: Request, call_next):
    """Make browsers revalidate our static files on every load (cheap 304s
    via ETag), so UI updates show up without a hard refresh. ttyd's own
    assets under /term are left alone."""
    response = await call_next(request)
    if not request.url.path.startswith("/term"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


class CreateBody(BaseModel):
    name: str
    group: str           # mandatory — must be one of GROUPS
    cwd: str             # mandatory — a directory inside DIRS_ROOT, not the root itself
    mode: str = "ai"     # "ai" runs `cds` in a shell | "shell" | "ui" (Claude chat)
    model: str | None = None  # UI mode only: "opus" | "sonnet" | "haiku"
    notify_topic: str | None = None  # ntfy topic for push on turn-complete (ai mode)


class RenameBody(BaseModel):
    new_name: str | None = None
    group: str | None = None


def _call(fn, *args):
    try:
        return fn(*args)
    except mux.InvalidName as e:
        raise HTTPException(422, str(e))
    except mux.DuplicateSession as e:
        raise HTTPException(409, str(e))
    except mux.NoSuchSession as e:
        raise HTTPException(404, str(e))
    except mux.MuxError as e:
        raise HTTPException(500, str(e))


@app.get("/api/sessions")
def list_sessions():
    sessions = _call(mux.list_sessions)
    for s in sessions:
        s["kind"] = "shell"
    return sessions + ui_agent.manager.list()


def _resolve_dir(rel: str) -> Path:
    rel = (rel or "").strip().strip("/")
    path = (DIRS_ROOT / rel).resolve() if rel else DIRS_ROOT
    if path != DIRS_ROOT and not path.is_relative_to(DIRS_ROOT):
        raise HTTPException(422, "Directory must be inside the projects root.")
    if not path.is_dir():
        raise HTTPException(404, f"No such directory: {rel or 'projects'}")
    return path


@app.post("/api/sessions", status_code=201)
def create_session(body: CreateBody):
    name = body.name.strip()
    group = body.group.strip().strip("/")
    if group not in _load_folders():
        raise HTTPException(422, f"Unknown group '{group}'.")
    if body.mode not in ("shell", "ai", "ui"):
        raise HTTPException(422, "Start option must be 'shell', 'ai', or 'ui'.")
    cwd = _resolve_dir(body.cwd)
    if cwd == DIRS_ROOT:
        raise HTTPException(
            422, f"Choose a directory inside {DIRS_ROOT.name}/ — sessions "
                 "cannot be created in the root itself.")
    # Names are unique across both shell (tmux) and UI sessions.
    _call(mux.validate_name, name)
    if mux.has(name) or ui_agent.manager.exists(name):
        raise HTTPException(409, f"A session named '{name}' already exists.")
    if body.mode == "ui":
        model = body.model if body.model in ui_agent.MODELS else ui_agent.DEFAULT_MODEL
        ui_agent.manager.create(name, group, cwd, model)
    else:
        topic = (body.notify_topic or "").strip() or None
        _call(mux.create, name, cwd, group, body.mode == "ai", topic)
    return {"name": name}


@app.get("/api/config")
def get_config():
    return {"folders": _load_folders(), "root": DIRS_ROOT.name}


class FolderBody(BaseModel):
    path: str


@app.post("/api/folders", status_code=201)
def create_folder(body: FolderBody):
    path = _validate_folder_path(body.path)
    with _folders_lock:
        folders = _load_folders()
        if path in folders:
            raise HTTPException(409, f"Group '{path}' already exists.")
        if "/" in path:
            parent = path.rsplit("/", 1)[0]
            if parent not in folders:
                raise HTTPException(422, f"Parent group '{parent}' does not exist.")
        folders.append(path)
        _save_folders(folders)
    return {"path": path}


@app.delete("/api/folders/{path:path}", status_code=204)
def delete_folder(path: str):
    path = _validate_folder_path(path)
    if path == DEFAULT_FOLDER:
        raise HTTPException(422, "The General group cannot be deleted.")
    with _folders_lock:
        folders = _load_folders()
        if path not in folders:
            raise HTTPException(404, f"No group named '{path}'.")
        if any(f.startswith(path + "/") for f in folders):
            raise HTTPException(409, "Group has subgroups; delete them first.")
        if any(s["group"] == path for s in mux.list_sessions()):
            raise HTTPException(
                409, "Group still has sessions; terminate them first.")
        folders.remove(path)
        _save_folders(folders)


@app.get("/api/dirs")
def list_dirs(path: str = ""):
    base = _resolve_dir(path)
    try:
        dirs = sorted(
            d.name for d in base.iterdir()
            if d.is_dir() and not d.name.startswith(".") and d.name not in SKIP_DIRS
        )
    except PermissionError:
        dirs = []
    return {"path": path, "dirs": dirs}


class DirBody(BaseModel):
    path: str


@app.post("/api/dirs", status_code=201)
def create_dir(body: DirBody):
    """Create a new working directory under the projects root. `path` is a
    relative path; each segment must be a safe name (no dots/slashes/'..')."""
    rel = body.path.strip().strip("/")
    segs = rel.split("/") if rel else []
    if not segs or not all(s and set(s) <= _DIR_NAME_OK for s in segs):
        raise HTTPException(
            422, "Folder names may use letters, digits, '-' and '_' only.")
    target = (DIRS_ROOT / rel).resolve()
    if not target.is_relative_to(DIRS_ROOT):
        raise HTTPException(422, "Directory must be inside the projects root.")
    if target.exists():
        raise HTTPException(409, f"'{rel}' already exists.")
    parent = target.parent
    if not parent.is_dir():
        raise HTTPException(404, f"Parent directory does not exist: {parent.name}")
    target.mkdir()
    return {"path": rel}


_FILE_SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "dist", ".next", "build"}


@app.get("/api/ui/files")
def ui_files(session: str, q: str = ""):
    """Files under a UI session's working directory, for @-mention autocomplete."""
    meta = ui_agent.manager.registry.get(session)
    if not meta:
        raise HTTPException(404, "No such UI session.")
    base = Path(meta["cwd"])
    needle = (q or "").lower()
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in _FILE_SKIP_DIRS]
        for f in files:
            if f.startswith("."):
                continue
            rel = os.path.relpath(os.path.join(root, f), base)
            if not needle or needle in rel.lower():
                out.append(rel)
                if len(out) >= 40:
                    return {"files": sorted(out)}
    return {"files": sorted(out)}


_IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
MAX_PASTE_BYTES = 12 * 1024 * 1024
PASTE_SUBDIR = ".agentpeek/pastes"


@app.post("/api/ui/paste")
async def ui_paste(session: str, file: UploadFile = File(...)):
    """Save a pasted/dropped image under the UI session's working dir so the
    agent can read it (via its Read tool). Returns the relative path."""
    meta = ui_agent.manager.registry.get(session)
    if not meta:
        raise HTTPException(404, "No such UI session.")
    ext = _IMG_EXT.get((file.content_type or "").lower())
    if not ext:
        raise HTTPException(422, "Only PNG, JPEG, GIF or WebP images are supported.")
    data = await file.read()
    if not data:
        raise HTTPException(422, "Empty image.")
    if len(data) > MAX_PASTE_BYTES:
        raise HTTPException(413, f"Image exceeds {MAX_PASTE_BYTES // (1024 * 1024)}MB.")
    base = Path(meta["cwd"]) / PASTE_SUBDIR
    base.mkdir(parents=True, exist_ok=True)
    name = f"paste-{secrets.token_hex(4)}{ext}"
    (base / name).write_bytes(data)
    return {"path": f"{PASTE_SUBDIR}/{name}"}


@app.patch("/api/sessions/{name}")
def update_session(name: str, body: RenameBody):
    # Move to a different sidebar folder.
    if body.group is not None:
        group = body.group.strip().strip("/")
        if group not in _load_folders():
            raise HTTPException(422, f"Unknown group '{group}'.")
        if ui_agent.manager.exists(name):
            ui_agent.manager.set_group(name, group)
        else:
            _call(mux.set_group, name, group)
        return {"name": name, "group": group}
    # Rename.
    if body.new_name is None:
        raise HTTPException(422, "Provide new_name or group.")
    new = body.new_name.strip()
    if ui_agent.manager.exists(name):
        _call(mux.validate_name, new)
        if mux.has(new) or (new != name and ui_agent.manager.exists(new)):
            raise HTTPException(409, f"A session named '{new}' already exists.")
        ui_agent.manager.rename(name, new)
        return {"name": new}
    _call(mux.rename, name, new)
    return {"name": new}


class KeysBody(BaseModel):
    keys: list[str] = []        # tmux key names, e.g. ["C-c"], ["Escape"], ["Up"]
    scroll: str | None = None   # "up" | "down" — scroll the view in copy-mode
    text: str | None = None     # literal text to paste into the session


@app.post("/api/sessions/{name}/keys", status_code=204)
def session_keys(name: str, body: KeysBody):
    # Touch-bar keys apply to tmux (shell/ai) sessions, not UI chat sessions.
    if ui_agent.manager.exists(name):
        raise HTTPException(422, "Key input is only available for shell sessions.")
    if body.text is not None:
        _call(mux.send_text, name, body.text)
    elif body.scroll is not None:
        _call(mux.scroll, name, body.scroll)
    else:
        _call(mux.send_keys, name, body.keys)


@app.delete("/api/sessions/{name}", status_code=204)
async def kill_session(name: str):
    if ui_agent.manager.exists(name):
        await ui_agent.manager.kill(name)
        return
    _call(mux.kill, name)


@lru_cache(maxsize=1)
def _host_info() -> dict:
    info = {"user": getpass.getuser(), "host": socket.gethostname()}
    try:
        proc = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=5,
        )
        if proc.returncode == 0:
            dns = json.loads(proc.stdout).get("Self", {}).get("DNSName", "")
            if dns:
                info["host"] = dns.rstrip(".")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return info


@app.get("/api/host")
def host_info():
    return _host_info()


# ---------------------------------------------------------------------------
# ttyd reverse proxy
# ---------------------------------------------------------------------------

_HOP_HEADERS = {
    "connection", "keep-alive", "transfer-encoding", "upgrade",
    "content-encoding", "content-length",
}

# Injected into ttyd's index page: ttyd's xterm.js build has no OSC 52
# handler, so clipboard escapes from programs inside tmux (copy-mode,
# Claude Code, ...) are announced but silently dropped. This shim watches
# the terminal's websocket output frames for OSC 52 and writes the payload
# to the browser clipboard instead.
_OSC52_SHIM = b"""<script>
(function () {
  'use strict';
  var carry = '';
  var latin1 = new TextDecoder('latin1');
  var utf8 = new TextDecoder();
  function scan(buf) {
    if (buf.byteLength < 2 || new Uint8Array(buf)[0] !== 48) return; // '0' = output
    var text = carry + latin1.decode(new Uint8Array(buf, 1));
    carry = '';
    for (;;) {
      var start = text.indexOf('\\x1b]52;');
      if (start === -1) return;
      var rest = text.slice(start + 5);
      var m = rest.match(/^([^;]*);([A-Za-z0-9+\\/=]*)(\\x07|\\x1b\\\\)/);
      if (!m) { carry = text.slice(start).slice(0, 100000); return; }
      if (m[2]) {
        try {
          var raw = atob(m[2]);
          var bytes = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          navigator.clipboard.writeText(utf8.decode(bytes)).catch(function () {});
        } catch (e) { /* bad base64 - ignore */ }
      }
      text = rest.slice(m[0].length);
    }
  }
  var NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    ws.addEventListener('message', function (ev) {
      if (ev.data instanceof ArrayBuffer) { try { scan(ev.data); } catch (e) {} }
    });
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  PatchedWS.CONNECTING = NativeWS.CONNECTING;
  PatchedWS.OPEN = NativeWS.OPEN;
  PatchedWS.CLOSING = NativeWS.CLOSING;
  PatchedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = PatchedWS;
})();
</script>"""


@app.websocket("/term/ws")
async def term_ws(client: WebSocket):
    if not auth.websocket_authorized(client):
        await client.close(code=1008, reason="Not authenticated")
        return
    qs = client.scope.get("query_string", b"").decode()
    url = f"{TTYD_WS}/term/ws" + (f"?{qs}" if qs else "")
    try:
        upstream = await websockets.connect(url, subprotocols=["tty"], max_size=None)
    except OSError:
        await client.close(code=1011, reason="ttyd is not reachable")
        return
    await client.accept(subprotocol="tty")

    async def client_to_upstream():
        while True:
            msg = await client.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                await upstream.send(msg["bytes"])
            elif msg.get("text") is not None:
                await upstream.send(msg["text"])

    async def upstream_to_client():
        async for msg in upstream:
            if isinstance(msg, (bytes, bytearray)):
                await client.send_bytes(bytes(msg))
            else:
                await client.send_text(msg)

    pumps = [
        asyncio.create_task(client_to_upstream()),
        asyncio.create_task(upstream_to_client()),
    ]
    try:
        _, pending = await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
    finally:
        await upstream.close()
        try:
            await client.close()
        except RuntimeError:
            pass  # already closed by the other side


@app.websocket("/ui/ws")
async def ui_ws(client: WebSocket):
    if not auth.websocket_authorized(client):
        await client.close(code=1008, reason="Not authenticated")
        return
    name = client.query_params.get("session", "")
    runner = ui_agent.manager.get_runner(name)
    if runner is None:
        await client.close(code=1003, reason="No such UI session")
        return
    await client.accept()
    await runner.add_ws(client)
    try:
        while True:
            data = await client.receive_json()
            kind = data.get("type")
            if kind == "send":
                text = (data.get("text") or "").strip()
                if text:
                    await runner.enqueue(text)
            elif kind == "interrupt":
                await runner.interrupt()
            elif kind == "answer":
                runner.resolve_ask(data.get("id"), data.get("answers") or [])
            elif kind == "set_model":
                await runner.set_model(data.get("model"))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        runner.remove_ws(client)


@app.get("/term")
def term_redirect():
    return RedirectResponse("/term/")


@app.get("/term/{path:path}")
async def term_http(path: str, request: Request):
    url = f"{TTYD_HTTP}/term/{path}"
    async with httpx.AsyncClient() as hc:
        try:
            r = await hc.get(url, params=dict(request.query_params))
        except httpx.HTTPError:
            raise HTTPException(502, "ttyd is not reachable")
    headers = {
        k: v for k, v in r.headers.items() if k.lower() not in _HOP_HEADERS
    }
    content = r.content
    if "text/html" in r.headers.get("content-type", ""):
        # before ttyd's own bundle, so WebSocket is patched before it connects
        content = content.replace(b"<script", _OSC52_SHIM + b"<script", 1)
    return Response(content=content, status_code=r.status_code, headers=headers)


# Auth middleware + /login routes must be registered before the catch-all mount.
auth.install_auth(app)
claude_auth.install_claude_auth(app)

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
