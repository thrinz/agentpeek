#!/usr/bin/env bash
# agentpeek one-shot setup. Idempotent — safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ttyd and the claude CLI install to ~/.local/bin, which may not be on PATH in a
# non-login shell — put it on PATH up front so re-runs detect them and skip reinstall.
export PATH="$HOME/.local/bin:$PATH"

# Ports are configurable so agentpeek can coexist with another service (or another
# WSL distro sharing localhost): AGENTPEEK_PORT=9090 AGENTPEEK_TTYD_PORT=9091 ./setup.sh
PORT="${AGENTPEEK_PORT:-8090}"
TTYD_PORT="${AGENTPEEK_TTYD_PORT:-7681}"

# Refuse to run from a Windows drive (/mnt/c, …). DrvFs is slow, has no real Unix
# permissions/ownership, and breaks the venv, chmod, and systemd units that bake in
# @REPO@ paths. Set AGENTPEEK_ALLOW_MNT=1 to override (not recommended).
if [[ "$REPO" == /mnt/* && "${AGENTPEEK_ALLOW_MNT:-}" != "1" ]]; then
  cat >&2 <<MSG
    !! agentpeek is on a Windows drive ($REPO).
       Run it from the Linux filesystem instead — clone into your home dir:

           cd ~ && git clone https://github.com/thrinz/agentpeek.git && cd agentpeek && ./setup.sh

       (Set AGENTPEEK_ALLOW_MNT=1 to override, but expect slow I/O and permission issues.)
MSG
  exit 1
fi

echo "==> 0/6 prerequisites"
# Python 3.10+ is required (fastapi/claude-agent-sdk). We don't upgrade Python —
# that's a system-level decision — so fail clearly instead of dying inside pip.
if ! command -v python3 >/dev/null 2>&1; then
  echo "    !! python3 not found — install Python 3.10+ and re-run." >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "    !! Python $(python3 -c 'import platform; print(platform.python_version())') is too old — agentpeek needs 3.10+." >&2
  echo "       Install a newer Python (e.g. the deadsnakes PPA on Ubuntu), then re-run." >&2
  exit 1
fi
# Packages agentpeek needs that a fresh Debian/Ubuntu (incl. WSL2) often lacks.
need=()
command -v tmux >/dev/null 2>&1 || need+=(tmux)
command -v curl >/dev/null 2>&1 || need+=(curl)
python3 -c 'import ensurepip' 2>/dev/null || need+=(python3-venv)
if [[ ${#need[@]} -gt 0 ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "    installing (sudo): ${need[*]}"
    sudo apt-get update -qq && sudo apt-get install -y "${need[@]}"
  else
    echo "    !! missing: ${need[*]} — install them with your package manager, then re-run." >&2
    exit 1
  fi
fi
# The user services need systemd. On WSL2 it must be enabled explicitly.
if [[ ! -d /run/systemd/system ]]; then
  cat >&2 <<'MSG'
    !! systemd is not running — agentpeek's services need it.
       On WSL2: add the following to /etc/wsl.conf, then run `wsl --shutdown`
       in Windows (PowerShell) and reopen the terminal:

           [boot]
           systemd=true

MSG
  exit 1
fi

echo "==> 1/6 ttyd"
# Skip if ttyd is already on PATH *or* already at ~/.local/bin (which may not be
# on a re-run's PATH). Download to a temp file and mv into place — a plain curl -o
# over a running ttyd fails with "text file busy" (curl error 23).
if ! command -v ttyd >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/ttyd" ]]; then
  mkdir -p "$HOME/.local/bin"
  tmp_ttyd="$(mktemp)"
  curl -fsSL -o "$tmp_ttyd" \
    "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64"
  chmod +x "$tmp_ttyd"
  mv -f "$tmp_ttyd" "$HOME/.local/bin/ttyd"
fi
TTYD="$(command -v ttyd || echo "$HOME/.local/bin/ttyd")"
echo "    ttyd: $TTYD ($("$TTYD" --version))"

echo "==> 2/6 Claude Code"
# Needed for UI (chat) mode, and for the default 'claude' terminal launcher.
# Native installer — standalone binary to ~/.local/bin, no Node/npm required.
if ! command -v claude >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/claude" ]]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
# hash -r so a claude just installed into the already-on-PATH ~/.local/bin is found.
hash -r 2>/dev/null || true
if command -v claude >/dev/null 2>&1; then
  echo "    claude: $(command -v claude) ($(claude --version 2>/dev/null || echo '?'))"
else
  echo "    !! claude install did not complete — UI mode and the 'claude' launcher" >&2
  echo "       won't work until it's installed (see https://docs.claude.com/claude-code)." >&2
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
# Apply to an already-running server too (no-op if none is running)
tmux source-file "$REPO/conf/agentpeek.tmux.conf" 2>/dev/null || true

echo "==> 5/6 systemd user services"
mkdir -p "$HOME/.config/systemd/user"
for unit in agentpeek-tmux agentpeek-ttyd agentpeek; do
  sed -e "s|@REPO@|$REPO|g" -e "s|@TTYD@|$TTYD|g" \
      -e "s|@PORT@|$PORT|g" -e "s|@TTYD_PORT@|$TTYD_PORT|g" \
    "$REPO/systemd/$unit.service" > "$HOME/.config/systemd/user/$unit.service"
done
systemctl --user daemon-reload
systemctl --user enable agentpeek-tmux agentpeek-ttyd agentpeek
# tmux is a oneshot that holds the session server — start it if down, but never
# restart it (that kills the tmux server and every session in it).
systemctl --user start agentpeek-tmux
# Restart the web app + terminal bridge so a re-run frees the ports, picks
# up unit/code changes, and replaces any old instance still holding the port.
systemctl --user restart agentpeek-ttyd agentpeek
# Surface a real startup failure instead of silently continuing. Type=simple
# reports "active" the moment uvicorn forks, so wait a beat: a bind failure trips
# Restart=on-failure (RestartSec=2) and the unit drops out of "active".
sleep 3
if ! systemctl --user is-active --quiet agentpeek; then
  echo "    !! agentpeek failed to start. Recent logs:" >&2
  journalctl --user -u agentpeek --no-pager -n 15 >&2 || true
  # Most failures here are 'address already in use' — show what holds the ports
  # (e.g. a predecessor like webterm, or another user's instance).
  holder="$(ss -ltnp 2>/dev/null | grep -E ":$PORT|:$TTYD_PORT" || true)"
  if [[ -n "$holder" ]]; then
    echo "    Ports $PORT/$TTYD_PORT are already in use by:" >&2
    echo "$holder" >&2
    echo "    Stop the other listener (e.g. 'systemctl --user disable --now <unit>'), then re-run." >&2
  fi
  exit 1
fi

echo "==> 6/6 linger (start services at WSL2 boot, without a login)"
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "    !! could not enable linger; run manually: sudo loginctl enable-linger $USER"
fi

ENV_FILE="$HOME/.config/agentpeek/agentpeek.env"

# Upsert KEY=VALUE in the env file without a shell parsing the value (the hash
# contains '$'). Replaces an existing KEY= line, else appends.
set_env_kv() {
  local key="$1" val="$2"
  mkdir -p "$(dirname "$ENV_FILE")"; chmod 700 "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  local tmp; tmp="$(mktemp)"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}

# === login password ========================================================
# agentpeek is open by default on localhost/tailnet. Offer to set a login now.
# AGENTPEEK_PASSWORD=... sets it non-interactively (handy for automated retests).
AUTH_ON=0
if grep -q '^AGENTPEEK_PASSWORD_HASH=' "$ENV_FILE" 2>/dev/null; then AUTH_ON=1; fi

password="${AGENTPEEK_PASSWORD:-}"
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
fi

if [[ -n "$password" ]]; then
  hash="$(AGENTPEEK_PW="$password" PYTHONPATH="$REPO" "$REPO/.venv/bin/python" \
    -c 'import os; from app import auth; print(auth.hash_password(os.environ["AGENTPEEK_PW"]))')"
  set_env_kv AGENTPEEK_PASSWORD_HASH "$hash"
  # SECRET keeps logins valid across restarts; only generate once.
  if ! grep -q '^AGENTPEEK_SECRET=' "$ENV_FILE" 2>/dev/null; then
    set_env_kv AGENTPEEK_SECRET \
      "$(openssl rand -hex 32 2>/dev/null || "$REPO/.venv/bin/python" -c 'import secrets;print(secrets.token_hex(32))')"
  fi
  systemctl --user restart agentpeek
  AUTH_ON=1
  echo "    login enabled — your password is stored (hashed) in $ENV_FILE"
fi

echo
echo "============================================================"
echo " agentpeek is running — open it at:"
echo
echo "     http://localhost:$PORT     (http://127.0.0.1:$PORT)"
if [[ "$AUTH_ON" == "1" ]]; then
  echo "     (log in with the password you set)"
else
  echo "     (no login set — open on localhost/tailnet; re-run setup.sh to add one)"
fi
echo
echo " It auto-starts on boot (systemd user service). Manage it with:"
echo "     systemctl --user status  agentpeek"
echo "     systemctl --user restart agentpeek"
echo "     journalctl --user -u agentpeek -f      # live logs"
echo "============================================================"
echo "(For scripts/automation, add AGENTPEEK_TOKEN=<token> to $ENV_FILE and send"
echo " it as 'Authorization: Bearer <token>'.)"

echo
echo "Expose on the tailnet (HTTPS, tailnet-only — never the public internet):"
echo "    tailscale serve --bg --https=9443 http://127.0.0.1:$PORT"

if command -v claude >/dev/null 2>&1; then
  echo
  echo "Claude Code is installed. Sign in from agentpeek's Claude chip (or run 'claude' once)."
fi
# Tailscale gives remote/mobile access and installs system-wide (sudo), so we ask
# rather than assume. Set AGENTPEEK_INSTALL_TAILSCALE=1 (or 0) to answer without a
# prompt — e.g. when piping setup.sh through a non-interactive shell.
if ! command -v tailscale >/dev/null 2>&1; then
  install_ts="${AGENTPEEK_INSTALL_TAILSCALE:-}"
  if [[ -z "$install_ts" && -t 0 ]]; then
    read -rp $'\nInstall Tailscale now for remote/mobile access? [y/N] ' reply
    [[ "$reply" =~ ^[Yy] ]] && install_ts=1 || install_ts=0
  fi
  if [[ "$install_ts" == "1" ]]; then
    echo "    installing Tailscale (sudo)…"
    curl -fsSL https://tailscale.com/install.sh | sh
    echo "    installed. Connect this machine:  sudo tailscale up"
    echo "    then expose agentpeek:            tailscale serve --bg --https=9443 http://127.0.0.1:$PORT"
  else
    echo
    echo "Note: for remote/mobile access, install Tailscale and run 'tailscale up':"
    echo "      curl -fsSL https://tailscale.com/install.sh | sh"
  fi
fi
