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
        "#{session_name}\t#{session_created}\t#{session_attached}\t#{@agentpeek_group}",
        check=False,
    )
    if proc.returncode != 0:
        err = proc.stderr.strip()
        # No tmux server yet just means no sessions exist.
        if not err or "no server running" in err or "No such file or directory" in err:
            return []
        raise MuxError(err)

    # One call for all panes: a session is "busy" if any pane runs a non-shell.
    foreground: dict[str, str] = {}
    panes = _tmux(
        "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}",
        check=False,
    )
    if panes.returncode == 0:
        for line in panes.stdout.splitlines():
            sname, _, cmd = line.partition("\t")
            if cmd and cmd not in SHELLS and sname not in foreground:
                foreground[sname] = cmd

    sessions = []
    for line in proc.stdout.splitlines():
        name, created, attached, group = line.split("\t", 3)
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
            }
        )
    return sessions


def create(name: str, cwd=None, group: str | None = None, ai: bool = False) -> None:
    validate_name(name)
    if has(name):
        raise DuplicateSession(f"A session named '{name}' already exists.")
    args = ["new-session", "-d", "-s", name]
    if cwd:
        args += ["-c", str(cwd)]
    _tmux(*args)
    if group:
        # set-option takes a pane target in tmux 3.x, hence the trailing ':'
        _tmux("set-option", "-t", f"={name}:", "@agentpeek_group", group)
    if ai:
        # Type `cds` into the new shell as if the user ran it, so shell
        # aliases/functions resolve and the shell survives when it exits.
        # Pane targets need the trailing ':' with an exact-match '='.
        _tmux("send-keys", "-t", f"={name}:", "cds", "Enter")


def rename(old: str, new: str) -> None:
    validate_name(new)
    if not has(old):
        raise NoSuchSession(f"No session named '{old}'.")
    if old == new:
        return
    if has(new):
        raise DuplicateSession(f"A session named '{new}' already exists.")
    _tmux("rename-session", "-t", f"={old}", new)


def kill(name: str) -> None:
    if not has(name):
        raise NoSuchSession(f"No session named '{name}'.")
    _tmux("kill-session", "-t", f"={name}")
