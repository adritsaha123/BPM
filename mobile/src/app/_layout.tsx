import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { Splash } from "../components/Splash";
// Registers the background location task at startup (must happen at module load).
import "../sources/location";
import { colors } from "../theme";

export default function RootLayout() {
  const [booting, setBooting] = useState(true);
  const onBooted = useCallback(() => setBooting(false), []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text, fontWeight: "700" },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="workout" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="summary" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="playlists" options={{ title: "Choose a playlist" }} />
        <Stack.Screen name="run" options={{ title: "Run" }} />
        <Stack.Screen name="runs" options={{ title: "Past runs" }} />
      </Stack>
      {booting && <Splash onDone={onBooted} />}
      <StatusBar style="light" />
    </View>
  );
}
