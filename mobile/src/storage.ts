import * as SecureStore from "expo-secure-store";

// Credentials live in the OS keychain/keystore (via expo-secure-store), never in
// plain AsyncStorage. We persist them so the app can silently re-login when the
// agentpeek session cookie expires (7-day TTL in app/auth.py) or on cold start.
const KEY = "agentpeek.connection";

export interface Connection {
  base: string; // normalized, no trailing slash, e.g. https://box.tailnet.ts.net
  password: string;
}

export async function saveConnection(conn: Connection): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(conn));
}

export async function loadConnection(): Promise<Connection | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.base === "string" && typeof parsed?.password === "string") {
      return parsed as Connection;
    }
  } catch {
    // corrupt entry — treat as no connection.
  }
  return null;
}

export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
