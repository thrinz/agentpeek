#!/usr/bin/env bash
# agentpeek one-shot setup. Idempotent — safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
if ! command -v ttyd >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  curl -fsSL -o "$HOME/.local/bin/ttyd" \
    "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64"
  chmod +x "$HOME/.local/bin/ttyd"
fi
TTYD="$(command -v ttyd || echo "$HOME/.local/bin/ttyd")"
echo "    ttyd: $TTYD ($("$TTYD" --version))"

echo "==> 2/6 Claude Code"
# Needed for UI (chat) mode, and for the default 'claude' terminal launcher.
# Native installer — standalone binary to ~/.local/bin, no Node/npm required.
if ! command -v claude >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/claude" ]]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
# The installer puts it in ~/.local/bin; make sure it's reachable in this script
# and in the user's shells from here on.
export PATH="$HOME/.local/bin:$PATH"
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
    "$REPO/systemd/$unit.service" > "$HOME/.config/systemd/user/$unit.service"
done
systemctl --user daemon-reload
systemctl --user enable --now agentpeek-tmux agentpeek-ttyd agentpeek

echo "==> 6/6 linger (start services at WSL2 boot, without a login)"
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "    !! could not enable linger; run manually: sudo loginctl enable-linger $USER"
fi

ENV_FILE="$HOME/.config/agentpeek/agentpeek.env"

echo
echo "============================================================"
echo " agentpeek is running — open it at:"
echo
echo "     http://localhost:8090     (http://127.0.0.1:8090)"
echo
echo " It's a systemd user service, so it auto-starts on boot. Manage it with:"
echo "     systemctl --user status  agentpeek"
echo "     systemctl --user restart agentpeek"
echo "     journalctl --user -u agentpeek -f      # live logs"
echo "============================================================"

echo
echo "Set a password (recommended before exposing it anywhere)."
echo "agentpeek is open by default on localhost/tailnet; add a login like this:"
echo "    \"$REPO/.venv/bin/python\" -m app hash-password   # prints a hash"
echo "    mkdir -p \"$(dirname "$ENV_FILE")\""
echo "    echo 'AGENTPEEK_PASSWORD_HASH=<paste-the-hash>' >> \"$ENV_FILE\""
echo "    echo \"AGENTPEEK_SECRET=\$(openssl rand -hex 32)\" >> \"$ENV_FILE\"   # keeps logins across restarts"
echo "    systemctl --user restart agentpeek"
echo "(For scripts/automation you can add AGENTPEEK_TOKEN=<token> and send it as 'Authorization: Bearer'.)"

echo
echo "Expose on the tailnet (HTTPS, tailnet-only — never the public internet):"
echo "    tailscale serve --bg --https=9443 http://127.0.0.1:8090"

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
    echo "    then expose agentpeek:            tailscale serve --bg --https=9443 http://127.0.0.1:8090"
  else
    echo
    echo "Note: for remote/mobile access, install Tailscale and run 'tailscale up':"
    echo "      curl -fsSL https://tailscale.com/install.sh | sh"
  fi
fi
