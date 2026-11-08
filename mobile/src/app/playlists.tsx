import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { AppleMusicPlaylist } from "../../modules/apple-music";
import { MusicAccessError, listPlaylists, musicErrorText } from "../audio/appleMusicOutput";
import { Artwork, Button, songCount, text } from "../components/ui";
import { useSession } from "../store/session";
import { colors, radius, spacing } from "../theme";

/** Pick the Apple Music playlist the workout plays from. */
export default function PlaylistsScreen() {
  const selected = useSession((s) => s.playlist?.id ?? null);
  const [playlists, setPlaylists] = useState<AppleMusicPlaylist[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    setPlaylists(null);
    try {
      setPlaylists(await listPlaylists());
    } catch (e) {
      setError(e ?? "unknown error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function pick(p: AppleMusicPlaylist) {
    useSession.getState().setPlaylist(p);
    router.back();
  }

  if (error != null) {
    const access = error instanceof MusicAccessError;
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{access ? "Apple Music access is off" : "Couldn't load your playlists"}</Text>
        <Text style={[text.help, styles.centerText]}>
          {access ? "Turn on Media & Apple Music for BPM Coach in Settings, then come back." : musicErrorText(error)}
        </Text>
        <View style={styles.actions}>
          {access && <Button label="Open Settings" onPress={() => Linking.openSettings()} />}
          <Button label="Try again" variant="secondary" onPress={load} />
        </View>
      </View>
    );
  }

  if (!playlists) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!playlists.length) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No playlists yet</Text>
        <Text style={[text.help, styles.centerText]}>
          Make a playlist in the Music app (or add one from Apple Music), then come back.
        </Text>
        <View style={styles.actions}>
          <Button label="Refresh" variant="secondary" onPress={load} />
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <FlatList
        data={playlists}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[text.help, styles.intro]}>
            The workout only plays songs from this playlist, sped up or slowed down to your target tempo.
          </Text>
        }
        renderItem={({ item }) => {
          const active = item.id === selected;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => pick(item)}
              style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && { opacity: 0.8 }]}
            >
              <Artwork uri={item.artworkUri} size={52} />
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.count}>{songCount(item.count)}</Text>
              </View>
              {active && <Text style={styles.check}>✓</Text>}
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, gap: spacing.sm },
  intro: { marginBottom: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 10,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: "transparent",
  },
  rowActive: { borderColor: colors.primary },
  rowText: { flex: 1, gap: 3 },
  name: { fontSize: 16, fontWeight: "700", color: colors.text },
  count: { fontSize: 13, color: colors.muted },
  check: { fontSize: 18, fontWeight: "800", color: colors.primary, paddingHorizontal: spacing.sm },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md, backgroundColor: colors.bg },
  centerText: { textAlign: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.text, textAlign: "center" },
  actions: { alignSelf: "stretch", gap: spacing.sm, marginTop: spacing.sm },
});
