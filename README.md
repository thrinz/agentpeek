<p align="center">
  <img src="static/logo.svg" width="72" alt="agentpeek"><br>
  <b>agentpeek</b>
</p>

<h1 align="center">Persistent Claude Code sessions in your browser</h1>

<p align="center">
  agentpeek is the free, self-hosted <b>browser control panel for Claude Code</b>.
  Start a session on your Linux/WSL2 box, drive it as a terminal or a chat, and
  reach it from any browser over your tailnet — it keeps working when you close
  the laptop.
</p>

You start Claude Code (or any shell) in a session, close the laptop, and it
keeps working. Open the same browser tab from another machine and you're right
back in it — the session never stopped. Sessions are plain named `tmux`
sessions, so the exact same ones are reachable over SSH with `tmux attach`.

agentpeek is where the work happens: you drive the AI agents that **generate
your content** — docs, code, reports, sites. Its companion
**[filepeek](https://github.com/thrinz/filepeek)** is the downstream viewer that
renders the `.md`/`.html`/`.xlsx` files those agents leave behind. See
[Companion tool](#companion-tool).

## Architecture

```
Browser ──► uvicorn/FastAPI :8090 (127.0.0.1)
              ├── /            static frontend (sidebar + iframe)
              ├── /api/...     session lifecycle REST API → tmux (app/multiplexer.py)
              └── /term/...    reverse proxy (HTTP + WebSocket) → ttyd :7681
                                 ttyd runs bin/agentpeek-attach <name>
                                   = replay history + tmux attach
```

Everything binds to `127.0.0.1` and is served from one port, so exposing it on
the tailnet is a single command (see below). The terminal iframe is
same-origin, which keeps clipboard access and `tailscale serve` simple.

- `app/multiplexer.py` — the only module that knows about tmux (swap point for
  another multiplexer).
- `bin/agentpeek-attach` — ttyd entrypoint; validates the session name, replays
  pane history (`tmux capture-pane -S -`) so browser scrollback covers output
  from before the attach, then `exec tmux attach`.
- Switching sessions in the sidebar swaps the iframe URL; the old iframe's
  WebSocket closes, ttyd reaps that `tmux attach` client, and tmux detaches it
  cleanly — the browser is never attached to two sessions.

## Setup

### Prerequisites

On a fresh **Debian/Ubuntu (incl. WSL2)**, `setup.sh` installs everything it needs
for you — the OS packages (`tmux`, `curl`, `python3-venv`) via `sudo apt`, plus
`ttyd`, **Claude Code**, and the Python deps — so it's one command. One thing it
can't do for you:

- **systemd must be enabled** — the services run under it. On WSL2, add this to
  `/etc/wsl.conf`, then run `wsl --shutdown` in Windows (PowerShell) and reopen
  your terminal:
  ```ini
  [boot]
  systemd=true
  ```
  Ubuntu 24.04 on recent WSL enables systemd by default; `setup.sh` checks and
  tells you if it's missing.

Claude Code is installed via the official native installer (a standalone binary
in `~/.local/bin`, no Node/npm). After setup, sign in from agentpeek's **Claude**
chip (or run `claude` once) — needed for **UI (chat) mode**; shell mode needs no
sign-in.

Also: you need `git` to clone the repo and Python **3.10+** (already on Ubuntu
22.04/24.04); the bundled `ttyd` binary is **x86_64**. For remote/mobile access
you need **Tailscale** — `setup.sh` offers to install it for you (or set
`AGENTPEEK_INSTALL_TAILSCALE=1`/`0` to skip the prompt).

- **[filepeek](https://github.com/thrinz/filepeek) (recommended companion)** —
  the downstream viewer that renders the `.md`/`.html`/`.xlsx`/code files your
  agents generate, so you can browse them in the browser. `setup.sh` offers to
  clone and install it next to agentpeek (or set `AGENTPEEK_INSTALL_FILEPEEK=1`/`0`
  to skip the prompt). See [Companion tool](#companion-tool).

### Install

Clone into your Linux home, **not** a Windows drive — a repo under `/mnt/c/...`
is slow and lacks real Unix permissions, so `setup.sh` refuses to run there.

```bash
cd ~ && git clone https://github.com/thrinz/agentpeek.git && cd agentpeek
./setup.sh
```

It installs the apt prerequisites (`tmux`/`curl`/`python3-venv`) and `ttyd` if
missing, installs Claude Code, creates `.venv` and installs the Python deps
(including `claude-agent-sdk`), sources `conf/agentpeek.tmux.conf` from
`~/.tmux.conf`, installs and enables three systemd **user** services (`agentpeek-tmux`,
`agentpeek-ttyd`, `agentpeek`), and enables linger so everything starts at WSL2
boot. At the end it **prompts you to set a browser login password** (hashed into
`~/.config/agentpeek/agentpeek.env`) and prints the URL — `http://localhost:8090`.
It's idempotent — safe to re-run — and offers to install Tailscale if it isn't
already present.

**Custom ports.** agentpeek uses `8090` (web) and `7681` (ttyd) by default. To run
it alongside another service — or another WSL distro that already holds those ports
on a shared `localhost` — pass different ports at setup:

```bash
AGENTPEEK_PORT=9090 AGENTPEEK_TTYD_PORT=9091 ./setup.sh
```

setup bakes them into the systemd units (the app's reverse proxy follows the ttyd
port automatically), so re-running with the same values is all it takes.

**Headless / cloud (Linode, DigitalOcean, …).** `setup.sh` runs non-interactively
when there's no TTY — every prompt has an env override, so nothing blocks:

```bash
AGENTPEEK_INSTALL_TAILSCALE=1 ./setup.sh
```

For a one-shot deploy, paste [`deploy/cloud-init.sh`](deploy/cloud-init.sh) into a
Linode/DO droplet's **User Data** field — it clones, installs, joins your tailnet
(with a Tailscale auth key), and serves agentpeek over HTTPS. See
[`deploy/MARKETPLACE.md`](deploy/MARKETPLACE.md) for the StackScript and the Linode
/ DigitalOcean Marketplace submission steps.

- **Password** — with no TTY and none set, setup **generates a strong temporary
  one**, prints it, and saves it to `~/.config/agentpeek/initial-password.txt`
  (0600). It's **one-time**: your first login is forced through a *change password*
  screen, after which the temp password and that file are discarded. Override with
  `AGENTPEEK_PASSWORD=…` (final, no forced change), or `AGENTPEEK_NO_PASSWORD=1` to
  rely on tailnet ACLs only.
- **Claude sign-in** — not done at setup (no host browser). After install, sign in
  from the **Claude chip** in the web UI, or `claude auth login` over SSH.
- **Reach it over Tailscale only** — agentpeek binds `127.0.0.1`; never expose
  `8090`/`7681` on the public interface. `tailscale serve` is the intended door.
- Cloud VMs are often **root** — setup sets `IS_SANDBOX=1` so UI mode and `cds`
  work (the agent then acts as root without per-tool prompts).

Expose on the tailnet (HTTPS, tailnet-only — never the public internet):

```bash
# pick any free https port; 9443 here because 443 was already in use on my host
tailscale serve --bg --https=9443 http://127.0.0.1:8090
# → https://<your-host>.<your-tailnet>.ts.net:9443
```

## Folders & create options

The sidebar groups sessions into collapsible **folders** you define yourself
(create them with the folder button; up to two nested levels). A **General**
folder always exists as the catch-all — sessions created from the CLI land
there. The folder is stored on the tmux session itself as the
`@agentpeek_group` session option, so it survives renames; the folder list
lives in `~/.config/agentpeek/folders.json`.

The create dialog asks for: a folder (required), a **Type** — *Shell* (a tmux
terminal) or *UI* (a Claude chat — see [UI mode](#ui-mode--claude-chat)) — a
**working directory** picked from a collapsible tree rooted at `~/projects`
(`DIRS_ROOT` in `app/main.py`), and for Shell type a **start option** (*AI* types
your launcher command into the new shell, or plain *Shell*).

> **AI start option** types `cds` into the new shell. `setup.sh` installs `cds`
> to `~/.local/bin` as `claude --dangerously-skip-permissions` (edit that file,
> or the `send-keys` command in `app/multiplexer.py`, to launch a different agent
> like `aider`). It won't overwrite an existing `cds`, so your customisation sticks.

> **Running as root?** Claude Code refuses to skip permissions as root, so UI mode
> and `cds` fail with exit 1. `setup.sh` detects root and sets `IS_SANDBOX=1` in
> the env file (and `cds` sets it too) to allow it — this lets the agent act as
> root without per-tool prompts, so prefer running agentpeek as a normal user.

For an *AI* (Shell + AI) session the create dialog also offers **“Notify my phone
when Claude finishes”** with a dropdown of remembered [ntfy](#phone-notifications-ntfy)
topics — see below.

## Phone notifications (ntfy)

Get a push on your phone every time Claude finishes a turn in a session, using
the free [ntfy.sh](https://ntfy.sh) service. Three pieces cooperate:

1. **A Claude Code Stop hook** (one-time, per machine). Add this to
   `~/.claude/settings.json` — it pushes only when `CLAUDE_NOTIFY_TOPIC` is set,
   so sessions without a topic stay silent:

   ```json
   {
     "hooks": {
       "Stop": [
         { "hooks": [
           { "type": "command",
             "command": "[ -n \"$CLAUDE_NOTIFY_TOPIC\" ] && curl -s -H \"Title: Claude Code\" -d \"Claude finished a turn in $(basename \"${CLAUDE_PROJECT_DIR:-session}\")\" \"https://ntfy.sh/$CLAUDE_NOTIFY_TOPIC\" >/dev/null 2>&1 || true",
             "async": true }
         ] }
       ]
     }
   }
   ```

2. **`cds`** sets `CLAUDE_NOTIFY_TOPIC` from its first argument — `cds` (off),
   `cds on` (uses `$CDS_NOTIFY_TOPIC`, export your default in your shell rc), or
   `cds <topic>` (a custom topic). The installed `bin/cds` already does this.

3. **The create dialog** ties it together: tick *Notify my phone*, pick or add a
   topic, and agentpeek types `cds <topic>` into the new session for you. Topics
   you add are remembered in the browser for next time.

On your phone, install the **ntfy** app (iOS/Android) and **subscribe to the same
topic name**. Topics are public unguessable strings — anyone who knows the name
can read its messages, so use something random like `claude-$(openssl rand -hex 4)`
and don't share it.

## Mobile (touch) use

On phones/tablets a **touch key bar** appears under the terminal when a Shell
session is attached, with the keys a soft keyboard can't reliably send to a
terminal: **esc, tab, ctrl** (sticky — tap it then a letter for Ctrl-combos),
**arrow keys**, **scroll** up/down, and **paste**. Every button routes through
`tmux send-keys` on the server (`POST /api/sessions/<name>/keys`), so it works
even where iOS Safari's keyboard events don't reach xterm. Pair it with
`tailscale serve --https` so the clipboard-based paste has a secure context.

## UI mode — Claude chat

A **UI** session is a chat with the **Claude Agent SDK** running in the chosen
directory — the same agent as a terminal Claude Code session (it edits files,
runs bash, uses tools), rendered as a chat instead of a terminal. It needs the
`claude` CLI installed and a [Claude connection](#claude-connection-for-ui-mode).

- **Streaming** token-by-token with a live cursor; **markdown + GFM tables +
  code** rendering with copy-code buttons; tool calls and results shown inline
  (collapsible).
- **Message queue** — keep typing while the agent works; messages run in order.
  **Stop** button or **Esc** interrupts the current turn.
- **`@`** in the input autocompletes files in the working directory to reference.
- **Model picker** (Opus / Sonnet / Haiku) per session, switchable live;
  per-turn and running **cost** shown in the header; optional **voice** in
  (mic → speech-to-text) and out (speak replies).
- **Always-on background agents** — the agent keeps running if you close the
  browser; reconnecting (auto-reconnect on drop) reloads the transcript and the
  conversation resumes (SDK `resume`). Idle agents (no browser, not working) are
  suspended after 30 min and resume on the next message. Sessions run
  autonomously (`bypassPermissions`) — same trust model as your terminal.

Registry + transcripts live under `~/.config/agentpeek/` (`ui_sessions.json`,
`ui_transcripts/`).

## Claude connection (for UI mode)

UI-mode sessions run the **Claude Agent SDK**, which authenticates with
whatever the host's `claude` CLI uses. The **Claude** chip at the bottom of the
sidebar shows the connection state and, when not connected, opens a sign-in
panel:

- **Sign in with Claude** drives `claude setup-token` server-side: it prints an
  authorize URL (shown in the panel), you approve it in your browser and paste
  the code back, and the resulting long-lived subscription token is saved as
  `CLAUDE_CODE_OAUTH_TOKEN` in `~/.config/agentpeek/agentpeek.env` — the same
  flow as `/login` in the terminal. (Requires a Claude Pro/Max/Team/Enterprise
  plan.)
- **Use an API key** saves an `ANTHROPIC_API_KEY` instead (bills per-token).

If the host is already logged into Claude Code (`~/.claude/.credentials.json`
exists), the chip shows **connected** and nothing else is needed. Disconnecting
clears only agentpeek's saved token/key — it never touches the host's own login.

### Cloud backends — AWS Bedrock & Google Vertex AI

UI mode runs Claude Code, which can route to **Amazon Bedrock** or **Google
Vertex AI** instead of the first-party Anthropic API. agentpeek detects this and
adapts: the chip shows *"Using AWS Bedrock / Google Vertex"*, the in-app sign-in
panel is hidden (the cloud provider authenticates you), the per-turn cost is
hidden (billing goes through the cloud account), and the **model picker is
hidden** — on these backends the `opus`/`sonnet`/`haiku` aliases don't resolve,
so agentpeek lets Claude Code use the model you set in the environment.

There's no UI for this yet — configure it by hand in
`~/.config/agentpeek/agentpeek.env` (loaded by the systemd unit; for the manual
`uvicorn` run, the vars must be in the process environment). Set the backend
flag, the model IDs, and the provider credentials, then restart agentpeek.

**Amazon Bedrock:**

```bash
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-east-1
# AWS auth: a profile, static keys, or an attached IAM role
AWS_PROFILE=default
# Model IDs are Bedrock inference-profile / model IDs, not the short aliases:
ANTHROPIC_MODEL=us.anthropic.claude-opus-4-...-v1:0
ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-...-v1:0
```

**Google Vertex AI:**

```bash
CLAUDE_CODE_USE_VERTEX=1
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
# GCP auth: application-default credentials (gcloud auth application-default login),
# or a service-account key via GOOGLE_APPLICATION_CREDENTIALS=/path/key.json
ANTHROPIC_MODEL=claude-opus-4-...
ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-...
```

Look up the exact model IDs available in your account/region from the provider
console (they change over time). The agent's tools (bash, file edits, etc.) run
locally on your box regardless of which backend serves the model. Note that
Anthropic's server-hosted features (Managed Agents, server-side tools) aren't
available on Bedrock/Vertex — but agentpeek uses the local Claude Code agent, so
that doesn't affect it.

## Security model

agentpeek binds to `127.0.0.1` only and is reachable remotely solely through
Tailscale (`tailscale serve`), so the baseline access control is tailnet
membership/ACLs. Do not port-forward 8090/7681 to any public interface.

**Optional key-based login** (same scheme as filepeek) adds a second factor on
top of the tailnet. The easiest way to enable it is to **run `./setup.sh`** — it
prompts for a password, hashes it, writes `~/.config/agentpeek/agentpeek.env`,
and restarts the service. (Re-run it any time to change the password, or set
`AGENTPEEK_PASSWORD=… ./setup.sh` to do it non-interactively.)

To wire it up by hand instead, set either env var in
`~/.config/agentpeek/agentpeek.env` (read by the systemd unit):

```bash
# generate a password hash
.venv/bin/python -m app hash-password
# then create ~/.config/agentpeek/agentpeek.env with:
AGENTPEEK_PASSWORD_HASH=pbkdf2_sha256$200000$....   # browser login
AGENTPEEK_TOKEN=<random-string>                      # scripted access: Authorization: Bearer <token>
AGENTPEEK_SECRET=<random-string>                     # keeps sessions valid across restarts
# restart: systemctl --user restart agentpeek
```

With auth on, the browser logs in at `/login` (PBKDF2-checked password →
signed, HttpOnly session cookie, 7-day TTL, per-IP lockout after repeated
failures) and the terminal WebSocket is gated on the same cookie. With neither
var set, the app is open — the accepted posture for a purely local,
single-operator setup. Turning it on is **recommended** once UI mode can drive
agents that edit files over the tailnet.

## Manual fallback (no web UI)

Each session's ⋮ menu has **Copy SSH attach command**, which copies a ready
one-liner for that exact session:

```bash
ssh -t <user>@<tailscale-hostname> tmux attach -t <session-name>
# detach again without stopping it: Ctrl-b then d
```

(`-t` forces a TTY so tmux runs interactively.) There is also **Copy local
attach command** (`tmux attach -t <name>`) for when you are already on the
host.

## tmux settings (conf/agentpeek.tmux.conf) and trade-offs

- `history-limit 1000000` — "unlimited" scrollback, bounded by memory
  (applies to sessions created after the setting is loaded).
- `terminal-overrides ',xterm*:smcup@:rmcup@'` + `status off` — disables the
  alternate screen and the tmux status bar so output flows into the browser's
  native scrollback buffer and wheel-scrolling/select-to-copy work without
  tmux copy-mode. Side effects: SSH attaches also get no status bar, and the
  screen isn't restored after detaching in a CLI terminal. Both accepted for
  this tool.
- `mouse off` — xterm.js owns selection (select → Ctrl/Cmd+C copies natively).

## Operational notes

- **Stopping `agentpeek-tmux` kills the tmux server and all sessions.** Restart
  the UI with `systemctl --user restart agentpeek agentpeek-ttyd` — these never
  touch sessions.
- Sessions do not survive a host reboot (out of scope for v1); the `main`
  session is recreated at boot by `agentpeek-tmux.service`.
- Logs: `journalctl --user -u agentpeek -u agentpeek-ttyd -f`.
- The sidebar polls every 3 s and on tab focus, so CLI-created sessions appear
  automatically.

## Companion tool

agentpeek is the primary tool — it's where AI agents generate your content.
**[filepeek](https://github.com/thrinz/filepeek)** is its downstream companion;
together they cover the loop of working with AI agents on a remote/WSL2 box:

- **agentpeek** — *run* the agents that generate the content: persistent
  browser terminal sessions.
- **filepeek** — *view* what they produced: renders the Markdown, HTML, Office,
  and code files those agents generate, in the browser.

Both are self-hosted, single-operator tools that bind to `127.0.0.1` and go
over Tailscale, and they share a design language.

**Install filepeek.** `setup.sh` offers to clone and install it next to agentpeek
(answer the *Install filepeek now?* prompt, or set `AGENTPEEK_INSTALL_FILEPEEK=1`
to do it non-interactively). To do it by hand instead:

```bash
cd ~ && git clone https://github.com/thrinz/filepeek && cd filepeek
./install.sh
# serve your projects tree (filepeek defaults to port 8765, bound to 127.0.0.1):
FILEPEEK_ROOT=~/projects .venv/bin/python app.py
# then expose it tailnet-only, like agentpeek (pick any free https port):
tailscale serve --bg --https=9444 http://127.0.0.1:8765
```

## License

[MIT](LICENSE)
