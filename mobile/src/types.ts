// Shapes returned by the agentpeek backend (app/main.py).

/** "shell" = tmux session (plain shell or Claude Code TUI); "ui" = Claude chat. */
export type SessionKind = "shell" | "ui";

export interface Session {
  name: string;
  kind: SessionKind;
  group: string; // legacy server-side label; not shown — sessions are organised by cwd
  cwd?: string | null;
  created?: number; // epoch seconds
  /** Epoch seconds of the last terminal output (tmux sessions only). */
  activity?: number;
  attached?: boolean;
  /** Filed away by the user; still running, just hidden from the main lists. */
  archived?: boolean;
  busy?: boolean;
  /** Busy but blocked on a prompt that needs the user's answer. */
  waiting?: boolean;
  /** Foreground program name (e.g. "claude"), when busy. */
  foreground?: string | null;
}

export interface Config {
  folders: string[]; // e.g. ["General", "work/foo"]
  root: string; // display name of the projects root
}

export interface DirListing {
  path: string;
  dirs: string[];
}

/** POST /api/sessions start option: Claude Code in tmux, plain shell, or chat. */
export type SessionMode = "ai" | "shell" | "ui";

// React Navigation route params.
export type RootStackParamList = {
  Connect: undefined;
  Sessions: undefined;
  NewSession: undefined;
  /** `folder` is the name of the session's working directory (last path segment). */
  Terminal: { name: string; kind: SessionKind; folder?: string };
};
