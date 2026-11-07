import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import AIDemoScreen from "./src/screens/AIDemoScreen";
import MusicScreen from "./src/screens/MusicScreen";
import { colors, spacing } from "./src/theme";

const TABS = [
  { key: "music", label: "Music", Screen: MusicScreen },
  { key: "ai", label: "AI", Screen: AIDemoScreen },
] as const;

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("music");
  const { Screen } = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <View style={styles.root}>
      <View style={styles.screen}>
        <Screen />
      </View>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable key={t.key} style={styles.tab} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, t.key === tab && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  screen: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    paddingBottom: spacing.lg,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: spacing.md },
  tabText: { fontSize: 15, color: colors.muted, fontWeight: "500" },
  tabTextActive: { color: colors.primary, fontWeight: "700" },
});
