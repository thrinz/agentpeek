"""Multiplexer adapter — the only module that talks to tmux (NFR-6).

Every function shells out to tmux with argv lists (never a shell string),
and session names are validated before they reach any command line.
Targets use tmux's `=name` prefix for exact matching, since a bare `-t name`
does prefix matching.
"""

import re
import subprocess

NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# pane_current_command values that mean "idle shell" rather than a busy session
SHELLS = {"bash", "zsh", "sh", "fish", "dash", "ash", "ksh", "tcsh", "csh"}


class MuxError(Exception):
    """A multiplexer command failed."""


class InvalidName(MuxError):
    pass


class DuplicateSession(MuxError):
    pass


class NoSuchSession(MuxError):
    pass


def validate_name(name: str) -> None:
    if not name or not NAME_RE.match(name):
        raise InvalidName(
            "Session names may only contain letters, digits, '-' and '_'."
        )


def _tmux(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(["tmux", *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise MuxError(proc.stderr.strip() or f"tmux {' '.join(args)} failed")
    return proc


def has(name: str) -> bool:
    return _tmux("has-session", "-t", f"={name}", check=False).returncode == 0


def list_sessions() -> list[dict]:
    proc = _tmux(
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{session_attached}\t#{@agentpeek_group}\t#{@agentpeek_cwd}",
        check=False,
    )
    if proc.returncode != 0:
        err = proc.stderr.strip()
        # No tmux server yet just means no sessions exist.
        if not err or "no server running" in err or "No such file or directory" in err:
            return []
        raise MuxError(err)

    # One call for all panes: a session is "busy" if any pane runs a non-shell.
    # We also grab the active pane's current path as the session's live cwd,
    # which works for any session (incl. CLI-created ones with no stored cwd).
    foreground: dict[str, str] = {}
    live_cwd: dict[str, str] = {}
    panes = _tmux(
        "list-panes", "-a", "-F",
        "#{session_name}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}",
        check=False,
    )
    if panes.returncode == 0:
        for line in panes.stdout.splitlines():
            sname, active, cmd, path = (line.split("\t", 3) + ["", "", ""])[:4]
            if cmd and cmd not in SHELLS and sname not in foreground:
                foreground[sname] = cmd
            if active == "1" and path:
                live_cwd[sname] = path

    sessions = []
    for line in proc.stdout.splitlines():
        name, created, attached, group, cwd = line.split("\t", 4)
        sessions.append(
            {
                "name": name,
                "created": int(created),
                "attached": attached != "0",
                "busy": name in foreground,
                "foreground": foreground.get(name),
                "attach_command": f"tmux attach -t {name}",
                # CLI-created sessions have no group option -> General bucket
                "group": group or "General",
                # Directory the session was created in; fall back to the active
                # pane's live path when nothing was stored at creation.
                "cwd": cwd or live_cwd.get(name),
            }
        )
    return sessions


def create(name: str, cwd=None, group: str | None = None, ai: bool = False,
           notify_topic: str | None = None) -> None:
    validate_name(name)
    if notify_topic and not NAME_RE.match(notify_topic):
        raise InvalidName(
            "Notification topic may only contain letters, digits, '-' and '_'."
        )
    if has(name):
        raise DuplicateSession(f"A session named '{name}' already exists.")
    args = ["new-session", "-d", "-s", name]
    if cwd:
        args += ["-c", str(cwd)]
    _tmux(*args)
    if group:
        # set-option takes a pane target in tmux 3.x, hence the trailing ':'
        _tmux("set-option", "-t", f"={name}:", "@agentpeek_group", group)
    if cwd:
        # Remember the directory the session was created in, so the UI can
        # show it later (this is the original location, not the live pane cwd).
        _tmux("set-option", "-t", f"={name}:", "@agentpeek_cwd", str(cwd))
    if ai:
        # Type `cds` into the new shell as if the user ran it, so shell
        # aliases/functions resolve and the shell survives when it exits.
        # A topic turns on ntfy push for that session (`cds <topic>`).
        # Pane targets need the trailing ':' with an exact-match '='.
        cmd = f"cds {notify_topic}" if notify_topic else "cds"
        _tmux("send-keys", "-t", f"={name}:", cmd, "Enter")


def rename(old: str, new: str) -> None:
    validate_name(new)
    if not has(old):
        raise NoSuchSession(f"No session named '{old}'.")
    if old == new:
        return
    if has(new):
        raise DuplicateSession(f"A session named '{new}' already exists.")
    _tmux("rename-session", "-t", f"={old}", new)


def set_group(name: str, group: str) -> None:
    """Move a session to a different sidebar folder."""
    if not has(name):
        raise NoSuchSession(f"No session named '{name}'.")
    _tmux("set-option", "-t", f"={name}:", "@agentpeek_group", group)


# Keys the mobile touch bar may send. tmux key names; C-<x> is Ctrl+<x>.
_KEY_RE = re.compile(
    r"^(C-[a-z0-9]|Escape|Tab|Enter|Space|BSpace|"
    r"Up|Down|Left|Right|Home|End|PageUp|PageDown)$"
)

# Cap on a single paste to keep one tap from flooding the pane.
MAX_PASTE_LEN = 100_000


def send_keys(name: str, keys: list[str]) -> None:
    """Send key presses to a session, as if typed at the keyboard."""
    if not has(name):
        raise NoSuchSession(f"No session named '{name}'.")
    for k in keys:
        if not _KEY_RE.match(k):
            raise InvalidName(f"Disallowed key: {k!r}")
    if keys:
        _tmux("send-keys", "-t", f"={name}:", *keys)


def scroll(name: str, direction: str) -> None:
    """Scroll the session's view up/down by half a page using copy-mode."""
    if not has(name):
        raise NoSuchSession(f"No session named '{name}'.")
    if direction not in ("up", "down"):
        raise InvalidName(f"Bad scroll direction: {direction!r}")
    # Entering copy-mode is harmless if already in it; scrolling to the
    # bottom drops back out to the live view automatically.
    _tmux("copy-mode", "-t", f"={name}:", check=False)
    motion = "halfpage-up" if direction == "up" else "halfpage-down"
    _tmux("send-keys", "-t", f"={name}:", "-X", motion)


def send_text(name: str, text: str) -> None:
    """Paste literal text into a session (mobile paste button).

    Uses send-keys -l so the text is typed verbatim — no key-name
    interpretation — and the argv form means the shell never parses it.
    """
    if not has(name):
        raise NoSuchSession(f"No session named '{name}'.")
    if len(text) > MAX_PASTE_LEN:
        raise InvalidName(f"Paste too large (>{MAX_PASTE_LEN} chars).")
    if text:
        _tmux("send-keys", "-t", f"={name}:", "-l", text)


def kill(name: str) -> None:
    if not has(name):
        raise NoSuchSession(f"No session named '{name}'.")
    _tmux("kill-session", "-t", f"={name}")
