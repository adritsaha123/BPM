import { router } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button, Card, Eyebrow, text } from "../components/ui";
import type { WorkoutSummary } from "../engine/summary";
import { useSession } from "../store/session";
import { colors, radius, spacing, zoneColor } from "../theme";

/** After "End workout": time in zone, heart-rate chart, and run stats (engine/summary.ts). */
export default function SummaryScreen() {
  const s = useSession((st) => st.lastSummary);
  const mode = useSession((st) => st.mode);
  // Back to the setup screen already underneath (setup → workout, replaced by this summary).
  const done = () => (router.canDismiss() ? router.dismissAll() : router.replace("/"));

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <View>
          <Eyebrow>Workout complete</Eyebrow>
          <Text style={text.h1}>{s && s.durationMs > 60_000 ? "Nice run." : "Workout saved."}</Text>
        </View>

        {s ? <Body s={s} paceMode={mode === "pace"} /> : <Text style={text.help}>No workout data was recorded.</Text>}

        <View style={{ marginTop: spacing.sm }}>
          <Button label="Done" onPress={done} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Body({ s, paceMode }: { s: WorkoutSummary; paceMode: boolean }) {
  const tracked = s.belowS + s.inS + s.aboveS;
  const pct = (v: number) => (tracked > 0 ? v / tracked : 0);
  return (
    <>
      <Card
        title="Time in zone"
        right={
          <Text style={[styles.bigPct, text.num]}>{tracked > 0 ? `${Math.round(pct(s.inS) * 100)}%` : "--"}</Text>
        }
      >
        <View style={styles.split}>
          {tracked > 0 ? (
            ([
              [s.belowS, 1],
              [s.inS, 0],
              [s.aboveS, -1],
            ] as const)
              .filter(([v]) => v > 0)
              .map(([v, z]) => <View key={z} style={{ flex: v, backgroundColor: zoneColor(z), borderRadius: 7 }} />)
          ) : (
            <View style={{ flex: 1, backgroundColor: colors.surface2, borderRadius: 7 }} />
          )}
        </View>
        <View style={styles.legend}>
          <Legend color={colors.cool} label={`${paceMode ? "Slower" : "Below"} ${clock(s.belowS)}`} />
          <Legend color={colors.ok} label={`In zone ${clock(s.inS)}`} />
          <Legend color={colors.warn} label={`${paceMode ? "Faster" : "Above"} ${clock(s.aboveS)}`} />
        </View>
      </Card>

      {s.hrSeries.length >= 2 && (
        <Card
          title="Heart rate"
          right={<Text style={[text.help, text.num]}>{`avg ${s.avgHr ?? "--"} · max ${s.maxHr ?? "--"}`}</Text>}
        >
          <HrChart s={s} />
        </Card>
      )}

      <View style={styles.grid}>
        <Stat label="Duration" value={clock(s.durationMs / 1000)} />
        <Stat label="Distance" value={s.distanceM >= 50 ? `${(s.distanceM / 1000).toFixed(2)} km` : "--"} />
        <Stat label="Avg cadence" value={s.avgCadence != null ? String(s.avgCadence) : "--"} />
        <Stat label="Tempo changes" value={String(s.tempoChanges)} />
      </View>
    </>
  );
}

const CHART_BARS = 24;
const CHART_H = 120;

/** Bars of average HR over equal slices of the run, colored by where they were vs the zone. */
function HrChart({ s }: { s: WorkoutSummary }) {
  const pts = s.hrSeries;
  const n = Math.min(CHART_BARS, pts.length);
  const bars = Array.from({ length: n }, (_, i) => {
    const slice = pts.slice(Math.floor((i * pts.length) / n), Math.floor(((i + 1) * pts.length) / n));
    const bpm = slice.reduce((a, p) => a + p.bpm, 0) / slice.length;
    const zone = slice[Math.floor(slice.length / 2)].zone;
    return { bpm, zone };
  });
  const lo = Math.min(...bars.map((b) => b.bpm)) - 10;
  const hi = Math.max(...bars.map((b) => b.bpm));
  return (
    <View style={styles.chart}>
      {bars.map((b, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: Math.max(6, ((b.bpm - lo) / Math.max(1, hi - lo)) * CHART_H),
            backgroundColor: zoneColor(b.zone),
            borderRadius: 3,
          }}
        />
      ))}
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[text.help, text.num]}>{label}</Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, text.num]}>{value}</Text>
    </View>
  );
}

function clock(totalS: number) {
  const t = Math.round(totalS);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, paddingTop: spacing.md, gap: 16 },
  bigPct: { fontSize: 28, fontWeight: "800", color: colors.ok },
  split: { flexDirection: "row", height: 14, gap: 3 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chart: { height: CHART_H, flexDirection: "row", alignItems: "flex-end", gap: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: { width: "48.5%", flexGrow: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: 16, gap: 4 },
  statLabel: { fontSize: 12, color: colors.muted },
  statValue: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, color: colors.text },
});
