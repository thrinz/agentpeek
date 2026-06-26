# syntax=docker/dockerfile:1
# agentpeek — browser tmux session manager + Claude chat, in one container.
# Multi-arch: buildx provides TARGETARCH (amd64|arm64); ttyd is fetched per-arch
# so the image runs on Intel/AMD, Apple Silicon, and arm64 servers alike.
#
# Build (multi-arch):
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/agentpeek:latest --push .
# Run (Tailscale-only is the intended exposure — see docker-compose.yml):
#   docker run --rm -p 127.0.0.1:8090:8090 \
#     -v "$HOME/projects:/root/projects" \
#     -v agentpeek-config:/root/.config/agentpeek \
#     -v agentpeek-claude:/root/.claude \
#     -e ANTHROPIC_API_KEY=sk-ant-... <registry>/agentpeek:latest
FROM python:3.12-slim

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# tmux (the multiplexer), curl/ca-certs (downloads + healthcheck), git (agents
# often need it), tini (clean PID 1 / signal handling for the entrypoint).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux curl ca-certificates git tini unzip \
 && rm -rf /var/lib/apt/lists/*

# ttyd: arch-matched release binary (no amd64 hardcode like setup.sh uses).
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) TTYD_ARCH=x86_64 ;; \
      arm64) TTYD_ARCH=aarch64 ;; \
      arm)   TTYD_ARCH=arm ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}"; \
    chmod +x /usr/local/bin/ttyd; \
    ttyd --version

# Claude Code CLI — needed for UI (chat) mode and the 'claude' launcher. The
# native installer detects arch (linux-x64 / linux-arm64) and drops a binary in
# ~/.local/bin. Non-fatal if it fails: terminal mode still works without it.
RUN curl -fsSL https://claude.ai/install.sh | bash \
 || echo "WARN: claude install failed at build time — UI mode needs it; install at runtime"

# tmux opens terminal panes as LOGIN shells, which source /etc/profile and reset
# PATH to the system default — dropping ~/.local/bin where the claude CLI lives,
# so `claude` (and `cds`, which calls it) aren't found in terminal sessions. (UI
# chat mode is unaffected: it inherits PATH from the app process.) Re-add
# ~/.local/bin for login + interactive shells.
RUN PLINE='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH";; esac'; \
    printf '%s\n' "$PLINE" > /etc/profile.d/agentpeek-path.sh; \
    printf '%s\n' "$PLINE" >> /etc/bash.bashrc

WORKDIR /app

# Python deps first for layer caching.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# App source.
COPY . .

# 'cds' launcher (the AI start-option types this into a new shell).
RUN install -m 755 bin/cds /usr/local/bin/cds

ENV PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    AGENTPEEK_PORT=8090 \
    AGENTPEEK_TTYD_PORT=7681 \
    DIRS_ROOT_DEFAULT=/root/projects \
    DOCKER_CONTAINER=1 \
    # Claude refuses --dangerously-skip-permissions as root unless this is set;
    # the container IS the sandbox, so opt in (same as setup.sh does for root).
    IS_SANDBOX=1

# Volume mount points: the agent's working tree, the app config/secrets, and
# Claude's auth — declare them so state persists across container restarts.
RUN mkdir -p /root/projects /root/.config/agentpeek /root/.claude
VOLUME ["/root/projects", "/root/.config/agentpeek", "/root/.claude"]

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${AGENTPEEK_PORT}/login" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
