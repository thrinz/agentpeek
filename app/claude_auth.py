"""Claude authentication for UI mode.

UI-mode chats run the Claude Agent SDK, which spawns the `claude` CLI and uses
whatever it is authenticated with. This module:

  - reports whether Claude is reachable (the host's own `claude` login, or a
    token/key saved by agentpeek), and
  - drives `claude setup-token` for an in-browser login: that command prints an
    authorize URL and then waits for a code on stdin. We surface the URL to the
    browser; the user approves in their own browser, pastes the code back, and
    we capture the long-lived subscription token and persist it as
    CLAUDE_CODE_OAUTH_TOKEN. An Anthropic API key can be saved instead.

Everything that needs a secret is written to ~/.config/agentpeek/agentpeek.env
(0600), which the systemd unit loads at boot; we also set it in this process's
environment so UI-mode agents spawned now pick it up without a restart.
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import threading
import time
from pathlib import Path

from fastapi import Body, HTTPException

CLAUDE_CREDENTIALS = Path.home() / ".claude" / ".credentials.json"
CONFIG_DIR = Path.home() / ".config" / "agentpeek"
ENV_FILE = CONFIG_DIR / "agentpeek.env"

_OAUTH_KEY = "CLAUDE_CODE_OAUTH_TOKEN"
_APIKEY = "ANTHROPIC_API_KEY"

# Strip ANSI CSI / OSC / a few two-char escapes so we can scan the text.
_ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>78]")
_URL_RE = re.compile(r"https://claude\.com/\S*oauth/authorize\S*")
_TOKEN_RE = re.compile(r"sk-ant-oat\S+|sk-ant-[A-Za-z0-9_-]{40,}")


def _strip(b: bytes) -> str:
    return _ANSI.sub(b"", b).decode("utf-8", "replace")


def _tail(text: str, n: int = 240) -> str:
    clean = "".join(c for c in text if c == "\n" or c >= " ")
    clean = " ".join(clean.split())
    return clean[-n:]


# --- status --------------------------------------------------------------

def claude_status() -> dict:
    """Whether UI-mode agents can authenticate to Claude right now."""
    if os.environ.get(_OAUTH_KEY):
        return {"connected": True, "method": "oauth_token",
                "detail": "Connected with a saved Claude subscription token."}
    if os.environ.get(_APIKEY):
        return {"connected": True, "method": "api_key",
                "detail": "Connected with a saved Anthropic API key."}
    # Test toggle: pretend the host's own login isn't there so the in-app
    # sign-in flow is the front path. A real saved token/key (checked above)
    # still wins, so completing the flow clears the "disconnected" state.
    if os.environ.get("AGENTPEEK_FORCE_CLAUDE_LOGIN"):
        return {"connected": False, "method": None,
                "detail": "Test mode — sign in to Claude below."}
    if CLAUDE_CREDENTIALS.exists():
        return {"connected": True, "method": "subscription",
                "detail": "Connected via the host's existing Claude login."}
    return {"connected": False, "method": None,
            "detail": "Not connected. Sign in to Claude, or add an API key."}


# --- env-file persistence ------------------------------------------------

def _upsert_env(updates: dict) -> None:
    """Set/replace keys in agentpeek.env and this process's environment.
    A value of None removes the key."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    kept, seen = [], set()
    for ln in lines:
        key = ln.split("=", 1)[0] if "=" in ln else ln
        if key in updates:
            seen.add(key)
            if updates[key] is not None:
                kept.append(f"{key}={updates[key]}")
        else:
            kept.append(ln)
    for key, val in updates.items():
        if val is not None and key not in seen:
            kept.append(f"{key}={val}")
    ENV_FILE.write_text("\n".join(kept) + "\n")
    os.chmod(ENV_FILE, 0o600)
    for key, val in updates.items():
        if val is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = val


def save_token(token: str) -> None:
    # The two creds conflict if both are set; keep only the one just saved.
    _upsert_env({_OAUTH_KEY: token, _APIKEY: None})


def save_api_key(key: str) -> None:
    _upsert_env({_APIKEY: key, _OAUTH_KEY: None})


