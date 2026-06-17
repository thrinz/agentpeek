#!/bin/bash
# agentpeek cloud bootstrap — paste into the "User Data" field when creating a
# Linode (Metadata-enabled regions) or DigitalOcean droplet. Ubuntu 22.04/24.04.
#
# It installs agentpeek as root and (optionally) joins your tailnet and serves it
# over HTTPS, tailnet-only. Edit the three variables below before deploying, or
# inject them via your provider's templating. For the Linode Marketplace, use the
# StackScript variant (deploy/linode-stackscript.sh) which exposes these as UDF
# fields in Cloud Manager instead of hard-coded values.
set -euxo pipefail

# --- configure -------------------------------------------------------------
# Tailscale auth key (tskey-auth-...). Leave blank to skip Tailscale entirely —
# the box will then only be reachable on 127.0.0.1 (e.g. via an SSH tunnel).
# Generate one at https://login.tailscale.com/admin/settings/keys (use an
# ephemeral/reusable key as you prefer; pre-authorized recommended).
TS_AUTHKEY="${TS_AUTHKEY:-}"

# Browser login password. Leave blank to auto-generate a strong temporary one
# (printed to the cloud-init log and saved to /root/.config/agentpeek/initial-password.txt;
# you're forced to change it on first login).
AGENTPEEK_PASSWORD="${AGENTPEEK_PASSWORD:-}"

# HTTPS port for `tailscale serve` (443 is often taken; 9443 is a safe default).
TS_SERVE_PORT="${TS_SERVE_PORT:-9443}"
# ---------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
# setup.sh runs under `set -u` and references $USER/$HOME; cloud-init's runcmd
# environment may not set them.
export HOME=/root USER=root

apt-get update -qq
# setup.sh installs tmux/curl/python3-venv itself; we only need git to clone.
apt-get install -y git ca-certificates curl

cd /root
[ -d agentpeek ] || git clone https://github.com/thrinz/agentpeek.git
cd agentpeek

# setup.sh installs systemd *user* services for root and enables linger. Bring
# root's user-systemd manager up first, or `systemctl --user` can't reach its bus.
loginctl enable-linger root
for _ in $(seq 1 30); do [ -S /run/user/0/bus ] && break; sleep 1; done
export XDG_RUNTIME_DIR=/run/user/0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus

# Join the tailnet ourselves — setup.sh's Tailscale step can't run `tailscale up`
# non-interactively. --ssh lets you reach the box over Tailscale SSH too.
if [ -n "$TS_AUTHKEY" ]; then
  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up --authkey "$TS_AUTHKEY" --ssh
fi

# Install agentpeek non-interactively. We handle Tailscale above, so tell setup.sh
# to skip its own prompt. Empty AGENTPEEK_PASSWORD -> setup.sh generates a temp one.
AGENTPEEK_INSTALL_TAILSCALE=0 \
AGENTPEEK_PASSWORD="$AGENTPEEK_PASSWORD" \
  ./setup.sh

# Expose on the tailnet over HTTPS (tailnet-only — never the public internet).
if [ -n "$TS_AUTHKEY" ]; then
  tailscale serve --bg --https="$TS_SERVE_PORT" http://127.0.0.1:8090
  host="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
  echo "agentpeek: https://${host:-<your-host>.<tailnet>.ts.net}:${TS_SERVE_PORT}" > /etc/motd
fi

echo "agentpeek bootstrap complete."
