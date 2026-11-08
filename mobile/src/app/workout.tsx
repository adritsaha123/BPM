import { useKeepAwake } from "expo-keep-awake";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMusicPrep } from "../audio/appleMusicOutput";
import { music } from "../audio/music";
import { RouteMap } from "../components/RouteMap";
import { Artwork, Button, Card, Pill, text } from "../components/ui";
import { formatPace } from "../engine/controller";
import { stopWorkout } from "../engine/workout";
import { summarize, useRoute } from "../sources/route";
import { isHrFresh, isPaceFresh, useBio, type HrStatus } from "../store/bio";
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
        <Notices />
        <Hero />
        <Metrics />
        <LiveRoute />
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
  const pace = useBio((s) => (isPaceFresh(s) ? s.paceSecPerKm : null));
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

/** Under the big number while there's no heart rate. */
const BAND_TEXT: Record<HrStatus, string> = {
  idle: "band not connected",
  "bluetooth-off": "Bluetooth is off",
  scanning: "looking for your band…",
  connecting: "connecting to your band…",
  connected: "waiting for heart rate…",
  disconnected: "band disconnected, reconnecting…",
  error: "can't reach your band",
};

/** Things to know about this run, e.g. "Location access is off". */
function Notices() {
  const notices = useSession((s) => s.notices);
  if (!notices.length) return null;
  return (
    <View style={styles.notices}>
      {notices.map((n) => (
        <Text key={n} style={styles.notice}>
          {n}
        </Text>
      ))}
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
        : BAND_TEXT[status]
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

function MusicCard() {
  const bpm = useSession((s) => s.targetBpm);
  const title = useSession((s) => s.trackTitle);
  const art = useSession((s) => s.trackArt);
  const rate = useSession((s) => s.playbackRate);
  const playlist = useSession((s) => s.playlist);
  const paused = useSession((s) => s.musicPaused);
  const loading = useMusicPrep((s) => s.status === "loading");
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

  // Titles look like "Song — Artist · 164 BPM".
  const [song, rest] = title ? title.split(" — ") : [loading ? "Getting your playlist ready…" : "No music playing", null];
  const chip = `${rate.toFixed(2)}× · ${bpm} BPM`;

  return (
    <Card title="Now playing" right={<Text style={styles.bpmChip}>{paused ? "Paused" : chip}</Text>}>
      <View style={styles.nowRow}>
        <Artwork uri={art} size={56} />
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
          disabled={busy || !title}
          onPress={toggle}
          style={({ pressed }) => [styles.playBtn, { opacity: busy || !title ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          <Text style={styles.playGlyph}>{paused ? "▶" : "❚❚"}</Text>
        </Pressable>
      </View>
      {error && <Text style={text.error}>{error}</Text>}
      {playlist && (
        <Text style={text.help} numberOfLines={1}>
          From {playlist.name}
        </Text>
      )}
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

/** The route so far on a map, with the GPS distance. */
function LiveRoute() {
  const live = useRoute((s) => s.live);
  const km = useMemo(
    () => (live.length > 1 ? summarize({ id: "", started_at: 0, ended_at: 0, points: live }).distance_km : 0),
    [live],
  );
  return (
    <Card title="Route" right={<Text style={[text.help, text.num]}>{`${km.toFixed(2)} km`}</Text>}>
      <RouteMap points={live} live style={{ height: 200 }} />
    </Card>
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
  notices: { backgroundColor: "rgba(255,181,71,0.12)", borderRadius: radius.md, padding: 14, gap: 6 },
  notice: { fontSize: 13, lineHeight: 19, color: colors.warn },
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
