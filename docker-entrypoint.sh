#!/usr/bin/env bash
# agentpeek container entrypoint. Replaces the systemd/launchd supervisor: starts
# the tmux server, the ttyd terminal bridge (internal), then the web app in the
# foreground (PID 1 via tini, so signals/shutdown work).
set -euo pipefail

# Load the optional secrets file if it was mounted/created (password hash, tokens).
# Read literally — the PBKDF2 hash contains '$', which a `source` would mangle.
ENV_FILE="${HOME}/.config/agentpeek/agentpeek.env"
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    export "$line"
  done < "$ENV_FILE"
fi

PORT="${AGENTPEEK_PORT:-8090}"
TTYD_PORT="${AGENTPEEK_TTYD_PORT:-7681}"

# Use a dedicated tmux socket (the app, the attach bridge, and the server all
# agree via this var). Matches the systemd/launchd setups, so behaviour is the
# same everywhere; here it also means a single, predictable server per container.
export AGENTPEEK_TMUX_SOCKET="${AGENTPEEK_TMUX_SOCKET:-agentpeek}"

# The dedicated server starts with `-f agentpeek-server.tmux.conf`, which sources
# ~/.tmux.conf — so make that pull in agentpeek's session settings (status off,
# scrollback, clipboard). Idempotent.
TMUX_RC="${HOME}/.tmux.conf"
SOURCE_LINE="source-file /app/conf/agentpeek.tmux.conf"
touch "$TMUX_RC"
grep -qF "$SOURCE_LINE" "$TMUX_RC" || printf '\n%s\n' "$SOURCE_LINE" >> "$TMUX_RC"

# Dedicated tmux server (own socket, exit-empty off — no placeholder session).
tmux -L "$AGENTPEEK_TMUX_SOCKET" -f /app/conf/agentpeek-server.tmux.conf start-server

# ttyd terminal bridge — internal only; the app reverse-proxies /term to it.
# agentpeek-attach reads AGENTPEEK_TMUX_SOCKET (exported above).
ttyd --port "$TTYD_PORT" --interface 127.0.0.1 --writable \
     --url-arg --base-path /term \
     -t scrollback=10000 -t disableLeaveAlert=true \
     /app/bin/agentpeek-attach &

# Web app in the foreground. Binds 0.0.0.0 INSIDE the container; what the world
# can reach is controlled by how you publish the port (Tailscale-only advised).
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
