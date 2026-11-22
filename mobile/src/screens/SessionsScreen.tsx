import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { ApiError, AuthError, fetchSessions, killSession, setArchived } from "../api";
import { clearConnection, loadConnection } from "../storage";
import { colors } from "../theme";
import type { RootStackParamList, Session } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Sessions">;

type Row =
  | {
      type: "folder";
      path: string;
      label: string;
      depth: number;
      count: number;
      open: boolean;
      all: Session[]; // every session in this folder and its sub-folders
    }
  | { type: "session"; session: Session; depth: number; detail?: string };

type SortMode = "folders" | "recent" | "archived";

const TABS: { mode: SortMode; label: string }[] = [
  { mode: "folders", label: "By folder" },
  { mode: "recent", label: "Recent" },
  { mode: "archived", label: "Archived" },
];

interface Node {
  path: string; // absolute directory path (unique key)
  label: string; // one segment, or several joined when a chain was merged
  sessions: Session[];
  children: Node[];
  count: number; // sessions here and in every sub-folder
}

interface Tree {
  root: string; // directory all sessions share; folders are shown relative to it
  nodes: Node[];
  sessions: Session[];
  total: number;
}

const POLL_MS = 5000;
const INDENT = 18; // px per nesting level
const NO_LOCATION = "No location";

const segments = (p: string) => p.split("/").filter(Boolean);

// Sessions are grouped by the directory they run in (their cwd) — the same
// idea as the web UI's "group by folder" view, but nested: a session in
// projects/app/api sits under app › api. Paths are shown relative to the
// deepest directory all sessions share, so the tree starts where they diverge.
function buildTree(sessions: Session[]): Tree {
  const located = sessions.filter((s) => !!s.cwd);
  const paths = located.map((s) => segments(s.cwd!));

  // Common parent: shared leading segments, never consuming a whole cwd (so a
  // lone session still shows its own folder).
  let common: string[] = [];
  if (paths.length > 0) {
    common = paths[0].slice(0, -1);
    for (const p of paths) {
      let i = 0;
      while (i < common.length && i < p.length - 1 && common[i] === p[i]) i++;
      common = common.slice(0, i);
    }
  }
  const root = "/" + common.join("/");

  const top: Node[] = [];
  const find = (list: Node[], label: string, path: string): Node => {
    let n = list.find((x) => x.label === label);
    if (!n) {
      n = { path, label, sessions: [], children: [], count: 0 };
      list.push(n);
    }
    return n;
  };
  located.forEach((s, idx) => {
    const rel = paths[idx].slice(common.length);
    let list = top;
    let node: Node | undefined;
    rel.forEach((seg, i) => {
      node = find(list, seg, "/" + [...common, ...rel.slice(0, i + 1)].join("/"));
      list = node.children;
    });
    node?.sessions.push(s);
  });

  // Sort, count, and merge chains of otherwise-empty single-child folders
  // ("a" › "b" › "c" with sessions only in c becomes one row "a/b/c").
  const finish = (n: Node): Node => {
    n.children = n.children.map(finish).sort((a, b) => a.label.localeCompare(b.label));
    n.sessions.sort((a, b) => a.name.localeCompare(b.name));
    n.count = n.sessions.length + n.children.reduce((sum, c) => sum + c.count, 0);
    if (n.sessions.length === 0 && n.children.length === 1) {
      const only = n.children[0];
      return { ...only, label: `${n.label}/${only.label}` };
    }
    return n;
  };
  const nodes = top.map(finish).sort((a, b) => a.label.localeCompare(b.label));

  const unlocated = sessions.filter((s) => !s.cwd);
  if (unlocated.length > 0) {
    nodes.push({
      path: NO_LOCATION,
      label: NO_LOCATION,
      sessions: unlocated.sort((a, b) => a.name.localeCompare(b.name)),
      children: [],
      count: unlocated.length,
    });
  }
  return { root, nodes, sessions, total: sessions.length };
}

