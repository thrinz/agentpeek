import { StatusBar } from "expo-status-bar";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";

import ConnectScreen from "./src/screens/ConnectScreen";
import NewSessionScreen from "./src/screens/NewSessionScreen";
import SessionsScreen from "./src/screens/SessionsScreen";
import TerminalScreen from "./src/screens/TerminalScreen";
import { colors } from "./src/theme";
import type { RootStackParamList } from "./src/types";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    text: colors.fg,
    border: colors.border,
    primary: colors.accent,
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.card },
            headerTintColor: colors.fg,
            headerTitleStyle: { color: colors.fg },
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen
            name="Connect"
            component={ConnectScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Sessions"
            component={SessionsScreen}
            options={{ title: "Sessions", headerBackVisible: false }}
          />
          <Stack.Screen
            name="NewSession"
            component={NewSessionScreen}
            options={{ title: "New session", presentation: "modal" }}
          />
          <Stack.Screen name="Terminal" component={TerminalScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
