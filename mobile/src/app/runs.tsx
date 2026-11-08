import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "../components/ui";
import { formatPace } from "../engine/controller";
import { formatDate, formatDuration, route, summarize, useRoute, type RunSummary } from "../sources/route";
import { colors, spacing } from "../theme";

/** Every saved run (backend) plus runs from this session that haven't uploaded yet. */
export default function RunsScreen() {
  const local = useRoute((s) => s.local);
  const upload = useRoute((s) => s.upload);
  const [saved, setSaved] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSaved(await route.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaved((s) => s ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const runs = useMemo(() => {
    const byId = new Map<string, RunSummary>();
    for (const r of saved ?? []) byId.set(r.id, r);
    for (const r of local) if (!byId.has(r.id)) byId.set(r.id, summarize(r));
    return [...byId.values()].sort((a, b) => b.started_at - a.started_at);
  }, [saved, local]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {error && (
        <Text style={[styles.sub, { color: colors.warn }]}>
          Couldn't load your earlier runs, so only the ones from this session are shown.
        </Text>
      )}
      {saved === null ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} />
      ) : runs.length === 0 ? (
        <Card>
          <Text style={styles.sub}>No runs yet. Start a workout outside and your route will show up here.</Text>
        </Card>
      ) : (
        runs.map((r) => (
          <Pressable
            key={r.id}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/run", params: { id: r.id } })}
            style={({ pressed }) => pressed && { opacity: 0.7 }}
          >
            <Card style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.title}>{formatDate(r.started_at)}</Text>
                <Text style={styles.sub}>
                  {formatDuration(r.duration_min)} ·{" "}
                  {formatPace(r.pace_min_per_km != null ? r.pace_min_per_km * 60 : null)} /km
                  {r.avg_hr != null ? ` · ${r.avg_hr} bpm avg` : ""}
                  {upload[r.id] && upload[r.id] !== "saved" ? " · not uploaded" : ""}
                </Text>
              </View>
              <Text style={styles.km}>{r.distance_km.toFixed(2)} km</Text>
            </Card>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md + 2 },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  km: { fontSize: 18, fontWeight: "700", color: colors.primary, fontVariant: ["tabular-nums"] },
  sub: { fontSize: 14, color: colors.muted },
});