/** When the session last did something: last output, else when it was created. */
const lastActive = (s: Session) => s.activity || s.created || 0;

function ago(epoch: number): string {
  if (!epoch) return "";
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// Flat list, most recently active first; each row names its folder since the
// tree isn't there to show it.
function buildRecentRows(sessions: Session[]): Row[] {
  return [...sessions]
    .sort((a, b) => lastActive(b) - lastActive(a) || a.name.localeCompare(b.name))
    .map((session) => {
      const folder = session.cwd ? segments(session.cwd).pop() : undefined;
      const detail = [folder, ago(lastActive(session))].filter(Boolean).join(" · ");
      return { type: "session", session, depth: 0, detail };
    });
}

function allPaths(tree: Tree): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    out.push(n.path);
    n.children.forEach(walk);
  };
  tree.nodes.forEach(walk);
  return out;
}

function collect(n: Node): Session[] {
  return [...n.sessions, ...n.children.flatMap(collect)];
}

// Flatten the tree into list rows, skipping everything under a closed folder.
function buildRows(tree: Tree, closed: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (n: Node, depth: number) => {
    const open = !closed.has(n.path);
    rows.push({
      type: "folder",
      path: n.path,
      label: n.label,
      depth,
      count: n.count,
      open,
      all: collect(n),
    });
    if (!open) return;
    for (const c of n.children) walk(c, depth + 1);
    for (const session of n.sessions) rows.push({ type: "session", session, depth: depth + 1 });
  };
  for (const n of tree.nodes) walk(n, 0);
  return rows;
}

function statusOf(s: Session): { color: string; label: string } {
  if (s.waiting) return { color: colors.waiting, label: "needs input" };
  if (s.busy) return { color: colors.busy, label: s.foreground || "working" };
  return { color: colors.idle, label: "idle" };
}

