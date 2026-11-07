import { useKeepAwake } from "expo-keep-awake";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card } from "../components/ui";
import { formatPace } from "../engine/controller";
import { stopWorkout } from "../engine/workout";
import { isHrFresh, useBio } from "../store/bio";
import { useSession } from "../store/session";
import { colors, spacing } from "../theme";

export default function WorkoutScreen() {
  useKeepAwake(); // screen stays on while the app is open; background modes handle the locked case

  const mode = useSession((s) => s.mode);
  const zone = useSession((s) => (s.mode === "hr" ? s.hrZone : s.paceZone));
  const running = useSession((s) => s.status === "running");

  useEffect(() => {
    if (!running) router.replace("/");
  }, [running]);

  async function onStop() {
    await stopWorkout();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Elapsed />
      <View style={styles.metrics}>
        <HrTile highlight={mode === "hr"} zoneMin={zone.min} zoneMax={zone.max} />
        <View style={styles.metricRow}>
          <CadenceTile />
          <PaceTile highlight={mode === "pace"} />
        </View>
      </View>

      <Text style={styles.zone}>
        Target {mode === "hr" ? `${zone.min}–${zone.max} bpm` : `${formatPace(zone.min)}–${formatPace(zone.max)} /km`}
      </Text>

      <MusicCard />
      <AdjustmentLog />

      <Button label="End workout" variant="danger" onPress={onStop} />
    </ScrollView>
  );
}

// Each tile subscribes to only its own field, so one HR sample re-renders one tile.

function HrTile({ highlight, zoneMin, zoneMax }: { highlight: boolean; zoneMin: number; zoneMax: number }) {
  const hr = useBio((s) => s.hr);
  const fresh = useBio((s) => isHrFresh(s));
  const status = useBio((s) => s.hrStatus);
  const color = !highlight || hr == null ? colors.text : hr < zoneMin ? colors.primary : hr > zoneMax ? colors.error : colors.ok;
  return (
    <Card style={styles.bigTile}>
      <Text style={styles.label}>Heart rate</Text>
      <Text style={[styles.big, { color: fresh ? color : colors.muted }]}>{hr ?? "--"}</Text>
      <Text style={styles.unit}>{fresh ? "bpm" : status === "connected" ? "waiting for data…" : status}</Text>
    </Card>
  );
}

function CadenceTile() {
  const cadence = useBio((s) => s.cadence);
  return (
    <Card style={styles.tile}>
      <Text style={styles.label}>Cadence</Text>
      <Text style={styles.medium}>{cadence ?? "--"}</Text>
      <Text style={styles.unit}>steps/min</Text>
    </Card>
  );
}

function PaceTile({ highlight }: { highlight: boolean }) {
  const pace = useBio((s) => s.paceSecPerKm);
  return (
    <Card style={styles.tile}>
      <Text style={styles.label}>Pace</Text>
      <Text style={[styles.medium, highlight && { color: colors.primary }]}>{formatPace(pace)}</Text>
      <Text style={styles.unit}>/km</Text>
    </Card>
  );
}

function MusicCard() {
  const bpm = useSession((s) => s.targetBpm);
  const title = useSession((s) => s.trackTitle);
  const rate = useSession((s) => s.playbackRate);
  return (
    <Card title="Music">
      <View style={styles.musicRow}>
        <Text style={styles.medium}>{bpm}</Text>
        <Text style={styles.unit}> BPM target</Text>
      </View>
      <Text style={styles.sub}>
        {title ?? "—"} · {rate.toFixed(2)}×
      </Text>
    </Card>
  );
}

function AdjustmentLog() {
  const adjustments = useSession((s) => s.adjustments);
  if (adjustments.length === 0) return null;
  return (
    <Card title="Adjustments">
      {adjustments.slice(0, 5).map((a) => (
        <Text key={a.at} style={styles.sub}>
          {new Date(a.at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })} · {a.from} → {a.to} BPM ·{" "}
          {a.reason}
        </Text>
      ))}
    </Card>
  );
}

function Elapsed() {
  const startedAt = useSession((s) => s.startedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return <Text style={styles.elapsed}>{`${mm}:${ss}`}</Text>;
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg },
  elapsed: { fontSize: 20, fontWeight: "600", color: colors.muted, textAlign: "center", fontVariant: ["tabular-nums"] },
  metrics: { gap: spacing.md },
  metricRow: { flexDirection: "row", gap: spacing.md },
  bigTile: { alignItems: "center", gap: 0 },
  tile: { flex: 1, alignItems: "center", gap: 0 },
  label: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  big: { fontSize: 88, fontWeight: "800", fontVariant: ["tabular-nums"] },
  medium: { fontSize: 36, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  unit: { fontSize: 13, color: colors.muted },
  zone: { textAlign: "center", fontSize: 15, color: colors.text, fontWeight: "500" },
  musicRow: { flexDirection: "row", alignItems: "baseline" },
  sub: { fontSize: 14, color: colors.muted },
});
