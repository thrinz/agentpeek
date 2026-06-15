"""Optional key-based auth, ported from filepeek's scheme.

Auth turns on when AGENTPEEK_PASSWORD_HASH and/or AGENTPEEK_TOKEN is set. With
neither set the app is open (the localhost + Tailscale posture for local use);
binding a non-loopback host without auth is refused in main.py. Generate a hash
with:  .venv/bin/python -m app hash-password

The browser logs in with a password (PBKDF2-checked) and gets a signed,
HttpOnly session cookie; scripts can pass `Authorization: Bearer <token>`.
"""

import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path
from typing import Optional

from fastapi import Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

PASSWORD_HASH = os.environ.get("AGENTPEEK_PASSWORD_HASH", "")
API_TOKEN = os.environ.get("AGENTPEEK_TOKEN", "")
AUTH_ENABLED = bool(PASSWORD_HASH or API_TOKEN)
# Unset secret means sessions are invalidated on restart, which is fine locally.
SESSION_SECRET = os.environ.get("AGENTPEEK_SECRET") or secrets.token_hex(32)
SESSION_COOKIE = "agentpeek_session"
SESSION_TTL = 7 * 24 * 3600
LOGIN_MAX_FAILURES = 10
LOGIN_LOCKOUT_SECONDS = 15 * 60
MIN_PASSWORD_LEN = 8
# Login page + its only asset, plus a health check, are reachable unauthenticated.
AUTH_EXEMPT_PATHS = {"/login", "/logout", "/logo.svg", "/favicon.ico"}

# When setup.sh auto-generates a password it sets this, so the first login is
# forced through /change-password before the app loads.
PASSWORD_MUST_CHANGE = os.environ.get(
    "AGENTPEEK_PASSWORD_MUST_CHANGE", "").strip().lower() not in ("", "0", "false", "no")
INITIAL_PW_FILE = Path.home() / ".config" / "agentpeek" / "initial-password.txt"

_login_failures: dict = {}  # ip -> (failure_count, locked_until_ts)


