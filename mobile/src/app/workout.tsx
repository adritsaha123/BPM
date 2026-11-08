import { useKeepAwake } from "expo-keep-awake";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { music } from "../audio/music";
import { Button, Card, Pill, text } from "../components/ui";
import { formatPace } from "../engine/controller";
import { stopWorkout } from "../engine/workout";
import { isHrFresh, useBio } from "../store/bio";
import { useSession, type Zone } from "../store/session";
import { colors, radius, spacing, zoneColor } from "../theme";

type ZoneErr = -1 | 0 | 1 | null;

/** +1 below, 0 in, -1 above, null no reading (same convention as engine/controller.ts zoneError). */
function where(value: number | null, zone: Zone, pace: boolean): ZoneErr {
  if (value == null) return null;
  if (pace) return value > zone.max ? 1 : value < zone.min ? -1 : 0; // bigger sec/km = slower
  return value < zone.min ? 1 : value > zone.max ? -1 : 0;
}
const ZONE_LABEL = { "1": "Below zone", "0": "In zone", "-1": "Above zone" } as const;

export default function WorkoutScreen() {
  useKeepAwake(); // screen stays on while the app is open; background modes handle the locked case

  const running = useSession((s) => s.status === "running");

  useEffect(() => {
    if (!running) router.replace("/summary");
  }, [running]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <TopBar />
        <Hero />
        <Metrics />
        <MusicCard />
        <LastAdjustment />
        <EndButton />
      </ScrollView>
    </SafeAreaView>
  );
}

function useZoneState() {
  const mode = useSession((s) => s.mode);
  const zone = useSession((s) => (s.mode === "hr" ? s.hrZone : s.paceZone));
  const hr = useBio((s) => (isHrFresh(s) ? s.hr : null));
  const pace = useBio((s) => s.paceSecPerKm);
  const value = mode === "hr" ? hr : pace;
  return { mode, zone, value, err: where(value, zone, mode === "pace") };
}

function TopBar() {
  const { err } = useZoneState();
  const color = zoneColor(err);
  return (
    <View style={styles.topBar}>
      <Elapsed />
      {err != null ? (
        <Pill label={ZONE_LABEL[String(err) as "1" | "0" | "-1"]} dot={color} color={color} bg={`${color}24`} />
      ) : (
        <Pill label="Waiting for data" dot={colors.muted} />
      )}
    </View>
  );
}

function Hero() {
  const { mode, zone, value, err } = useZoneState();
  const status = useBio((s) => s.hrStatus);
  const color = zoneColor(err);
  const big = mode === "hr" ? (value != null ? String(value) : "--") : formatPace(value);
  const unit =
    mode === "hr"
      ? value != null
        ? `bpm · target ${zone.min}–${zone.max}`
        : status === "connected"
          ? "waiting for heart rate…"
          : status
      : `/km · target ${formatPace(zone.min)}–${formatPace(zone.max)}`;
  return (
    <View style={styles.hero}>
      <View style={[styles.ring, { borderColor: err == null ? colors.surface2 : color }]}>
        {mode === "hr" && <Text style={styles.heart}>♥</Text>}
        <Text style={[styles.heroNum, text.num]} adjustsFontSizeToFit numberOfLines={1}>
          {big}
        </Text>
        <Text style={styles.heroUnit}>{unit}</Text>
      </View>
      <View style={styles.zoneBar}>
        {([1, 0, -1] as const).map((z) => (
          <View key={z} style={[styles.zoneSeg, { backgroundColor: err === z ? zoneColor(z) : colors.surface2 }]} />
        ))}
      </View>
    </View>
  );
}

function Metrics() {
  const mode = useSession((s) => s.mode);
  const bpm = useSession((s) => s.targetBpm);
  const cadence = useBio((s) => s.cadence);
  const pace = useBio((s) => s.paceSecPerKm);
  const hr = useBio((s) => (isHrFresh(s) ? s.hr : null));
  return (
    <View style={styles.metrics}>
      <Metric label="Cadence" value={cadence != null ? String(cadence) : "--"} unit="steps/min" />
      {mode === "hr" ? (
        <Metric label="Pace" value={formatPace(pace)} unit="/km" />
      ) : (
        <Metric label="Heart rate" value={hr != null ? String(hr) : "--"} unit="bpm" color={colors.hr} />
      )}
      <Metric label="Music" value={String(bpm)} unit="BPM" color={colors.primary} />
    </View>
  );
}

function Metric({ label, value, unit, color }: { label: string; value: string; unit: string; color?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, text.num, color ? { color } : null]}>{value}</Text>
      <Text style={styles.metricLabel}>{unit}</Text>
    </View>
  );
}

