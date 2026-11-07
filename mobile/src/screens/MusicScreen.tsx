import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import {
  API_URL,
  api,
  type Coach,
  type HrZones,
  type MatchList,
  type NowPlaying,
  type SpotifyPlaylist,
  type SpotifyTrack,
  type TempoMatch,
} from "../api";
import { colors, spacing } from "../theme";

const POLL_MS = 2000;
const AUTO_DJ_LEAD_MS = 20000; // queue the next match when this much of the song is left

/** Backend errors look like `403 Forbidden: {"detail":"..."}`; show just the detail. */
function errorText(e: unknown): string {
  const s = String(e);
  const m = s.match(/"detail":"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : s.replace(/^Error: /, "");
}

function statusColor(m: TempoMatch | null | undefined): string {
  if (!m) return colors.muted;
  return m.status === "in_sync" ? colors.ok : m.status === "close" ? colors.warn : colors.error;
}

function statusLabel(m: TempoMatch | null | undefined): string {
  if (!m) return "No match yet";
  if (m.status === "in_sync") return "In sync";
  const sign = m.diff_bpm > 0 ? "+" : "";
  return `${m.status === "close" ? "Close" : "Off"} (${sign}${m.diff_bpm} BPM)`;
}

function artistLine(t: SpotifyTrack): string {
  return t.artists.join(", ");
}

const DIRECTION = {
  push: { icon: "↑", text: "Below your zone: songs a step faster to push you up", color: colors.primary },
  hold: { icon: "✓", text: "In your zone: songs match your heart rate", color: colors.ok },
  ease: { icon: "↓", text: "Above your zone: songs a step slower to ease you off", color: colors.warn },
} as const;

function zonesSourceText(source: HrZones["source"] | undefined): string {
  if (source === "whoop") return "zones from your WHOOP";
  if (source === "whoop_mock") return "zones from WHOOP demo data";
  return "zones estimated from a 190 max heart rate (connect WHOOP for yours)";
}

function CoachBanner({ coach }: { coach: Coach }) {
  const d = DIRECTION[coach.direction];
  return (
    <View style={[styles.coachBanner, { borderColor: d.color }]}>
      <Text style={[styles.coachIcon, { color: d.color }]}>{d.icon}</Text>
      <View style={styles.flex1}>
        <Text style={styles.body}>{d.text}</Text>
        <Text style={styles.muted}>
          Zone {coach.zone} is {coach.zone_min}–{coach.zone_max} BPM · music aims for{" "}
          {Math.round(coach.target_bpm)} BPM
        </Text>
      </View>
    </View>
  );
}

/** Live BPM sync: the song's tempo next to your live heart rate, and songs that match it. */
export default function MusicScreen() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [npError, setNpError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [playlistId, setPlaylistId] = useState("liked");
  const [matches, setMatches] = useState<MatchList | null>(null);
  const [fallbackBpm, setFallbackBpm] = useState(125);
  const [zone, setZone] = useState<number | null>(3); // null = just match the heart rate
  const [zones, setZones] = useState<HrZones | null>(null);
  const [autoDj, setAutoDj] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const autoQueuedFor = useRef<string | null>(null);

  const mode = np?.mode;
  const hrLive = np?.heart_rate.live ?? false;
  const current = np?.current_bpm ?? null;
  const target = np?.target_bpm ?? null;
  const coach = np?.coach ?? null;
  const targetBucket = target ? Math.round(target / 4) : null; // refresh matches every ~4 BPM

  // Poll now-playing (song + tempo + heart rate + coach target + match).
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .nowPlaying(fallbackBpm, zone)
        .then((data) => {
          if (!alive) return;
          setNp(data);
          setNpError(null);
        })
        .catch((e) => alive && setNpError(errorText(e)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fallbackBpm, zone]);

  useEffect(() => {
    api.spotifyZones().then(setZones).catch(() => setZones(null));
  }, []);

  // Playlists once Spotify is usable.
  useEffect(() => {
    if (mode !== "live" && mode !== "mock") return;
    api.spotifyPlaylists().then(setPlaylists).catch((e) => setMessage(errorText(e)));
  }, [mode]);

  // Ranked matches for the selected playlist; refresh when the target moves.
  useEffect(() => {
    if (mode !== "live" && mode !== "mock") return;
    api
      .spotifyMatches({ playlistId, fallbackBpm, zone })
      .then(setMatches)
      .catch((e) => setMessage(errorText(e)));
  }, [mode, playlistId, targetBucket, fallbackBpm, zone]);

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      setBusy(label);
      setMessage(null);
      try {
        const done = await fn();
        if (done) setMessage(done);
        setNp(await api.nowPlaying(fallbackBpm, zone));
      } catch (e) {
        setMessage(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [fallbackBpm, zone],
  );

  // Auto-DJ: shortly before the song ends, queue the best match for the current heart rate.
  useEffect(() => {
    const t = np?.track;
    if (!autoDj || !t || !np?.is_playing || !t.duration_ms || np.progress_ms == null) return;
    if (t.duration_ms - np.progress_ms > AUTO_DJ_LEAD_MS || autoQueuedFor.current === t.id) return;
    autoQueuedFor.current = t.id;
    api
      .spotifySync({ playlistId, fallbackBpm, zone })
      .then((r) => setMessage(`Up next: ${r.track.name} (${r.track.tempo} BPM)`))
      .catch((e) => setMessage(errorText(e)));
  }, [np, autoDj, playlistId, fallbackBpm, zone]);

  const track = np?.track ?? null;
  const match = np?.match ?? null;
  const progress = track?.duration_ms && np?.progress_ms != null ? np.progress_ms / track.duration_ms : 0;

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
      <Text style={styles.title}>BPM Sync</Text>
      <Text style={styles.muted}>
        {mode === "mock" && "Spotify: demo library (add Spotify keys to backend/.env for your real music)"}
        {mode === "live" && "Spotify connected"}
        {mode === "not_connected" && "Spotify not connected yet"}
        {!mode && !npError && "Connecting…"}
      </Text>

      {npError && (
        <View style={styles.card}>
          <Text style={[styles.body, { color: colors.error }]}>{npError}</Text>
          <Text style={styles.muted}>Backend: {API_URL}</Text>
        </View>
      )}

      {mode === "not_connected" && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connect Spotify</Text>
          <Text style={styles.body}>
            On the laptop running the backend, open{"\n"}
            <Text style={styles.code}>http://127.0.0.1:8000/spotify/login</Text>
            {"\n"}and sign in. This screen updates by itself.
          </Text>
        </View>
      )}

      {/* Coach mode: which zone to steer toward */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Coach me into</Text>
        <View style={styles.zoneRow}>
          <Pressable onPress={() => setZone(null)} style={[styles.zoneChip, zone === null && styles.chipActive]}>
            <Text style={[styles.zoneName, zone === null && styles.chipTextActive]}>Off</Text>
            <Text style={[styles.zoneRange, zone === null && styles.chipTextActive]}>match HR</Text>
          </Pressable>
          {(zones?.zones ?? []).map((z) => (
            <Pressable
              key={z.zone}
              onPress={() => setZone(z.zone)}
              style={[styles.zoneChip, zone === z.zone && styles.chipActive]}
            >
              <Text style={[styles.zoneName, zone === z.zone && styles.chipTextActive]}>Z{z.zone}</Text>
              <Text style={[styles.zoneRange, zone === z.zone && styles.chipTextActive]}>
                {z.min_bpm}–{z.max_bpm}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.muted}>{zonesSourceText(zones?.source)}</Text>
        {coach && <CoachBanner coach={coach} />}
      </View>

      {/* Heart rate vs song tempo */}
      <View style={styles.card}>
        <View style={styles.bpmRow}>
          <View style={styles.bpmCol}>
            <Text style={styles.bpmLabel}>Heart rate</Text>
            <Text style={styles.bpmValue}>{current != null ? Math.round(current) : "–"}</Text>
            <Text style={styles.muted}>{hrLive ? "live from band" : "simulated (no band)"}</Text>
          </View>
          {coach && coach.direction !== "hold" && (
            <View style={styles.bpmCol}>
              <Text style={styles.bpmLabel}>Music aims</Text>
              <Text style={[styles.bpmValue, { color: DIRECTION[coach.direction].color }]}>
                {Math.round(coach.target_bpm)}
              </Text>
              <Text style={styles.muted}>{coach.direction === "push" ? "a step faster" : "a step slower"}</Text>
            </View>
          )}
          <View style={styles.bpmCol}>
            <Text style={styles.bpmLabel}>Song</Text>
            <Text style={[styles.bpmValue, { color: statusColor(match) }]}>
              {track?.tempo != null ? Math.round(track.tempo) : "–"}
            </Text>
            <Text style={styles.muted}>
              {match && match.multiple !== 1
                ? `feels like ${Math.round(match.effective_bpm)} (${match.multiple === 2 ? "×2" : "½"})`
                : track && track.tempo == null
                  ? "tempo unknown"
                  : "BPM"}
            </Text>
          </View>
        </View>

        <View style={[styles.pill, { backgroundColor: statusColor(match) }]}>
          <Text style={styles.pillText}>{statusLabel(match)}</Text>
        </View>
        {match && match.status !== "in_sync" && (
          <Text style={styles.muted}>
            Would need {match.speed_to_match.toFixed(2)}× speed to lock in. Spotify can't change speed, so
            "Match my BPM" switches to a song that fits instead.
          </Text>
        )}

        {!hrLive && (
          <View style={styles.stepper}>
            <Text style={styles.body}>No band · simulate</Text>
            <Pressable style={styles.stepBtn} onPress={() => setFallbackBpm((b) => Math.max(60, b - 5))}>
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <Text style={[styles.body, styles.stepValue]}>{fallbackBpm}</Text>
            <Pressable style={styles.stepBtn} onPress={() => setFallbackBpm((b) => Math.min(220, b + 5))}>
              <Text style={styles.stepText}>+</Text>
            </Pressable>
            <Text style={styles.body}>BPM</Text>
          </View>
        )}
      </View>

      {/* Now playing + controls */}
      <View style={styles.card}>
        {track ? (
          <View style={styles.trackRow}>
            {track.image ? (
              <Image source={{ uri: track.image }} style={styles.art} />
            ) : (
              <View style={[styles.art, styles.artPlaceholder]}>
                <Text style={styles.muted}>♪</Text>
              </View>
            )}
            <View style={styles.flex1}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {track.name}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {artistLine(track)}
              </Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
              </View>
            </View>
          </View>
        ) : (
          <Text style={styles.muted}>Nothing playing. Start any song in Spotify, or tap a match below.</Text>
        )}

        <View style={styles.controls}>
          <Button
            label={np?.is_playing ? "Pause" : "Play"}
            busy={busy === "toggle"}
            onPress={() => run("toggle", () => (np?.is_playing ? api.spotifyPause() : api.spotifyPlay()))}
          />
          <Button label="Next" busy={busy === "next"} onPress={() => run("next", () => api.spotifyNext())} />
          <Button
            label="Match my BPM"
            primary
            busy={busy === "sync"}
            onPress={() =>
              run("sync", async () => {
                const r = await api.spotifySync({ playlistId, fallbackBpm, zone, playNow: true });
                return `Playing ${r.track.name} (${r.track.tempo} BPM)`;
              })
            }
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.body}>Auto-DJ</Text>
            <Text style={styles.muted}>
              {zone ? `Before each song ends, queues one that steers you into Zone ${zone}` : "Before each song ends, queues one that fits your heart rate"}
            </Text>
          </View>
          <Switch
            value={autoDj}
            onValueChange={(v) => {
              setAutoDj(v);
              autoQueuedFor.current = null;
            }}
          />
        </View>

        {message && <Text style={styles.message}>{message}</Text>}
      </View>

      {/* Playlist picker + ranked matches */}
      {playlists.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {playlists.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => setPlaylistId(p.id)}
              style={[styles.chip, p.id === playlistId && styles.chipActive]}
            >
              <Text style={[styles.chipText, p.id === playlistId && styles.chipTextActive]}>{p.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {matches && matches.tracks.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Best matches for {Math.round(matches.target_bpm ?? 0)} BPM</Text>
          {matches.tracks.map((t) => (
            <Pressable
              key={t.id}
              style={({ pressed }) => [styles.matchRow, pressed && { opacity: 0.6 }]}
              onPress={() => run(`play-${t.id}`, async () => {
                await api.spotifyPlay([t.uri]);
                return `Playing ${t.name}`;
              })}
            >
              <View style={styles.flex1}>
                <Text style={styles.body} numberOfLines={1}>
                  {t.name}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {artistLine(t)}
                  {t.energy != null ? ` · energy ${Math.round(t.energy * 100)}%` : ""}
                </Text>
              </View>
              <Text style={[styles.matchBpm, { color: statusColor(t.match) }]}>
                {t.tempo != null ? Math.round(t.tempo) : "–"}
                {t.match && t.match.multiple !== 1 ? (t.match.multiple === 2 ? " ×2" : " ½") : ""}
              </Text>
            </Pressable>
          ))}
          {matches.no_tempo_count > 0 && (
            <Text style={styles.muted}>{matches.no_tempo_count} songs in this playlist have no tempo data.</Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

function Button(props: { label: string; onPress: () => void; busy?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.busy}
      style={({ pressed }) => [
        styles.button,
        props.primary && styles.buttonPrimary,
        pressed && { opacity: 0.8 },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={props.primary ? "#fff" : colors.primary} />
      ) : (
        <Text style={[styles.buttonText, props.primary && { color: "#fff" }]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  flex1: { flex: 1 },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },
  title: { fontSize: 28, fontWeight: "700", color: colors.text },
  muted: { fontSize: 13, color: colors.muted },
  body: { fontSize: 16, color: colors.text },
  code: { fontFamily: "Courier", fontSize: 14, color: colors.primary },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: spacing.md, gap: spacing.sm },
  cardTitle: { fontSize: 17, fontWeight: "600", color: colors.text },
  bpmRow: { flexDirection: "row" },
  bpmCol: { flex: 1, alignItems: "center", gap: 2 },
  bpmLabel: { fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  bpmValue: { fontSize: 56, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  pill: { alignSelf: "center", borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  pillText: { color: "#fff", fontWeight: "600" },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 20, color: colors.primary },
  stepValue: { minWidth: 36, textAlign: "center", fontWeight: "600" },
  trackRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  art: { width: 64, height: 64, borderRadius: 8 },
  artPlaceholder: { backgroundColor: colors.border, alignItems: "center", justifyContent: "center" },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: spacing.sm },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  controls: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  button: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  buttonPrimary: { backgroundColor: colors.primary, flex: 1.6 },
  buttonText: { color: colors.primary, fontSize: 15, fontWeight: "600" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.sm },
  message: { fontSize: 14, color: colors.text, marginTop: spacing.xs },
  chips: { gap: spacing.sm },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 14 },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  matchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  matchBpm: { fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  zoneRow: { flexDirection: "row", gap: spacing.xs },
  zoneChip: {
    flex: 1,
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
  },
  zoneName: { fontSize: 15, fontWeight: "700", color: colors.text },
  zoneRange: { fontSize: 11, color: colors.muted, fontVariant: ["tabular-nums"] },
  coachBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  coachIcon: { fontSize: 24, fontWeight: "700" },
});
