import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { connect, resume } from "../api";
import { colors } from "../theme";
import type { RootStackParamList } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Connect">;

export default function ConnectScreen({ navigation }: Props) {
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);

  // On launch, try to silently resume a saved connection. If the box can't be
  // reached right now, keep the saved URL in the form instead of dropping it.
  useEffect(() => {
    let alive = true;
    resume().then((r) => {
      if (!alive) return;
      if (r.status === "ok") {
        navigation.replace("Sessions");
        return;
      }
      if (r.status === "failed") {
        setUrl(r.conn.base);
        setPassword(r.conn.password);
        setError(r.message);
      }
      setChecking(false);
    });
    return () => {
      alive = false;
    };
  }, [navigation]);

  async function onConnect() {
    setError("");
    setBusy(true);
    try {
      await connect(url, password);
      navigation.replace("Sessions");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.");
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Image source={require("../../assets/icon.png")} style={styles.logo} />
          <Text style={styles.title}>agentpeek</Text>
          <Text style={styles.hint}>
            Connect to the machine that runs your agentpeek server.
          </Text>

          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="box.tailnet.ts.net"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <TextInput
            ref={passwordRef}
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={onConnect}
          />

          {!!error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={onConnect}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Connect</Text>
            )}
          </Pressable>

          <Text style={styles.footnote}>
            Your phone needs to be able to reach the server — usually by running
            Tailscale on both. A bare host name tries HTTPS first, then HTTP;
            add a port if you need one (box:8090).
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 24 },
  center: { alignItems: "center", justifyContent: "center" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  logo: { width: 56, height: 56, alignSelf: "center", borderRadius: 12 },
  title: {
    color: colors.fg,
    fontSize: 20,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 12,
  },
  hint: { color: colors.muted, fontSize: 13, textAlign: "center", marginTop: 4, marginBottom: 12 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.fg,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 10,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 16 },
});