def disconnect() -> None:
    """Clear agentpeek-managed creds. Does not touch the host's own ~/.claude login."""
    _upsert_env({_OAUTH_KEY: None, _APIKEY: None})


# --- setup-token login flow ----------------------------------------------

class _Flow:
    def __init__(self, proc, master):
        self.proc = proc
        self.master = master
        self.buf = b""
        self.url = None

    def read_until(self, predicate, timeout: float) -> str:
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], 0.3)
            if r:
                try:
                    chunk = os.read(self.master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                self.buf += chunk
            text = _strip(self.buf)
            if predicate(text):
                return text
        return _strip(self.buf)


_flow: "_Flow | None" = None
_lock = threading.Lock()


def _kill(flow: "_Flow | None") -> None:
    if not flow:
        return
    try:
        os.killpg(os.getpgid(flow.proc.pid), signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
    try:
        os.close(flow.master)
    except OSError:
        pass


def cancel_login() -> None:
    global _flow
    with _lock:
        _kill(_flow)
        _flow = None


def start_login() -> str:
    """Spawn `claude setup-token`, return the authorize URL it prints."""
    global _flow
    with _lock:
        _kill(_flow)
        _flow = None
        master, slave = pty.openpty()
        # Very wide window so the long OAuth URL prints on one line (no wrap).
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 1000, 0, 0))
        except OSError:
            pass
        proc = subprocess.Popen(
            ["claude", "setup-token"],
            stdin=slave, stdout=slave, stderr=slave,
            close_fds=True, start_new_session=True,
            env={**os.environ, "TERM": "xterm"},
        )
        os.close(slave)
        flow = _Flow(proc, master)

        def _has_full_url(t):
            mm = _URL_RE.search(t)
            return bool(mm) and "state=" in mm.group(0)  # the last query param

        text = flow.read_until(_has_full_url, timeout=40)
        m = _URL_RE.search(text)
        if not (m and "state=" in m.group(0)):
            _kill(flow)
            raise RuntimeError(
                "Timed out waiting for the Claude sign-in URL. " + _tail(text))
        flow.url = m.group(0)
        _flow = flow
        return flow.url


def submit_code(code: str) -> dict:
    """Feed the pasted code to setup-token, capture + persist the token."""
    global _flow
    with _lock:
        flow = _flow
        if not flow or flow.proc.poll() is not None:
            raise RuntimeError("No active sign-in — start again.")
        os.write(flow.master, (code.strip() + "\n").encode())
        text = flow.read_until(
            lambda t: bool(_TOKEN_RE.search(t))
            or "nvalid" in t or "rror" in t or "ailed" in t or "xpired" in t,
            timeout=40,
        )
        m = _TOKEN_RE.search(text)
        if not m:
            _kill(flow)
            _flow = None
            raise RuntimeError("Sign-in did not return a token. " + _tail(text))
        token = m.group(0)
        save_token(token)
        _kill(flow)
        _flow = None
        return claude_status()


# --- routes --------------------------------------------------------------

def install_claude_auth(app) -> None:
    @app.get("/api/claude/status")
    def _status():
        return claude_status()

    @app.post("/api/claude/login/start")
    def _start():
        try:
            return {"url": start_login()}
        except RuntimeError as e:
            raise HTTPException(503, str(e))

    @app.post("/api/claude/login/code")
    def _code(body: dict = Body(...)):
        code = (body.get("code") or "").strip()
        if not code:
            raise HTTPException(422, "Paste the code from the sign-in page.")
        try:
            return submit_code(code)
        except RuntimeError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/claude/login/cancel")
    def _cancel():
        cancel_login()
        return {"ok": True}

    @app.post("/api/claude/apikey")
    def _apikey(body: dict = Body(...)):
        key = (body.get("key") or "").strip()
        if not key.startswith("sk-ant-"):
            raise HTTPException(422, "That doesn't look like an Anthropic API key (expected sk-ant-…).")
        save_api_key(key)
        return claude_status()

    @app.post("/api/claude/disconnect")
    def _disconnect():
        disconnect()
        return claude_status()
