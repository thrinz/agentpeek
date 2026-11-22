import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useHeaderHeight } from "@react-navigation/elements";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { isLoginUrl, relogin, sendKeys, sendScroll, sendText, terminalUrl } from "../api";
import { loadConnection, type Connection } from "../storage";
import { colors } from "../theme";
import type { RootStackParamList } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">;

// Chat ("ui") sessions have no tmux pane; the server renders them inside its
// own web page, which has no per-session URL. So we load that page and ask it
// to open the session, with its sidebar collapsed — navigation stays native.
function openChatScript(name: string): string {
  return `
(function () {
  var name = ${JSON.stringify(name)}, tries = 0;
  var timer = setInterval(function () {
    tries++;
    try {
      if (typeof openChat === 'function' && typeof sessions !== 'undefined' &&
          sessions.some(function (s) { return s.name === name && s.kind === 'ui'; })) {
        clearInterval(timer);
        openChat(name);
        if (typeof setSidebar === 'function') setSidebar(true);
        return;
      }
    } catch (e) {}
    if (tries > 150) clearInterval(timer);
  }, 100);
})();
true;
`;
}

// ttyd's page has no viewport tag, so a phone lays it out as a ~980px desktop
// page and shrinks it — a tiny terminal. Give it a device-width viewport, then
// fire a resize so xterm re-fits its rows/columns to the real width.
const VIEWPORT_SCRIPT = `
(function () {
  function apply() {
    if (!document.head) return false;
    var m = document.querySelector('meta[name=viewport]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      document.head.appendChild(m);
    }
    m.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
    return true;
  }
  function refit() { window.dispatchEvent(new Event('resize')); }
  if (!apply()) document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', function () {
    apply();
    [50, 300, 1000].forEach(function (ms) { setTimeout(refit, ms); });
  });
})();
true;
`;

// Tapping a link in the terminal makes xterm call window.open() with no URL
// and then point the new window at the link. A WebView has no second window,
// so that blank window replaced the terminal (a black screen). Hand the URL to
// the app instead, which opens it in the phone's browser.
const LINK_SCRIPT = `
(function () {
  if (window.__apkLinks) return;
  window.__apkLinks = true;
  function send(url) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'open-url', url: String(url) }));
    } catch (e) {}
  }
  window.open = function (url) {
    if (url) { send(url); return null; }
    var loc = {};
    Object.defineProperty(loc, 'href', { set: send, get: function () { return ''; } });
    loc.assign = send;
    loc.replace = send;
    var win = { opener: null, closed: false, close: function () {}, focus: function () {} };
    Object.defineProperty(win, 'location', { get: function () { return loc; }, set: send });
    return win;
  };
})();
true;
`;

