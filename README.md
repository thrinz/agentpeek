<p align="center">
  <img src="static/logo.svg" width="72" alt="agentpeek"><br>
  <b>agentpeek</b>
</p>

<h1 align="center">Run your AI agents from the browser</h1>

<p align="center">
  A self-hosted web UI for creating and managing <b>persistent terminal
  sessions</b> on a Linux/WSL2 box — built for driving long-running AI coding
  agents like Claude Code from anywhere, then leaving them running.
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

```bash
./setup.sh
```

This installs `ttyd` (to `~/.local/bin` if missing), creates `.venv` and
installs Python deps, sources `conf/agentpeek.tmux.conf` from `~/.tmux.conf`,
installs and enables three systemd **user** services
(`agentpeek-tmux`, `agentpeek-ttyd`, `agentpeek`), and enables linger so
everything starts when the WSL2 instance boots. Re-running it is safe.

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

The create dialog asks for: a folder (required), a **start option** — *Shell*
(plain shell) or *AI* (types your AI launcher command into the new shell) — and
a **working directory**, picked from a collapsible tree rooted at `~/projects`
(`DIRS_ROOT` in `app/main.py`). The session starts cd'd into the chosen
directory, then runs the launcher if AI was selected. The last-used folder and
start option are remembered per browser.

> **AI mode** types `cds` into the new shell — that's the author's personal
> Claude Code launcher alias. Change the command in `mux.create()`
> (`app/multiplexer.py`) to whatever starts your agent (`claude`, `aider`, …).

## Security model

agentpeek binds to `127.0.0.1` only and is reachable remotely solely through
Tailscale (`tailscale serve`), so the baseline access control is tailnet
membership/ACLs. Do not port-forward 8090/7681 to any public interface.

**Optional key-based login** (same scheme as filepeek) adds a second factor on
top of the tailnet. It turns on automatically once you set either env var in
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

## License

[MIT](LICENSE)
