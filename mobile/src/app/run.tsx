import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { RouteMap } from "../components/RouteMap";
import { Button, Card } from "../components/ui";
import { formatPace } from "../engine/controller";
import {
  formatDate,
  formatDuration,
  route,
  summarize,
  useRoute,
  type RoutePoint,
  type RunSummary,
} from "../sources/route";
import { colors, spacing } from "../theme";

/** One run's route and stats. Opened right after a workout (fresh=1) or from Past runs. */
export default function RunScreen() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const local = useRoute((s) => s.local.find((r) => r.id === id) ?? null);
  const upload = useRoute((s) => s.upload[id]);
  const [remote, setRemote] = useState<(RunSummary & { points: RoutePoint[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Runs from this app session are in memory (works offline); older ones come from the backend.
  useEffect(() => {
    if (local || !id) return;
    route
      .get(id)
      .then(setRemote)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id, local]);

  const summary = useMemo(() => (local ? summarize(local) : remote), [local, remote]);
  const points = local?.points ?? remote?.points ?? [];
  const isFresh = fresh === "1";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: isFresh ? "Workout complete" : "Run", headerBackVisible: !isFresh }} />
      {!summary ? (
        error ? (
          <Card title="Couldn't load this run">
            <Text style={styles.sub}>{error}</Text>
            <Text style={styles.sub}>Check that the phone can reach the backend, then try again.</Text>
          </Card>
        ) : (
          <ActivityIndicator style={{ marginTop: spacing.xl }} />
        )
      ) : (
        <>
          <Text style={styles.date}>{formatDate(summary.started_at)}</Text>
          <RouteMap points={points} style={styles.map} />
          <Stats summary={summary} />
          {local && <UploadStatus state={upload} />}
        </>
      )}
      {isFresh ? (
        <>
          <Button label="Done" onPress={() => router.replace("/")} />
          <Button label="Past runs" variant="secondary" onPress={() => router.replace("/runs")} />
        </>
      ) : null}
    </ScrollView>
  );
}

function Stats({ summary: s }: { summary: RunSummary }) {
  return (
    <View style={styles.grid}>
      <Stat label="Distance" value={s.distance_km.toFixed(2)} unit="km" />
      <Stat label="Time" value={formatDuration(s.duration_min)} unit="min" />
      <Stat label="Pace" value={formatPace(s.pace_min_per_km != null ? s.pace_min_per_km * 60 : null)} unit="/km" />
      <Stat label="Avg HR" value={s.avg_hr != null ? String(s.avg_hr) : "--"} unit="bpm" />
      <Stat label="Max HR" value={s.max_hr != null ? String(s.max_hr) : "--"} unit="bpm" />
    </View>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <Card style={styles.stat}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.unit}>{unit}</Text>
    </Card>
  );
}

function UploadStatus({ state }: { state: string | undefined }) {
  const text =
    state === "saved"
      ? "Saved to your runs."
      : state === "waiting"
        ? "Not uploaded yet: the backend isn't reachable. It retries every minute while the app is open."
        : "Saving…";
  return <Text style={[styles.sub, { textAlign: "center" }, state === "waiting" && { color: colors.warn }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg },
  date: { textAlign: "center", fontSize: 15, color: colors.muted, fontWeight: "500" },
  map: { height: 340 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  stat: { flexBasis: "30%", flexGrow: 1, alignItems: "center", gap: 0, padding: spacing.md },
  label: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  value: { fontSize: 26, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  unit: { fontSize: 12, color: colors.muted },
  sub: { fontSize: 14, color: colors.muted },
});
