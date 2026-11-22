import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { createSession, fetchConfig, fetchDirs } from "../api";
import { loadConnection, type Connection } from "../storage";
import { colors } from "../theme";
import type { RootStackParamList, SessionMode } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "NewSession">;

const MODES: { mode: SessionMode; label: string; hint: string }[] = [
  { mode: "ai", label: "Claude Code", hint: "Claude Code running in a terminal" },
  { mode: "shell", label: "Shell", hint: "A plain terminal" },
  { mode: "ui", label: "Chat", hint: "Claude in a chat view" },
];

// Stricter than the server (which also allows spaces): the terminal attach
// script only accepts these characters, so a name with a space couldn't open.
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export default function NewSessionScreen({ navigation }: Props) {
  const [conn, setConn] = useState<Connection | null>(null);
  const [rootName, setRootName] = useState("projects");
  const [mode, setMode] = useState<SessionMode>("ai");
  const [name, setName] = useState("");
  const [path, setPath] = useState(""); // directory being browsed, relative to root
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const c = await loadConnection();
      if (!c) {
        navigation.replace("Connect");
        return;
      }
      setConn(c);
      try {
        const config = await fetchConfig(c);
        setRootName(config.root);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't reach the server.");
      }
    })();
  }, [navigation]);

  const browse = useCallback(
    async (c: Connection, p: string) => {
      setDirs(null);
      try {
        const listing = await fetchDirs(c, p);
        setPath(p);
        setDirs(listing.dirs);
      } catch (e) {
        setDirs([]);
        setError(e instanceof Error ? e.message : "Couldn't list directories.");
      }
    },
    [],
  );

  useEffect(() => {
    if (conn) browse(conn, "");
  }, [conn, browse]);

  const trimmed = name.trim();
  const nameOk = NAME_RE.test(trimmed);
  const canCreate = !!conn && nameOk && path !== "" && !saving;

  async function onCreate() {
    if (!conn || !canCreate) return;
    setError("");
    setSaving(true);
    try {
      await createSession(conn, { name: trimmed, cwd: path, mode });
      navigation.replace("Terminal", {
        name: trimmed,
        kind: mode === "ui" ? "ui" : "shell",
        folder: path.split("/").filter(Boolean).pop(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the session.");
      setSaving(false);
    }
  }

  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="my-session"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
        {trimmed !== "" && !nameOk && (
          <Text style={styles.fieldError}>Use letters, digits, - and _ only.</Text>
        )}

        <Text style={styles.label}>Type</Text>
        <View style={styles.chips}>
          {MODES.map((m) => (
            <Chip key={m.mode} label={m.label} selected={mode === m.mode} onPress={() => setMode(m.mode)} />
          ))}
        </View>
        <Text style={styles.help}>{MODES.find((m) => m.mode === mode)!.hint}</Text>

        <Text style={styles.label}>Folder</Text>
        <View style={styles.browser}>
          <View style={styles.pathRow}>
            <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
              {rootName}/{path}
            </Text>
            {path !== "" && (
              <Pressable onPress={() => conn && browse(conn, parent)} hitSlop={8}>
                <Text style={styles.up}>Up</Text>
              </Pressable>
            )}
          </View>
          {dirs === null ? (
            <ActivityIndicator color={colors.accent} style={styles.dirLoading} />
          ) : dirs.length === 0 ? (
            <Text style={styles.dirEmpty}>No sub-directories here.</Text>
          ) : (
            dirs.map((d) => (
              <Pressable
                key={d}
                style={({ pressed }) => [styles.dirRow, pressed && styles.dirPressed]}
                onPress={() => conn && browse(conn, path ? `${path}/${d}` : d)}
              >
                <Text style={styles.dirName} numberOfLines={1}>
                  {d}
                </Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))
          )}
        </View>
        <Text style={styles.help}>
          {path === ""
            ? `Open a directory inside ${rootName}/ — the session starts in the one shown above.`
            : `The session will start in ${rootName}/${path}.`}
        </Text>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, !canCreate && styles.buttonDisabled]}
          onPress={onCreate}
          disabled={!canCreate}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Create session</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Chip(props: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, props.selected && styles.chipSelected]}
      onPress={props.onPress}
    >
      <Text style={[styles.chipText, props.selected && styles.chipTextSelected]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  label: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 18,
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.fg,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  fieldError: { color: colors.danger, fontSize: 12, marginTop: 6 },
  help: { color: colors.muted, fontSize: 12, marginTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.fg, fontSize: 14 },
  chipTextSelected: { color: "#fff", fontWeight: "600" },
  browser: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.card,
    overflow: "hidden",
  },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  path: { flex: 1, color: colors.fg, fontSize: 13, fontFamily: "monospace" },
  up: { color: colors.link, fontSize: 14, marginLeft: 12 },
  dirLoading: { padding: 16 },
  dirEmpty: { color: colors.muted, fontSize: 13, padding: 14 },
  dirRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dirPressed: { backgroundColor: colors.bg },
  dirName: { flex: 1, color: colors.fg, fontSize: 15 },
  chevron: { color: colors.muted, fontSize: 18 },
  error: { color: colors.danger, fontSize: 13, marginTop: 16 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 20,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