function openExternal(url: string) {
  if (/^https?:\/\//i.test(url)) Linking.openURL(url).catch(() => {});
}

type KeyAction =
  | { label: string; keys: string[] }
  | { label: string; scroll: "up" | "down" | "bottom" }
  | { label: string; ctrl: true }
  | { label: string; paste: true };

// Same key set as the web UI's touch bar; names are tmux key names accepted by
// POST /api/sessions/{name}/keys (app/multiplexer.py _KEY_RE).
const KEYS: KeyAction[] = [
  { label: "esc", keys: ["Escape"] },
  { label: "tab", keys: ["Tab"] },
  { label: "ctrl", ctrl: true },
  { label: "↑", keys: ["Up"] },
  { label: "↓", keys: ["Down"] },
  { label: "←", keys: ["Left"] },
  { label: "→", keys: ["Right"] },
  { label: "enter", keys: ["Enter"] },
  { label: "⇞", scroll: "up" },
  { label: "⇟", scroll: "down" },
  { label: "⤓ end", scroll: "bottom" },
  { label: "paste", paste: true },
];

// Shown in place of the row while ctrl is armed: the next tap sends Ctrl+<key>.
const CTRL_KEYS = ["c", "d", "z", "l", "r", "a", "e", "u", "k", "w", "b", "o"];

export default function TerminalScreen({ route, navigation }: Props) {
  const { name, kind, folder } = route.params;
  const isShell = kind === "shell";
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState("");
  const [keyError, setKeyError] = useState("");
  const [ctrl, setCtrl] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reloginAttempts = useRef(0);
  const headerHeight = useHeaderHeight();

  useLayoutEffect(() => {
    navigation.setOptions({
      title: name,
      // Two-line title: session name, with its folder name underneath.
      headerTitle: () => (
        <View style={styles.title}>
          <Text style={styles.titleName} numberOfLines={1}>
            {name}
          </Text>
          {!!folder && (
            <Text style={styles.titleFolder} numberOfLines={1}>
              {folder}
            </Text>
          )}
        </View>
      ),
    });
  }, [navigation, name, folder]);

  useEffect(() => {
    loadConnection().then((c) => {
      if (c) setConn(c);
      else navigation.replace("Connect");
    });
  }, [navigation]);

  // The WebView landed on the login page: its cookie is missing or expired.
  // Log in again natively (which refreshes the shared cookie) and reload.
  async function recoverAuth(c: Connection) {
    if (reloginAttempts.current >= 2) {
      setError("Signed out by the server. Go back and reconnect.");
      return;
    }
    reloginAttempts.current++;
    try {
      await relogin(c);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sign in again.");
    }
  }

  async function press(k: KeyAction) {
    if (!conn) return;
    setKeyError("");
    try {
      if ("ctrl" in k) {
        setCtrl((v) => !v);
      } else if ("keys" in k) {
        await sendKeys(conn, name, k.keys);
      } else if ("scroll" in k) {
        await sendScroll(conn, name, k.scroll);
      } else {
        const text = await Clipboard.getStringAsync();
        if (text) await sendText(conn, name, text);
        else setKeyError("Clipboard is empty.");
      }
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Key not sent.");
    }
  }

  async function pressCtrl(letter: string) {
    setCtrl(false);
    if (!conn) return;
    setKeyError("");
    try {
      await sendKeys(conn, name, [`C-${letter}`]);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Key not sent.");
    }
  }

  if (error) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.error}>{error}</Text>
        <Pressable
          style={styles.retry}
          onPress={() => {
            reloginAttempts.current = 0;
            setError("");
            setReloadKey((k) => k + 1);
          }}
        >
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (!conn) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const uri = isShell ? terminalUrl(conn.base, name) : `${conn.base}/`;

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
      >
        {/* <{}>: the library's default generic (undefined) types its props as never. */}
        <WebView<{}>
          key={reloadKey}
          source={{ uri }}
          // Share the native cookie jar so the page + its WebSocket inherit the
          // agentpeek_session cookie set during login (see src/api.ts).
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          injectedJavaScriptBeforeContentLoaded={isShell ? VIEWPORT_SCRIPT + LINK_SCRIPT : LINK_SCRIPT}
          injectedJavaScript={isShell ? VIEWPORT_SCRIPT + LINK_SCRIPT : LINK_SCRIPT + openChatScript(name)}
          onMessage={(e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data);
              if (msg?.type === "open-url" && typeof msg.url === "string") openExternal(msg.url);
            } catch {
              // not one of ours
            }
          }}
          // Anything that still tries to navigate away from the server (or
          // open a window) goes to the browser; the session stays put.
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(req) => {
            if (req.url.startsWith(conn.base) || !/^https?:/i.test(req.url)) return true;
            if (req.isTopFrame !== false) openExternal(req.url);
            return false;
          }}
          javaScriptEnabled
          domStorageEnabled
          allowsBackForwardNavigationGestures={false}
          // Stay on the server: anything else (a link printed in the terminal)
          // is not loaded inside the app.
          originWhitelist={[`${conn.base}*`]}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          bounces={false}
          overScrollMode="never"
          startInLoadingState
          renderLoading={() => (
            <View style={[styles.screen, styles.center, StyleSheet.absoluteFill]}>
              <ActivityIndicator color={colors.accent} />
            </View>
          )}
          onNavigationStateChange={(nav) => {
            if (isLoginUrl(nav.url) && !nav.loading) recoverAuth(conn);
          }}
          onError={(e) => setError(e.nativeEvent.description || "Failed to load the session.")}
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 500) {
              setError(`The server returned HTTP ${e.nativeEvent.statusCode}.`);
            }
          }}
          style={styles.web}
        />

        {/* Native key row — the keys a phone keyboard lacks. Sent through the
            server to tmux, so chat sessions (not tmux) don't get one. */}
        {isShell && (
          <View style={styles.keybar}>
            {!!keyError && <Text style={styles.keyError}>{keyError}</Text>}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={styles.keys}
            >
              {ctrl ? (
                <>
                  <Keycap label="ctrl" active onPress={() => setCtrl(false)} />
                  {CTRL_KEYS.map((c) => (
                    <Keycap key={c} label={`^${c.toUpperCase()}`} onPress={() => pressCtrl(c)} />
                  ))}
                </>
              ) : (
                KEYS.map((k) => <Keycap key={k.label} label={k.label} onPress={() => press(k)} />)
              )}
            </ScrollView>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Keycap(props: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.keycap,
        (pressed || props.active) && styles.keycapActive,
      ]}
      onPress={props.onPress}
      hitSlop={4}
    >
      <Text style={styles.keycapText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  title: { alignItems: "center", maxWidth: 220 },
  titleName: { color: colors.fg, fontSize: 16, fontWeight: "600" },
  titleFolder: { color: colors.muted, fontSize: 12, marginTop: 1 },
  web: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center" },
  error: { color: colors.danger, fontSize: 14, padding: 24, textAlign: "center" },
  retry: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: { color: colors.link, fontSize: 15 },
  keybar: {
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  keys: { paddingHorizontal: 6, paddingVertical: 6 },
  keyError: { color: colors.danger, fontSize: 12, paddingHorizontal: 12, paddingTop: 6 },
  keycap: {
    minWidth: 44,
    marginHorizontal: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  keycapActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  keycapText: { color: colors.fg, fontSize: 14, fontWeight: "600" },
});
