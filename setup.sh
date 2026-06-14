#!/usr/bin/env bash
# agentpeek one-shot setup. Idempotent — safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 0/5 prerequisites"
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

echo "==> 1/5 ttyd"
if ! command -v ttyd >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  curl -fsSL -o "$HOME/.local/bin/ttyd" \
    "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64"
  chmod +x "$HOME/.local/bin/ttyd"
fi
TTYD="$(command -v ttyd || echo "$HOME/.local/bin/ttyd")"
echo "    ttyd: $TTYD ($("$TTYD" --version))"

echo "==> 2/5 python venv"
if [[ ! -x "$REPO/.venv/bin/pip" ]]; then
  python3 -m venv "$REPO/.venv"
fi
"$REPO/.venv/bin/pip" install -q -r "$REPO/requirements.txt"

echo "==> 3/5 tmux config"
SOURCE_LINE="source-file $REPO/conf/agentpeek.tmux.conf"
touch "$HOME/.tmux.conf"
if ! grep -qF "$SOURCE_LINE" "$HOME/.tmux.conf"; then
  printf '\n# agentpeek (browser terminal session manager)\n%s\n' "$SOURCE_LINE" >> "$HOME/.tmux.conf"
fi
# Apply to an already-running server too (no-op if none is running)
tmux source-file "$REPO/conf/agentpeek.tmux.conf" 2>/dev/null || true

echo "==> 4/5 systemd user services"
mkdir -p "$HOME/.config/systemd/user"
for unit in agentpeek-tmux agentpeek-ttyd agentpeek; do
  sed -e "s|@REPO@|$REPO|g" -e "s|@TTYD@|$TTYD|g" \
    "$REPO/systemd/$unit.service" > "$HOME/.config/systemd/user/$unit.service"
done
systemctl --user daemon-reload
systemctl --user enable --now agentpeek-tmux agentpeek-ttyd agentpeek

echo "==> 5/5 linger (start services at WSL2 boot, without a login)"
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "    !! could not enable linger; run manually: sudo loginctl enable-linger $USER"
fi

echo
echo "agentpeek is up:  http://127.0.0.1:8090"
echo "Expose on the tailnet (HTTPS, tailnet-only):"
echo "    tailscale serve --bg --https=9443 http://127.0.0.1:8090"

# These can't be auto-installed safely — flag them if missing.
if ! command -v claude >/dev/null 2>&1; then
  echo
  echo "Note: UI (Claude chat) mode needs the 'claude' CLI, which isn't installed."
  echo "      Install Claude Code (e.g. npm install -g @anthropic-ai/claude-code, or see"
  echo "      https://docs.claude.com/claude-code), then sign in from agentpeek's Claude chip."
fi
if ! command -v tailscale >/dev/null 2>&1; then
  echo
  echo "Note: for remote/mobile access, install Tailscale and run 'tailscale up':"
  echo "      curl -fsSL https://tailscale.com/install.sh | sh"
fi
