#!/bin/bash
# agentpeek — Linode StackScript. This is the deploy script the Linode Marketplace
# is built on: create it in Cloud Manager (StackScripts -> Create), or submit it to
# the official Marketplace (see deploy/MARKETPLACE.md). The UDF tags below render as
# input fields in the Linode "Create" flow and arrive as environment variables.
#
# <UDF name="AGENTPEEK_PASSWORD" label="agentpeek login password" default="" example="Leave blank to auto-generate a temporary one (you set your own on first login)." />
# <UDF name="TS_AUTHKEY" label="Tailscale auth key (tskey-auth-...)" default="" example="Optional. Joins your tailnet and serves agentpeek over HTTPS. Blank = 127.0.0.1 only." />
# <UDF name="TS_SERVE_PORT" label="Tailscale HTTPS serve port" default="9443" />
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
export HOME=/root USER=root

apt-get update -qq
apt-get install -y git ca-certificates curl

cd /root
[ -d agentpeek ] || git clone https://github.com/thrinz/agentpeek.git
cd agentpeek

# Bring root's user-systemd manager up before setup.sh runs `systemctl --user`.
loginctl enable-linger root
for _ in $(seq 1 30); do [ -S /run/user/0/bus ] && break; sleep 1; done
export XDG_RUNTIME_DIR=/run/user/0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus

if [ -n "${TS_AUTHKEY:-}" ]; then
  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up --authkey "$TS_AUTHKEY" --ssh
fi

AGENTPEEK_INSTALL_TAILSCALE=0 \
AGENTPEEK_PASSWORD="${AGENTPEEK_PASSWORD:-}" \
  ./setup.sh

if [ -n "${TS_AUTHKEY:-}" ]; then
  tailscale serve --bg --https="${TS_SERVE_PORT:-9443}" http://127.0.0.1:8090
fi

echo "agentpeek bootstrap complete."
