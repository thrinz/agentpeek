# agentpeek mobile app — plan

A native iOS + Android client for [agentpeek](../README.md). The server already
exposes the REST API and authentication; the app is a pure client that
authenticates and consumes it over the tailnet. No backend changes are required
for the baseline app.

---

## 1. Goal

Reach your persistent Claude Code / tmux sessions from a phone:

- Enter the box URL and log in once.
- See folders and sessions in a native list.
- Open a session's live terminal (tmux via ttyd) in a WebView.

The box keeps running agentpeek as it does today (systemd service on `:8090`,
bound to `127.0.0.1`, exposed over the tailnet with `tailscale serve`). The
phone is just another client, alongside the browser.

---

## 2. Architecture

```
Phone (React Native app)                 Linux box (agentpeek, unchanged)
┌───────────────────────────┐            ┌──────────────────────────────────┐
│ Connect screen            │  POST /login (password → cookie)              │
│ Sessions screen  ─────────┼──GET /api/config  (folders) ─────────────────▶│ FastAPI :8090
│                           │  GET /api/sessions (sessions)                 │  ├ /api/*  REST
│ Terminal screen (WebView) ┼──GET /term/?arg=<name> ──────────────────────▶│  └ /term/* ttyd proxy
│   + native key row        │  WS  /term/ws (ttyd) ────────────────────────▶│      → tmux
└───────────────────────────┘            └──────────────────────────────────┘
        over Tailscale (HTTPS via `tailscale serve`)
```

- **Native shell:** connection manager, session/folder list, credential storage,
  terminal key-accessory row.
- **WebView:** only the terminal itself (ttyd/xterm), selected by `?arg=<name>`
  which drives `bin/agentpeek-attach <name>`.

---

## 3. Server side — already exposed (no new work for baseline)

The open-source server owns the API + auth contract. Because it ships in
agentpeek, the app works against **any** agentpeek instance.

| Need | Endpoint (existing) | Source |
| --- | --- | --- |
| Log in | `POST /login` (form `password=…`) → `agentpeek_session` HttpOnly cookie | `app/auth.py` |
| API token (alt) | `Authorization: Bearer <AGENTPEEK_TOKEN>` | `app/auth.py` |
| Folders | `GET /api/config` → `{ folders, root }` | `app/main.py` |
| Sessions | `GET /api/sessions` → `[{ name, kind, group, cwd, busy, … }]` | `app/main.py` |
| Terminal page | `GET /term/?arg=<name>` | `app/main.py` |
| Terminal stream | `WS /term/ws` | `app/main.py` |
| (Create session) | `POST /api/sessions` + `GET /api/dirs` | `app/main.py` |

**Auth is browser-shaped:** `/login` is a form submit that 303-redirects and
sets an HttpOnly cookie. Clients consume it via the cookie jar. The Bearer token
is the clean API-client path, but a WebView page load can't send a Bearer
header, so the terminal needs the cookie.

### Optional server enhancement
Add `POST /api/login` returning a short-lived JSON token so the API has a clean,
API-shaped login for any client. **Not required** for the baseline app (the
cookie flow works today). Tracked as a decision, not a dependency.

---

## 4. Client side — React Native (Expo + TypeScript)

One codebase, both stores. Scaffolded under `mobile/`.

### Auth strategy: cookie-based, shared with the WebView
agentpeek issues an HttpOnly `agentpeek_session` cookie. React Native shares one
native cookie jar with the WebView:

- **iOS:** `fetch` + `WKWebView` (`sharedCookiesEnabled`) both use
  `NSHTTPCookieStorage`.
- **Android:** RN's `ForwardingCookieHandler` stores `fetch` cookies in the same
  `android.webkit.CookieManager` the WebView reads.

So after login, the REST calls, the terminal page, and the ttyd WebSocket all
authenticate with no extra plumbing — exactly like the browser. Credentials are
held in the OS keychain (`expo-secure-store`) to silently re-login when the
7-day cookie expires.

### Screens
1. **Connect** — URL + password; normalize URL; `POST /login`; verify with
   `GET /api/config`; persist to keychain; silent resume on next launch.
2. **Sessions** — `GET /api/config` + `GET /api/sessions`; group sessions under
   folders; pull-to-refresh; busy/idle indicator; disconnect.
3. **Terminal** — WebView → `GET /term/?arg=<name>`; native key row
   (esc/tab/^C/^D/arrows) injecting synthetic keydown events into xterm.

### Networking
Reaches the box over **Tailscale** (phone needs the Tailscale app), pointed at
the `tailscale serve` HTTPS URL (`box.tailnet.ts.net`). No public exposure.

---

## 5. Distribution & store approval

Same app class as Termius / Blink / Prompt (clients to a user-controlled
server). React Native is irrelevant to review; substance is judged.

- **Apple 4.2 (minimum functionality)** — the only real risk; a bare WebView is
  rejected. Cleared by real native surface: connection manager, native session
  list, keychain storage, native key row.
- **Apple 2.5.2 (executable code)** — N/A; running commands on *your* remote box
  is a remote session, like SSH.
- **Demo access** — reviewers must log in; provide a reachable demo instance +
  credentials (a throwaway box via `tailscale funnel` for the review window).
- **Play Store** — lenient; approves this class easily.

**Build without a Mac:** EAS Build compiles the iOS binary in the cloud.

**Zero-approval options** (fit the self-hosted audience): ship the Android APK
directly; use TestFlight on iOS; or a PWA for an install-to-home-screen path
with no store at all.

---

## 6. Status

**Done — scaffolded in `mobile/`:**
- Expo + TypeScript project (`package.json`, `app.json`, `eas.json`, `tsconfig`).
- API client with cookie auth + auto re-login (`src/api.ts`).
- Keychain connection store (`src/storage.ts`).
- Connect / Sessions / Terminal screens + navigation + dark theme.
- Placeholder brand assets.
- `README.md` with run/build/submit + approval notes.

**Not yet verified:** no Node on the build box, so the project is unbuilt /
untypechecked. Assets are solid-color placeholders.

---

## 7. Next steps

1. Install Node 18+ on the dev box; `npm install && npx expo install --fix &&
   npm run typecheck`.
2. Replace placeholder `assets/` with real 1024² icon + splash.
3. Build a preview: `eas build --profile preview --platform android` (APK) /
   `… --platform ios` (TestFlight).
4. **Decide:** add `POST /api/login` JSON token endpoint to agentpeek? (clean
   API login vs. keep cookie flow).
5. Add create-session flow (`POST /api/sessions` + `GET /api/dirs`).
6. Verify terminal key injection on a real device against the deployed ttyd
   version.
7. Optional: push notifications for "agent finished" via agentpeek's
   `notify_topic` + `expo-notifications`.
8. Store submission: set bundle IDs, prepare demo account, submit.

---

## 8. Open decisions

- **JSON login endpoint** on the server, or keep the cookie flow? (cookie works
  today; JSON login is cleaner for non-WebView clients).
- **Distribution:** full store submission vs. APK/TestFlight vs. PWA for v1.
- **Public exposure:** Tailscale-only (private, recommended) vs. Funnel/reverse
  proxy (public, requires auth hardening first).