const SOURCE_NAME = { spotify: "Spotify", dj: "DJ" } as const;

function MusicCard() {
  const bpm = useSession((s) => s.targetBpm);
  const title = useSession((s) => s.trackTitle);
  const rate = useSession((s) => s.playbackRate);
  const source = useSession((s) => s.musicSource);
  const paused = useSession((s) => s.musicPaused);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await (paused ? music.resume() : music.pause());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Titles look like "Song — Artist · License" (DJ) or "Song — Artist · 164 BPM" (Spotify).
  const [song, rest] = (title ?? "—").split(" — ");
  const chip = source === "spotify" ? `${bpm} BPM` : `${rate.toFixed(2)}× · ${bpm} BPM`;

  return (
    <Card title={`Now playing · ${SOURCE_NAME[source]}`} right={<Text style={styles.bpmChip}>{paused ? "Paused" : chip}</Text>}>
      <View style={styles.nowRow}>
        <View style={styles.art}>
          <Text style={styles.artGlyph}>♪</Text>
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.song} numberOfLines={1}>
            {song}
          </Text>
          {rest ? (
            <Text style={styles.artist} numberOfLines={1}>
              {rest}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={paused ? "Resume music" : "Pause music"}
          disabled={busy}
          onPress={toggle}
          style={({ pressed }) => [styles.playBtn, { opacity: busy ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          <Text style={styles.playGlyph}>{paused ? "▶" : "❚❚"}</Text>
        </Pressable>
      </View>
      {error && <Text style={text.error}>{error}</Text>}
    </Card>
  );
}

function LastAdjustment() {
  const a = useSession((s) => s.adjustments.find((x) => x.reason !== "start"));
  if (!a) return null;
  const up = a.to > a.from;
  return (
    <View style={styles.adjust}>
      <Text style={[styles.adjustTime, text.num]}>
        {new Date(a.at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}
      </Text>
      <Text style={[styles.adjustMain, text.num]}>
        {a.from} → {a.to} BPM
      </Text>
      <Text style={[styles.adjustReason, { color: up ? colors.cool : colors.warn }]} numberOfLines={1}>
        {a.reason}
      </Text>
    </View>
  );
}

/** Hold (not tap) to end, so a sweaty tap mid-run doesn't stop the workout. */
function EndButton() {
  const [hint, setHint] = useState(false);
  return (
    <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
      <Button label="Hold to end workout" variant="danger" onPress={() => setHint(true)} onLongPress={() => stopWorkout()} />
      {hint && <Text style={[text.help, { textAlign: "center" }]}>Press and hold to end.</Text>}
    </View>
  );
}

function Elapsed() {
  const startedAt = useSession((s) => s.startedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return <Text style={[styles.elapsed, text.num]}>{`${mm}:${ss}`}</Text>;
}

const RING = 210;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, paddingTop: spacing.sm, gap: 14 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  elapsed: { fontSize: 17, fontWeight: "700", color: colors.muted },
  hero: { alignItems: "center", gap: 18, paddingVertical: spacing.sm },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  heart: { fontSize: 20, color: colors.hr },
  heroNum: { fontSize: 64, fontWeight: "800", letterSpacing: -2.5, color: colors.text },
  heroUnit: { fontSize: 12, color: colors.muted, textAlign: "center" },
  zoneBar: { flexDirection: "row", gap: 4, alignSelf: "stretch" },
  zoneSeg: { flex: 1, height: 8, borderRadius: 4 },
  metrics: { flexDirection: "row", gap: 10 },
  metric: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 14, gap: 2 },
  metricLabel: { fontSize: 12, color: colors.muted },
  metricValue: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, color: colors.text },
  bpmChip: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.primary,
    backgroundColor: "rgba(200,255,61,0.12)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    overflow: "hidden",
  },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  art: { width: 56, height: 56, borderRadius: 14, backgroundColor: colors.ok, alignItems: "center", justifyContent: "center" },
  artGlyph: { fontSize: 26, color: colors.onPrimary, fontWeight: "800" },
  song: { fontSize: 17, fontWeight: "700", color: colors.text },
  artist: { fontSize: 13, color: colors.muted },
  playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  playGlyph: { fontSize: 15, fontWeight: "800", color: colors.bg },
  adjust: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  adjustTime: { fontSize: 13, color: colors.muted },
  adjustMain: { fontSize: 13, fontWeight: "700", color: colors.text },
  adjustReason: { fontSize: 13, flex: 1, textAlign: "right" },
});
