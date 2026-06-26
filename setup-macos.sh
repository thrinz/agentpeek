#!/usr/bin/env bash
# agentpeek setup for macOS (launchd). Idempotent — safe to re-run.
#
# The Linux installer (setup.sh) uses apt + systemd; this is the macOS sibling:
# Homebrew for tmux/ttyd and launchd user agents (~/Library/LaunchAgents) instead
# of systemd user services. The Python app itself is identical across platforms.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"

PORT="${AGENTPEEK_PORT:-8090}"
TTYD_PORT="${AGENTPEEK_TTYD_PORT:-7681}"

ENV_FILE="$HOME/.config/agentpeek/agentpeek.env"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/agentpeek"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
LABELS=(dev.agentpeek.tmux dev.agentpeek.ttyd dev.agentpeek.app)

# Upsert KEY=VALUE in the env file without a shell parsing the value (the password
# hash contains '$'). Replaces an existing KEY= line, else appends.
set_env_kv() {
  local key="$1" val="$2"
  mkdir -p "$(dirname "$ENV_FILE")"; chmod 700 "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  local tmp; tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}

# (Re)load a launchd user agent: boot out the old instance (ignore "not loaded"),
# then bootstrap the freshly rendered plist into the GUI domain.
reload_agent() {
  local label="$1" plist="$2"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "    !! this is the macOS installer — on Linux/WSL2 use ./setup.sh instead." >&2
  exit 1
fi

echo "==> 0/6 prerequisites"
if ! command -v python3 >/dev/null 2>&1; then
  echo "    !! python3 not found — install Python 3.10+ (e.g. 'brew install python') and re-run." >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "    !! Python $(python3 -c 'import platform; print(platform.python_version())') is too old — agentpeek needs 3.10+." >&2
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "    !! Homebrew not found — install it from https://brew.sh, then re-run." >&2
  exit 1
fi
# tmux is required; ttyd is installed in step 1 (also via brew).
if ! command -v tmux >/dev/null 2>&1; then
  echo "    installing tmux (brew)…"
  brew install tmux
fi

echo "==> 1/6 ttyd"
# Homebrew build for the host arch (Apple Silicon or Intel) — the Linux release
# binary the setup.sh downloads won't run on macOS.
if ! command -v ttyd >/dev/null 2>&1; then
  echo "    installing ttyd (brew)…"
  brew install ttyd
fi
TTYD="$(command -v ttyd)"
echo "    ttyd: $TTYD ($("$TTYD" --version))"

echo "==> 2/6 Claude Code"
# Needed for UI (chat) mode and the default 'claude' terminal launcher. The
# native installer supports macOS (standalone binary to ~/.local/bin). Skip it
# entirely when claude is already installed (on PATH or at ~/.local/bin) — don't
# re-download or touch an existing install (it may be a Homebrew/npm one).
if command -v claude >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/claude" ]]; then
  echo "    claude already installed — skipping ($(command -v claude || echo "$HOME/.local/bin/claude"))"
else
  echo "    installing Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
fi
hash -r 2>/dev/null || true
if command -v claude >/dev/null 2>&1; then
  echo "    claude: $(command -v claude) ($(claude --version 2>/dev/null || echo '?'))"
else
  echo "    !! claude install did not complete — UI mode and the 'claude' launcher" >&2
  echo "       won't work until it's installed (see https://docs.claude.com/claude-code)." >&2
fi
mkdir -p "$HOME/.local/bin"
if [[ ! -e "$HOME/.local/bin/cds" ]]; then
  install -m 755 "$REPO/bin/cds" "$HOME/.local/bin/cds"
  echo "    cds: $HOME/.local/bin/cds (claude --dangerously-skip-permissions)"
else
  echo "    cds: $HOME/.local/bin/cds (kept existing)"
fi
if command -v claude >/dev/null 2>&1; then
  if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
    echo "    Claude: signed in."
  else
    echo "    Claude: not signed in yet — UI (chat) mode needs it. Sign in from"
    echo "      agentpeek's Claude chip (bottom of the sidebar), or 'claude auth login'."
  fi
fi

echo "==> 3/6 python venv"
if [[ ! -x "$REPO/.venv/bin/pip" ]]; then
  python3 -m venv "$REPO/.venv"
fi
"$REPO/.venv/bin/pip" install -q -r "$REPO/requirements.txt"

echo "==> 4/6 tmux config"
SOURCE_LINE="source-file $REPO/conf/agentpeek.tmux.conf"
touch "$HOME/.tmux.conf"
if ! grep -qF "$SOURCE_LINE" "$HOME/.tmux.conf"; then
  printf '\n# agentpeek (browser terminal session manager)\n%s\n' "$SOURCE_LINE" >> "$HOME/.tmux.conf"
fi
tmux source-file "$REPO/conf/agentpeek.tmux.conf" 2>/dev/null || true

echo "==> 5/6 launchd user agents"
mkdir -p "$LAUNCH_DIR" "$LOG_DIR"
# Bake an absolute PATH into the plists: ~/.local/bin (claude/cds), both Homebrew
# prefixes (Apple Silicon /opt/homebrew, Intel /usr/local), then the system dirs.
PATH_LINE="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
TMUX_BIN="$(command -v tmux)"
for label in "${LABELS[@]}"; do
  sed -e "s|@REPO@|$REPO|g" -e "s|@TTYD@|$TTYD|g" -e "s|@TMUX@|$TMUX_BIN|g" \
      -e "s|@PORT@|$PORT|g" -e "s|@TTYD_PORT@|$TTYD_PORT|g" \
      -e "s|@PATH@|$PATH_LINE|g" -e "s|@LOGDIR@|$LOG_DIR|g" \
    "$REPO/launchd/$label.plist" > "$LAUNCH_DIR/$label.plist"
done
# Order matters loosely (tmux server first, then ttyd, then the app); bootstrap
# each in turn. reload = bootout + bootstrap, so re-runs pick up template changes.
for label in "${LABELS[@]}"; do
  reload_agent "$label" "$LAUNCH_DIR/$label.plist"
done
# Give uvicorn a moment to bind, then verify it's actually up.
sleep 3
if ! launchctl print "$DOMAIN/dev.agentpeek.app" >/dev/null 2>&1 \
   || ! curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" 2>/dev/null; then
  echo "    !! agentpeek may not have started cleanly. Recent log:" >&2
  tail -n 20 "$LOG_DIR/app.log" 2>/dev/null >&2 || true
  echo "    A common cause is a port already in use. Check: lsof -iTCP:$PORT -sTCP:LISTEN" >&2
fi

echo "==> 6/6 start at login"
# launchd user agents with RunAtLoad start automatically when you log in — no
# 'linger' equivalent needed. (For headless start before any login you'd convert
# these to LaunchDaemons in /Library/LaunchDaemons, run by root — not done here.)
echo "    installed as login agents (~/Library/LaunchAgents)."

# === login password ========================================================
# Same policy as setup.sh: explicit AGENTPEEK_PASSWORD, else prompt on a TTY,
# else generate one (headless), unless AGENTPEEK_NO_PASSWORD=1.
AUTH_ON=0
if grep -q '^AGENTPEEK_PASSWORD_HASH=' "$ENV_FILE" 2>/dev/null; then AUTH_ON=1; fi

password="${AGENTPEEK_PASSWORD:-}"
generated=""
if [[ -z "$password" && -t 0 ]]; then
  echo
  if [[ "$AUTH_ON" == "1" ]]; then
    read -rp "A login password is already set. Replace it? [y/N] " ans
    [[ "$ans" =~ ^[Yy] ]] || ans="skip"
  else
    read -rp "Set a browser login password now? (recommended) [Y/n] " ans
    if [[ "$ans" =~ ^[Nn] ]]; then ans="skip"; fi
  fi
  if [[ "$ans" != "skip" ]]; then
    while true; do
      read -rsp "  Password: " p1; echo
      read -rsp "  Confirm:  " p2; echo
      if [[ -z "$p1" ]]; then echo "  (empty — skipping)"; break; fi
      if [[ "$p1" != "$p2" ]]; then echo "  passwords didn't match — try again"; continue; fi
      password="$p1"; break
    done
  fi
elif [[ -z "$password" && "$AUTH_ON" == "0" && "${AGENTPEEK_NO_PASSWORD:-}" != "1" ]]; then
  password="$(openssl rand -hex 12 2>/dev/null \
    || "$REPO/.venv/bin/python" -c 'import secrets;print(secrets.token_hex(12))')"
  generated="$password"
fi

if [[ -n "$password" ]]; then
  hash="$(AGENTPEEK_PW="$password" PYTHONPATH="$REPO" "$REPO/.venv/bin/python" \
    -c 'import os; from app import auth; print(auth.hash_password(os.environ["AGENTPEEK_PW"]))')"
  set_env_kv AGENTPEEK_PASSWORD_HASH "$hash"
  if ! grep -q '^AGENTPEEK_SECRET=' "$ENV_FILE" 2>/dev/null; then
    set_env_kv AGENTPEEK_SECRET \
      "$(openssl rand -hex 32 2>/dev/null || "$REPO/.venv/bin/python" -c 'import secrets;print(secrets.token_hex(32))')"
  fi
  if [[ -n "$generated" ]]; then
    set_env_kv AGENTPEEK_PASSWORD_MUST_CHANGE 1
  elif grep -q '^AGENTPEEK_PASSWORD_MUST_CHANGE=1' "$ENV_FILE" 2>/dev/null; then
    set_env_kv AGENTPEEK_PASSWORD_MUST_CHANGE ""
  fi
  # Restart just the web app so it re-reads the env file with the new password.
  launchctl kickstart -k "$DOMAIN/dev.agentpeek.app" 2>/dev/null || true
  AUTH_ON=1
  if [[ -n "$generated" ]]; then
    pwfile="$HOME/.config/agentpeek/initial-password.txt"
    printf '%s\n' "$generated" > "$pwfile"; chmod 600 "$pwfile"
    echo "    no TTY to prompt — generated a temporary login password:"
    echo "        $generated"
    echo "    You'll be asked to set your own on first login. (Also saved to $pwfile.)"
  else
    echo "    login enabled — your password is stored (hashed) in $ENV_FILE"
  fi
fi

echo
echo "============================================================"
echo " agentpeek is running — open it at:"
echo
echo "     http://localhost:$PORT     (http://127.0.0.1:$PORT)"
if [[ "$AUTH_ON" == "1" ]]; then
  echo "     (log in with the password you set)"
else
  echo "     (no login set — open on localhost/tailnet; re-run setup-macos.sh to add one)"
fi
echo
echo " It auto-starts at login (launchd user agent). Manage it with:"
echo "     launchctl kickstart -k $DOMAIN/dev.agentpeek.app   # restart"
echo "     launchctl print $DOMAIN/dev.agentpeek.app          # status"
echo "     tail -f \"$LOG_DIR/app.log\"                          # live logs"
echo "     launchctl bootout $DOMAIN/dev.agentpeek.app        # stop"
echo "============================================================"
echo "(For scripts/automation, add AGENTPEEK_TOKEN=<token> to $ENV_FILE and send"
echo " it as 'Authorization: Bearer <token>'.)"
echo
echo "Remote/mobile access: install Tailscale for macOS (https://tailscale.com/download),"
echo "then expose it tailnet-only:  tailscale serve --bg --https=9443 http://127.0.0.1:$PORT"
