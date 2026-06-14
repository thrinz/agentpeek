#!/usr/bin/env bash
# agentpeek one-shot setup. Idempotent — safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
