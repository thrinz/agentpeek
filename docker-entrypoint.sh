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

# tmux server holding a 'main' session so the server is always up (-A: idempotent).
tmux new-session -A -d -s main
tmux source-file /app/conf/agentpeek.tmux.conf 2>/dev/null || true

# ttyd terminal bridge — internal only; the app reverse-proxies /term to it.
ttyd --port "$TTYD_PORT" --interface 127.0.0.1 --writable \
     --url-arg --base-path /term \
     -t scrollback=10000 -t disableLeaveAlert=true \
     /app/bin/agentpeek-attach &

# Web app in the foreground. Binds 0.0.0.0 INSIDE the container; what the world
# can reach is controlled by how you publish the port (Tailscale-only advised).
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
