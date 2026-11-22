# agentpeek-mobile

Native iOS + Android client for [agentpeek](../README.md), built with **React
Native (Expo + TypeScript)**. One codebase, both stores.

The app is a **native shell** — connection manager, native session/folder list
from the REST API, Keychain-stored credentials, and a native terminal keyboard
row — with the tmux session itself rendered in a **WebView** pointed at the
box's ttyd endpoint. That native/WebView split is deliberate: it's what keeps
the app on the right side of Apple's "minimum functionality" rule (see
[Approval](#app-store--play-store-approval)).

## How it talks to your box

Nothing server-side changes. The app is a pure client of the existing API:

| Screen | Backend (see `app/main.py`, `app/auth.py`) |
| --- | --- |
| **Connect** | `POST /login` (password → `agentpeek_session` HttpOnly cookie) |
| **Sessions** | `GET /api/config` + `GET /api/sessions`, polled every 5 s; long-press → `DELETE /api/sessions/{name}` |
| **New session** | `GET /api/dirs` (directory picker) + `POST /api/sessions` |
| **Terminal** (tmux sessions) | WebView → `/term/?arg=<name>` → ttyd WebSocket; key row → `POST /api/sessions/{name}/keys` |
| **Chat** (`kind: "ui"` sessions) | WebView → `/`, then the page is told to open that chat with its sidebar collapsed |

Auth is **cookie-based**, mirroring the browser. React Native shares one native
cookie jar with the WebView (iOS `NSHTTPCookieStorage` via `sharedCookiesEnabled`;
Android `CookieManager`), so after login the terminal page and its WebSocket
authenticate with no extra plumbing. The URL and password are stored in the OS
keychain (`expo-secure-store`) and used to log in again silently when the 7-day
cookie expires. Servers running without a password work too — leave it blank.

The phone has to be able to reach the server. The intended setup is
**Tailscale** on both, pointing Connect at the `tailscale serve` HTTPS name
(e.g. `box.tailnet.ts.net`). A bare host tries HTTPS first, then HTTP; include
a port if needed (`100.x.y.z:8090`). Plain HTTP works on Android everywhere; on
iOS only for IP addresses and local names (App Transport Security), so use an
IP or the HTTPS name there.

## Prerequisites

- **Node.js 22.13+** (Expo SDK 58 requires it; it currently bundles on 20 with
  a warning).
- An **Expo account** for cloud builds: `npm i -g eas-cli && eas login`.
- No Mac required — EAS Build compiles the iOS binary in the cloud.

## Run (development)

```bash
cd mobile
npm install
npm run typecheck
npx expo start             # scan the QR with Expo Go
```

## Build for the stores (no Mac needed)

```bash
# Internal test builds — installable APK + TestFlight-style iOS build
eas build --profile preview --platform android
eas build --profile preview --platform ios

# Store-ready production builds
eas build --profile production --platform all

# Submit to App Store Connect / Play Console
eas submit --platform ios
eas submit --platform android
```

Set `ios.bundleIdentifier` / `android.package` in `app.json` to your own
reverse-domain IDs before the first production build.

## App Store / Play Store approval

Both stores accept this app class — it's the same category as Termius, Blink,
Prompt, and Working Copy (clients to a user-controlled server). React Native is
irrelevant to review; **substance** is what's judged.

- **Apple Guideline 4.2 (minimum functionality)** is the only real risk — a bare
  WebView of a website gets rejected. This app clears it with genuine native
  surface: the connection manager, the native `SectionList` of sessions/folders,
  Keychain credential storage, and the native key-accessory row. Keep that
  native shell real as the app grows.
- **Guideline 2.5.2 (executable code)** does *not* apply — running commands on
  *your* remote box is a remote session, exactly like an SSH client. The app
  does not download code that changes itself.
- **Demo access:** reviewers must be able to log in. Provide a reachable demo
  agentpeek instance + credentials in App Review notes (a throwaway box exposed
  via `tailscale funnel` for the review window works).
- **Play Store** is more lenient and approves this class easily.

Zero-approval distribution also works and fits agentpeek's self-hosted audience:
ship the Android **APK** directly, and use **TestFlight** (up to 10k testers) on
iOS.

## Project layout

```
mobile/
  App.tsx                   navigation + dark theme
  app.json                  Expo config (bundle IDs, icons, splash, cleartext)
  eas.json                  cloud build/submit profiles
  src/
    api.ts                  every server call; cookie auth with auto re-login
    storage.ts              Keychain-backed connection store
    screens/
      ConnectScreen.tsx     URL + password; silent resume on launch
      SessionsScreen.tsx    folders → sessions, live status, terminate
      NewSessionScreen.tsx  name, type, folder, working-directory picker
      TerminalScreen.tsx    WebView session + native key row
  assets/                   icon/splash rendered from static/logo.svg
```

## Not yet verified / not built

- **Never run on a phone.** It typechecks, passes `expo-doctor`, bundles for
  both platforms, and `src/api.ts` was exercised against a live server — but
  the screens, shared-cookie login into the WebView, keyboard avoidance and the
  chat-session hand-off need a pass on real iOS and Android devices.
- **Chat sessions** rely on the web page's `openChat` / `setSidebar` globals in
  `static/app.js`; renaming those breaks the hand-off. A `/?session=<name>`
  deep link on the server would be the sturdier contract.
- **Push notifications** when an agent finishes, renaming/moving sessions and
  creating folders are web-only for now.
