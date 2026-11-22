import type { Config, DirListing, Session, SessionMode } from "./types";
import { loadConnection, saveConnection, type Connection } from "./storage";

// ─────────────────────────────────────────────────────────────────────────────
// Auth model (see agentpeek app/auth.py)
//
// agentpeek issues an HttpOnly `agentpeek_session` cookie from POST /login. We
// rely on React Native's NATIVE cookie jar, which is shared with the WebView:
//   • iOS    — fetch + WKWebView (sharedCookiesEnabled) both use NSHTTPCookieStorage
//   • Android — RN's ForwardingCookieHandler stores fetch cookies in the same
//               android.webkit.CookieManager the WebView reads.
// So once we log in here, the Terminal WebView's page load AND its ttyd
// WebSocket authenticate with zero extra plumbing — exactly like the browser.
//
// A server running with auth disabled (no password configured) answers /login
// with a redirect and every API call with 200, so the same flow works there.
// ─────────────────────────────────────────────────────────────────────────────

export class AuthError extends Error {}
export class NetworkError extends Error {}
/** The server understood the request and said no (4xx/5xx with a `detail`). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Strip whitespace + trailing slashes. Keeps an explicit scheme if one was typed. */
export function normalizeBase(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

/**
 * Base URLs to try for what the user typed. With an explicit scheme there is
 * exactly one; a bare host tries HTTPS first (`tailscale serve`), then plain
 * HTTP (LAN / raw tailnet IP on :8090).
 */
export function candidateBases(input: string): string[] {
  const u = normalizeBase(input);
  if (!u) return [];
  if (/^https?:\/\//i.test(u)) return [u];
  return [`https://${u}`, `http://${u}`];
}

/** ttyd terminal URL for a tmux session. `?arg=<name>` → bin/agentpeek-attach. */
export function terminalUrl(base: string, name: string): string {
  return `${base}/term/?arg=${encodeURIComponent(name)}`;
}

/** Path of the server's login page — the WebView lands here when its cookie is gone. */
export function isLoginUrl(url: string): boolean {
  return /\/login\/?(\?|$)/.test(url);
}

async function postLogin(base: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(password)}`,
    });
  } catch {
    throw new NetworkError(`Can't reach ${base}. Is the box up and on your tailnet?`);
  }
  // Success is a 303 → "/" (followed automatically). Wrong password → 401.
  if (res.status === 401) throw new AuthError("Wrong password.");
  if (res.status === 429) {
    throw new AuthError("Too many attempts — try again in a few minutes.");
  }
  if (!res.ok) throw new NetworkError(`Login failed (HTTP ${res.status}).`);
}

async function request<T>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError(`Can't reach ${base}.`);
  }
  if (res.status === 401) throw new AuthError("Session expired.");
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      if (typeof j?.detail === "string") detail = j.detail;
    } catch {
      // non-JSON error body
    }
    if (res.status === 403 && /password change/i.test(detail)) {
      throw new ApiError(
        "This server still has its temporary password. Open it in a browser once to set a new one, then connect here.",
        403,
      );
    }
    throw new ApiError(detail || `${method} ${path} failed (HTTP ${res.status}).`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Log in and verify by fetching config. Persists the connection on success. */
export async function connect(input: string, password: string): Promise<Connection> {
  const bases = candidateBases(input);
  if (bases.length === 0) throw new NetworkError("Enter your agentpeek URL.");
  let lastError: unknown;
  for (const base of bases) {
    try {
      await postLogin(base, password);
      await request<Config>(base, "GET", "/api/config");
      const conn = { base, password };
      await saveConnection(conn);
      return conn;
    } catch (e) {
      lastError = e;
      // Only an unreachable host is worth retrying on the other scheme; a
      // wrong password or a server-side refusal is the final answer.
      if (!(e instanceof NetworkError)) throw e;
    }
  }
  throw lastError;
}

/** Refresh the session cookie from the stored password. */
export async function relogin(conn: Connection): Promise<void> {
  await postLogin(conn.base, conn.password);
}

/**
 * Run an authed request, transparently re-logging-in once on AuthError using
 * the stored password (cookie expired, server restarted, or cold start).
 */
async function authed<T>(
  conn: Connection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    return await request<T>(conn.base, method, path, body);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    await relogin(conn);
    return await request<T>(conn.base, method, path, body);
  }
}

const enc = encodeURIComponent;

export const fetchConfig = (conn: Connection) =>
  authed<Config>(conn, "GET", "/api/config");

export const fetchSessions = (conn: Connection) =>
  authed<Session[]>(conn, "GET", "/api/sessions");

/** Sub-directories of `path` (relative to the server's projects root). */
export const fetchDirs = (conn: Connection, path: string) =>
  authed<DirListing>(conn, "GET", `/api/dirs?path=${enc(path)}`);

export interface NewSession {
  name: string;
  cwd: string; // relative to the projects root; must not be the root itself
  mode: SessionMode;
}

export const createSession = (conn: Connection, s: NewSession) =>
  authed<{ name: string }>(conn, "POST", "/api/sessions", { ...s, group: "General" });

/** Archive (hide from the main lists) or unarchive a session. It keeps running. */
export const setArchived = (conn: Connection, name: string, archived: boolean) =>
  authed<unknown>(conn, "PATCH", `/api/sessions/${enc(name)}`, { archived });

export const killSession = (conn: Connection, name: string) =>
  authed<void>(conn, "DELETE", `/api/sessions/${enc(name)}`);

// Key input goes through the server (tmux send-keys) rather than synthetic DOM
// events in the WebView — same path the web UI's touch bar uses, so it behaves
// identically whatever the terminal page is doing. Shell sessions only.

/** tmux key names: "Escape", "Tab", "Enter", "Up", "C-c", … */
export const sendKeys = (conn: Connection, name: string, keys: string[]) =>
  authed<void>(conn, "POST", `/api/sessions/${enc(name)}/keys`, { keys });

export const sendScroll = (conn: Connection, name: string, scroll: "up" | "down" | "bottom") =>
  authed<void>(conn, "POST", `/api/sessions/${enc(name)}/keys`, { scroll });

/** Type literal text into the session (paste). */
export const sendText = (conn: Connection, name: string, text: string) =>
  authed<void>(conn, "POST", `/api/sessions/${enc(name)}/keys`, { text });

export type ResumeResult =
  | { status: "ok"; conn: Connection }
  | { status: "none" } // nothing saved
  | { status: "failed"; conn: Connection; message: string };

/** Load the saved connection and make sure its cookie is live. */
export async function resume(): Promise<ResumeResult> {
  const conn = await loadConnection();
  if (!conn) return { status: "none" };
  try {
    await fetchConfig(conn);
    return { status: "ok", conn };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Couldn't connect.";
    return { status: "failed", conn, message };
  }
}