def hash_password(password: str, iterations: int = 200_000) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def _sign_session(expiry: int) -> str:
    sig = hmac.new(SESSION_SECRET.encode(), str(expiry).encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{sig}"


def _session_valid(cookie: Optional[str]) -> bool:
    if not cookie or "." not in cookie:
        return False
    expiry, _, sig = cookie.partition(".")
    try:
        if int(expiry) < time.time():
            return False
    except ValueError:
        return False
    expected = hmac.new(SESSION_SECRET.encode(), expiry.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def _client_ip(request: Request) -> str:
    # Trust X-Forwarded-For only when the direct peer is the local reverse proxy
    # (tailscale serve / uvicorn both terminate at 127.0.0.1).
    direct = request.client.host if request.client else "unknown"
    fwd = request.headers.get("x-forwarded-for")
    if fwd and direct in ("127.0.0.1", "::1"):
        return fwd.split(",")[0].strip()
    return direct


def request_authorized(request: Request) -> bool:
    """True if the request carries a valid session cookie or bearer token."""
    if _session_valid(request.cookies.get(SESSION_COOKIE)):
        return True
    if API_TOKEN:
        header = request.headers.get("authorization", "")
        if header.startswith("Bearer ") and hmac.compare_digest(header[7:], API_TOKEN):
            return True
    return False


def websocket_authorized(websocket) -> bool:
    """Auth gate for the terminal WebSocket. Browsers can't set Authorization on
    a WS handshake, so this checks the session cookie (or the bearer token if a
    script passes it as a query param ?token=)."""
    if not AUTH_ENABLED:
        return True
    if _session_valid(websocket.cookies.get(SESSION_COOKIE)):
        return True
    if API_TOKEN:
        token = websocket.query_params.get("token", "")
        if token and hmac.compare_digest(token, API_TOKEN):
            return True
    return False


LOGIN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentpeek — log in</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<style>
  :root {
    --bg: #0b0e14; --card: #11151f; --fg: #d7dce5; --border: #232a3a;
    --accent: #2563eb; --accent-hover: #1d4ed8; --danger: #e05c5c;
  }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: var(--bg); font-family: system-ui, sans-serif; }
  .card { background: var(--card); border-radius: 12px; padding: 2rem 2.5rem; width: 20rem;
          box-shadow: 0 10px 30px rgba(0,0,0,.4); text-align: center; }
  .card img { width: 48px; height: 48px; }
  h1 { font-size: 1.25rem; margin: .75rem 0 1.25rem; color: var(--fg); }
  input { width: 100%; box-sizing: border-box; padding: .6rem .75rem; border: 1px solid var(--border);
          border-radius: 8px; font-size: 1rem; background: var(--bg); color: var(--fg); }
  button { width: 100%; margin-top: .75rem; padding: .6rem; border: 0; border-radius: 8px;
           background: var(--accent); color: #fff; font-size: 1rem; cursor: pointer; }
  button:hover { background: var(--accent-hover); }
  .err { color: var(--danger); font-size: .875rem; min-height: 1.25rem; margin: .5rem 0 0; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <img src="/logo.svg" alt="">
    <h1>agentpeek</h1>
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <p class="err">__ERROR__</p>
    <button type="submit">Log in</button>
  </form>
</body>
</html>"""


def _login_page(error: str = "") -> str:
    return LOGIN_PAGE.replace("__ERROR__", error)


# Reuses the login page's <style> (same :root/.card/etc.), with two fields.
CHANGE_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentpeek — set a new password</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<style>
  :root {
    --bg: #0b0e14; --card: #11151f; --fg: #d7dce5; --border: #232a3a;
    --accent: #2563eb; --accent-hover: #1d4ed8; --danger: #e05c5c;
  }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: var(--bg); font-family: system-ui, sans-serif; }
  .card { background: var(--card); border-radius: 12px; padding: 2rem 2.5rem; width: 20rem;
          box-shadow: 0 10px 30px rgba(0,0,0,.4); text-align: center; }
  .card img { width: 48px; height: 48px; }
  h1 { font-size: 1.25rem; margin: .75rem 0 .5rem; color: var(--fg); }
  .hint { color: #9aa4b2; font-size: .85rem; margin: 0 0 1.1rem; }
  input { width: 100%; box-sizing: border-box; margin-top: .5rem; padding: .6rem .75rem;
          border: 1px solid var(--border); border-radius: 8px; font-size: 1rem;
          background: var(--bg); color: var(--fg); }
  button { width: 100%; margin-top: .75rem; padding: .6rem; border: 0; border-radius: 8px;
           background: var(--accent); color: #fff; font-size: 1rem; cursor: pointer; }
  button:hover { background: var(--accent-hover); }
  .err { color: var(--danger); font-size: .875rem; min-height: 1.25rem; margin: .5rem 0 0; }
</style>
</head>
<body>
  <form class="card" method="post" action="/change-password">
    <img src="/logo.svg" alt="">
    <h1>Set a new password</h1>
    <p class="hint">You're signed in with a temporary password. Choose a new one to continue.</p>
    <input type="password" name="password" placeholder="New password" autofocus autocomplete="new-password">
    <input type="password" name="confirm" placeholder="Confirm new password" autocomplete="new-password">
    <p class="err">__ERROR__</p>
    <button type="submit">Save and continue</button>
  </form>
</body>
</html>"""


def _change_page(error: str = "") -> str:
    return CHANGE_PAGE.replace("__ERROR__", error)


def install_auth(app) -> None:
    """Register the auth middleware and the /login + /logout routes on `app`.
    Call this BEFORE mounting the catch-all StaticFiles at '/'."""

    @app.middleware("http")
    async def require_auth(request: Request, call_next):
        path = request.url.path
        if AUTH_ENABLED and path not in AUTH_EXEMPT_PATHS:
            if not request_authorized(request):
                if "text/html" in request.headers.get("accept", ""):
                    return RedirectResponse("/login", status_code=303)
                return JSONResponse({"detail": "Not authenticated"}, status_code=401)
            # Authenticated but still on a temporary password → change it first.
            if PASSWORD_MUST_CHANGE and path != "/change-password":
                if "text/html" in request.headers.get("accept", ""):
                    return RedirectResponse("/change-password", status_code=303)
                return JSONResponse({"detail": "Password change required"}, status_code=403)
        return await call_next(request)

    @app.get("/login", response_class=HTMLResponse)
    def login_page():
        if not AUTH_ENABLED:
            return RedirectResponse("/", status_code=303)
        return _login_page()

    @app.post("/login")
    def login(request: Request, password: str = Form("")):
        if not AUTH_ENABLED:
            return RedirectResponse("/", status_code=303)
        ip = _client_ip(request)
        now = time.time()
        count, locked_until = _login_failures.get(ip, (0, 0.0))
        if now < locked_until:
            return HTMLResponse(
                _login_page("Too many attempts — try again in a few minutes."),
                status_code=429,
            )
        if not (PASSWORD_HASH and verify_password(password, PASSWORD_HASH)):
            time.sleep(0.5)  # slow brute force; sync handler keeps the event loop free
            count += 1
            locked = now + LOGIN_LOCKOUT_SECONDS if count >= LOGIN_MAX_FAILURES else 0.0
            _login_failures[ip] = (count, locked)
            return HTMLResponse(_login_page("Wrong password."), status_code=401)
        _login_failures.pop(ip, None)
        resp = RedirectResponse("/", status_code=303)
        secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        resp.set_cookie(
            SESSION_COOKIE, _sign_session(int(now) + SESSION_TTL),
            max_age=SESSION_TTL, httponly=True, samesite="lax", secure=secure,
        )
        return resp

    @app.post("/logout")
    def logout():
        resp = RedirectResponse("/login", status_code=303)
        resp.delete_cookie(SESSION_COOKIE)
        return resp

    @app.get("/change-password", response_class=HTMLResponse)
    def change_password_page(request: Request):
        if not AUTH_ENABLED or not PASSWORD_MUST_CHANGE:
            return RedirectResponse("/", status_code=303)
        if not request_authorized(request):
            return RedirectResponse("/login", status_code=303)
        return _change_page()

    @app.post("/change-password")
    def change_password(request: Request, password: str = Form(""), confirm: str = Form("")):
        global PASSWORD_HASH, PASSWORD_MUST_CHANGE
        if not AUTH_ENABLED or not PASSWORD_MUST_CHANGE:
            return RedirectResponse("/", status_code=303)
        if not request_authorized(request):
            return RedirectResponse("/login", status_code=303)
        if len(password) < MIN_PASSWORD_LEN:
            return HTMLResponse(
                _change_page(f"Use at least {MIN_PASSWORD_LEN} characters."), status_code=400)
        if password != confirm:
            return HTMLResponse(_change_page("Passwords didn't match."), status_code=400)
        if verify_password(password, PASSWORD_HASH):
            return HTMLResponse(
                _change_page("Pick a password different from the temporary one."),
                status_code=400)
        new_hash = hash_password(password)
        # Persist the new hash and drop the must-change flag (env file + os.environ).
        from . import claude_auth
        claude_auth._upsert_env({
            "AGENTPEEK_PASSWORD_HASH": new_hash,
            "AGENTPEEK_PASSWORD_MUST_CHANGE": None,
        })
        PASSWORD_HASH = new_hash
        PASSWORD_MUST_CHANGE = False
        try:
            INITIAL_PW_FILE.unlink()  # the temporary password is no longer valid
        except OSError:
            pass
        return RedirectResponse("/", status_code=303)
