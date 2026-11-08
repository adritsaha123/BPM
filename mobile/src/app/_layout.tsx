import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

// Registers the background location task at startup (must happen at module load).
import "../sources/location";
import { colors } from "../theme";

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.bg },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "BPM Coach" }} />
        <Stack.Screen name="workout" options={{ title: "Workout", gestureEnabled: false, headerBackVisible: false }} />
        <Stack.Screen name="music" options={{ title: "Spotify" }} />
        <Stack.Screen name="run" options={{ title: "Run" }} />
        <Stack.Screen name="runs" options={{ title: "Past runs" }} />
      </Stack>
      <StatusBar style="dark" />
    </>
  );
}