export default function SessionsScreen({ navigation }: Props) {
  const [tree, setTree] = useState<Tree>({ root: "/", nodes: [], sessions: [], total: 0 });
  const [archived, setArchivedList] = useState<Session[]>([]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  const load = useCallback(
    async (mode: "initial" | "pull" | "poll") => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (mode === "pull") setRefreshing(true);
      try {
        const conn = await loadConnection();
        if (!conn) {
          navigation.replace("Connect");
          return;
        }
        const sessions = await fetchSessions(conn);
        // The folder and recent views show live sessions; archived ones get
        // their own tab.
        setTree(buildTree(sessions.filter((x) => !x.archived)));
        setArchivedList(sessions.filter((x) => x.archived));
        setError("");
      } catch (e) {
        if (e instanceof AuthError) {
          // Stored password no longer works — the saved URL stays in the form.
          navigation.replace("Connect");
          return;
        }
        setError(e instanceof Error ? e.message : "Failed to load sessions.");
      } finally {
        inFlight.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [navigation],
  );

  // Load on focus, then keep busy/idle state fresh while the screen is visible.
  useFocusEffect(
    useCallback(() => {
      load("initial");
      const timer = setInterval(() => load("poll"), POLL_MS);
      return () => clearInterval(timer);
    }, [load]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <Pressable
          onPress={() =>
            Alert.alert("Disconnect?", "This forgets the saved server and password.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Disconnect",
                style: "destructive",
                onPress: async () => {
                  await clearConnection();
                  navigation.replace("Connect");
                },
              },
            ])
          }
          hitSlop={8}
        >
          <Text style={styles.headerLink}>Disconnect</Text>
        </Pressable>
      ),
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate("NewSession")} hitSlop={8}>
          <Text style={[styles.headerLink, styles.headerStrong]}>New</Text>
        </Pressable>
      ),
    });
  }, [navigation]);

  // Run a server action over some sessions, then refresh. Errors are shown
  // in the banner; an old server without archive support gets a clear message.
  async function run(sessions: Session[], action: "archive" | "unarchive" | "kill") {
    try {
      const conn = await loadConnection();
      if (!conn) return;
      for (const s of sessions) {
        if (action === "kill") await killSession(conn, s.name);
        else await setArchived(conn, s.name, action === "archive");
      }
    } catch (e) {
      if (action !== "kill" && e instanceof ApiError && e.status === 422) {
        setError("This server doesn't support archiving yet — update and restart agentpeek on the server.");
      } else {
        setError(e instanceof Error ? e.message : "That didn't work.");
      }
    }
    await load("poll");
    if (action === "unarchive") {
      // Land back in the main list, by folder, with the restored sessions'
      // folders opened so you can see where they went.
      const cwds = sessions.map((x) => x.cwd).filter((c): c is string => !!c);
      setClosed(
        (prev) =>
          new Set([...prev].filter((p) => !cwds.some((c) => c === p || c.startsWith(p + "/")))),
      );
      setSort("folders");
    }
  }

  function confirmKill(sessions: Session[], title: string) {
    Alert.alert(
      title,
      "This ends the session" +
        (sessions.length > 1 ? "s" : "") +
        " and whatever is running. It can't be undone. Files on the server are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Terminate", style: "destructive", onPress: () => run(sessions, "kill") },
      ],
    );
  }

  function sessionActions(s: Session) {
    Alert.alert(s.name, undefined, [
      s.archived
        ? { text: "Restore", onPress: () => run([s], "unarchive") }
        : { text: "Archive", onPress: () => run([s], "archive") },
      {
        text: "Terminate…",
        style: "destructive",
        onPress: () => confirmKill([s], `Terminate "${s.name}"?`),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  function folderActions(label: string, sessions: Session[]) {
    const n = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    const isArchived = sessions.every((x) => x.archived);
    Alert.alert(label, n, [
      isArchived
        ? { text: "Restore folder", onPress: () => run(sessions, "unarchive") }
        : { text: "Archive folder", onPress: () => run(sessions, "archive") },
      {
        text: "Delete folder…",
        style: "destructive",
        onPress: () => confirmKill(sessions, `Delete "${label}" and terminate its ${n}?`),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  const [sort, setSort] = useState<SortMode>("folders");
  // The Archived tab is the same folder tree, built from archived sessions.
  const archivedTree = useMemo(() => buildTree(archived), [archived]);
  const shownTree = sort === "archived" ? archivedTree : tree;
  const rows = useMemo(
    () =>
      sort === "recent" ? buildRecentRows(tree.sessions) : buildRows(shownTree, closed),
    [tree, shownTree, closed, sort],
  );

  function toggle(path: string) {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={rows}
        keyExtractor={(row) =>
          row.type === "folder" ? `f:${row.path}` : `s:${row.session.kind}:${row.session.name}`
        }
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load("pull")}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item: row }) => {
          const indent = { paddingLeft: 16 + row.depth * INDENT };
          if (row.type === "folder") {
            return (
              <Pressable
                style={({ pressed }) => [styles.folderRow, indent, pressed && styles.rowPressed]}
                onPress={() => toggle(row.path)}
                onLongPress={() => folderActions(row.label, row.all)}
              >
                <Text style={styles.caret}>{row.open ? "▾" : "▸"}</Text>
                <Text style={styles.folderName} numberOfLines={1}>
                  {row.label}
                </Text>
                <Text style={styles.folderCount}>{row.count}</Text>
              </Pressable>
            );
          }
          const item = row.session;
          const status = statusOf(item);
          return (
            <Pressable
              style={({ pressed }) => [styles.row, indent, pressed && styles.rowPressed]}
              onPress={() =>
                navigation.navigate("Terminal", {
                  name: item.name,
                  kind: item.kind,
                  folder: item.cwd ? segments(item.cwd).pop() : undefined,
                })
              }
              onLongPress={() => sessionActions(item)}
            >
              <View style={[styles.dot, { backgroundColor: status.color }]} />
              <View style={styles.rowText}>
                <Text style={styles.rowName}>{item.name}</Text>
                {!!row.detail && (
                  <Text style={styles.rowCwd} numberOfLines={1}>
                    {row.detail}
                  </Text>
                )}
              </View>
              <View style={styles.rowMeta}>
                <Text style={styles.kind}>{item.kind === "ui" ? "chat" : "terminal"}</Text>
                <Text style={[styles.status, { color: status.color }]}>{status.label}</Text>
              </View>
            </Pressable>
          );
        }}
        ListHeaderComponent={
          tree.total + archived.length > 0 ? (
            <View>
              <View style={styles.segment}>
                {TABS.map((t) => (
                  <Pressable
                    key={t.mode}
                    style={[styles.segmentItem, sort === t.mode && styles.segmentActive]}
                    onPress={() => setSort(t.mode)}
                  >
                    <Text
                      style={[styles.segmentText, sort === t.mode && styles.segmentTextActive]}
                      numberOfLines={1}
                    >
                      {t.label}
                      {t.mode === "archived" && archived.length > 0 ? ` (${archived.length})` : ""}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {sort !== "recent" && shownTree.total > 0 && (
                <View style={styles.toolbar}>
                  <Text style={styles.rootPath} numberOfLines={1} ellipsizeMode="head">
                    {shownTree.root}
                  </Text>
                  <Pressable onPress={() => setClosed(new Set())} hitSlop={6}>
                    <Text style={styles.toolbarLink}>Expand all</Text>
                  </Pressable>
                  <Pressable onPress={() => setClosed(new Set(allPaths(shownTree)))} hitSlop={6}>
                    <Text style={styles.toolbarLink}>Collapse all</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : undefined
        }
        ListFooterComponent={
          rows.length > 0 ? (
            <Text style={styles.footer}>
              {sort === "archived"
                ? "Archived sessions keep running. Long-press a session or folder to restore it to the main list."
                : "Long-press a session or folder to archive or delete it."}
            </Text>
          ) : sort === "archived" ? (
            <Text style={styles.footer}>Nothing archived.</Text>
          ) : (
            <View style={styles.emptyBox}>
              <Text style={styles.empty}>
                {archived.length > 0 ? "No active sessions." : "No sessions yet."}
              </Text>
              <Pressable style={styles.emptyButton} onPress={() => navigation.navigate("NewSession")}>
                <Text style={styles.emptyButtonText}>Start a session</Text>
              </Pressable>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center" },
  error: { color: colors.danger, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14 },
  folderRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  caret: { color: colors.muted, fontSize: 14, width: 20 },
  folderName: { flex: 1, color: colors.fg, fontSize: 15, fontWeight: "600" },
  folderCount: { color: colors.muted, fontSize: 13, marginLeft: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.card },
  dot: { width: 9, height: 9, borderRadius: 5, marginRight: 12 },
  rowText: { flex: 1 },
  rowName: { color: colors.fg, fontSize: 16 },
  segment: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: "hidden",
  },
  segmentItem: { flex: 1, paddingVertical: 9, alignItems: "center", backgroundColor: colors.card },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.muted, fontSize: 14 },
  segmentTextActive: { color: "#fff", fontWeight: "600" },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 16,
  },
  rootPath: { flex: 1, color: colors.muted, fontSize: 12, fontFamily: "monospace" },
  toolbarLink: { color: colors.link, fontSize: 14 },
  rowCwd: { color: colors.muted, fontSize: 12, marginTop: 2 },
  rowMeta: { alignItems: "flex-end", marginLeft: 8 },
  kind: { color: colors.muted, fontSize: 12 },
  status: { fontSize: 11, marginTop: 2 },
  headerLink: { color: colors.link, fontSize: 16 },
  headerStrong: { fontWeight: "600" },
  emptyBox: { alignItems: "center", padding: 32 },
  empty: { color: colors.muted, fontSize: 15 },
  emptyButton: {
    marginTop: 16,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  emptyButtonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  footer: { color: colors.muted, fontSize: 12, textAlign: "center", padding: 20 },
});
