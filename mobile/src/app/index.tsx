import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api, API_URL, type SpotifyMode, type WhoopMode, type WhoopSummary } from "../api";
import { Button, Card, Eyebrow, Pill, Segmented, Stepper, text } from "../components/ui";
import { formatPace } from "../engine/controller";
import { startWorkout } from "../engine/workout";
import { isExpoGo } from "../runtime";
import { relayHr } from "../sources/relayHr";
import { whoopHr } from "../sources/whoopBle";
import { useBio, type HrStatus } from "../store/bio";
import { useSession, type HrSource, type MusicSource, type ZoneMode } from "../store/session";
import { colors, spacing } from "../theme";
import { connectSpotify, connectWhoop, disconnectSpotify, disconnectWhoop } from "../accounts";

const STATUS_TEXT: Record<Exclude<HrSource, "sim">, Record<HrStatus, string>> = {
  phone: {
    idle: "Not connected",
    "bluetooth-off": "Bluetooth is off",
    scanning: "Searching for Whoop…",
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected — reconnecting…",
    error: "Couldn't connect",
  },
  laptop: {
    idle: "Not started",
    "bluetooth-off": "Bluetooth is off",
    scanning: "Waiting for the laptop script…",
    connecting: "Contacting the backend…",
    connected: "Live",
    disconnected: "Stream went stale",
    error: "Can't reach the backend",
  },
};

const WHOOP_MODE_TEXT: Record<WhoopMode | "offline" | "loading", string> = {
  loading: "Checking…",
  live: "Connected: zones and history come from your Whoop",
  not_connected: "Not connected. Connect to use your own HR zones.",
  mock: "Sample data (no Whoop keys on the backend)",
  offline: `Can't reach the backend at ${API_URL}`,
};

const SPOTIFY_MODE_TEXT: Record<SpotifyMode | "offline" | "loading", string> = {
  loading: "",
  live: "Spotify is connected.",
  mock: "Using the demo music library (no Spotify keys on the backend).",
  not_connected: "Spotify isn't connected yet.",
  offline: `Can't reach the backend at ${API_URL}. It may be waking up (~1 min): tap Retry.`,
};

const SOURCE_OPTIONS: { value: HrSource; label: string }[] = [
  { value: "laptop", label: "Laptop relay" },
  ...(isExpoGo ? [] : [{ value: "phone" as const, label: "Phone BT" }]),
  { value: "sim", label: "Simulated" },
];

export default function SetupScreen() {
  const hrStatus = useBio((s) => s.hrStatus);
  const hrDevice = useBio((s) => s.hrDevice);
  const hrError = useBio((s) => s.hrError);
  const hr = useBio((s) => s.hr);

  const mode = useSession((s) => s.mode);
  const hrZone = useSession((s) => s.hrZone);
  const paceZone = useSession((s) => s.paceZone);
  const hrSource = useSession((s) => s.hrSource);
  const simMotion = useSession((s) => s.simMotion);
  const musicSource = useSession((s) => s.musicSource);
  const { setMode, setZone, setHrSource, setSimMotion, setMusicSource } = useSession.getState();
  const [spotifyMode, setSpotifyMode] = useState<SpotifyMode | "offline" | null>(null);
  const [spotifyShared, setSpotifyShared] = useState(false); // borrowing the laptop's login
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyMsg, setSpotifyMsg] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [whoop, setWhoop] = useState<WhoopSummary | null>(null);
  const [whoopMode, setWhoopMode] = useState<WhoopMode | "offline" | null>(null);
  const [whoopShared, setWhoopShared] = useState(false); // borrowing the laptop's login
  const [whoopBusy, setWhoopBusy] = useState(false);
  const [whoopMsg, setWhoopMsg] = useState<string | null>(null);

  // Laptop relay polls while selected so you can see live HR before starting.
  useEffect(() => {
    if (hrSource !== "laptop") return;
    relayHr.start();
    return () => relayHr.stop();
  }, [hrSource]);

  // This user's WHOOP account status + personal HR zones (sample data when the backend has no WHOOP keys).
  async function loadWhoop() {
    try {
      const { mode: m, shared } = await api.whoopStatus();
      setWhoopMode(m);
      setWhoopShared(Boolean(shared));
      setWhoop(m === "not_connected" ? null : await api.whoopSummary());
    } catch {
      setWhoopMode("offline");
      setWhoop(null);
    }
  }
  useEffect(() => {
    loadWhoop();
  }, []);

  async function loadSpotify() {
    try {
      const r = await api.spotifyStatus();
      setSpotifyMode(r.mode);
      setSpotifyShared(Boolean(r.shared));
    } catch {
      setSpotifyMode("offline");
    }
  }
  useEffect(() => {
    if (musicSource === "spotify") loadSpotify();
  }, [musicSource]);

  async function onConnectSpotify() {
    setSpotifyBusy(true);
    setSpotifyMsg(null);
    try {
      const res = await connectSpotify();
      if (!res.ok) setSpotifyMsg(res.message);
      await loadSpotify();
    } catch (e) {
      setSpotifyMsg(`Couldn't open Spotify login: ${String(e)}`);
    } finally {
      setSpotifyBusy(false);
    }
  }

  async function onDisconnectSpotify() {
    setSpotifyBusy(true);
    try {
      await disconnectSpotify();
    } finally {
      await loadSpotify();
      setSpotifyBusy(false);
    }
  }

  async function onConnectWhoop() {
    setWhoopBusy(true);
    setWhoopMsg(null);
    try {
      const res = await connectWhoop();
      if (!res.ok) setWhoopMsg(res.message);
      await loadWhoop();
    } catch (e) {
      setWhoopMsg(`Couldn't open WHOOP login: ${String(e)}`);
    } finally {
      setWhoopBusy(false);
    }
  }

  async function onDisconnectWhoop() {
    setWhoopBusy(true);
    try {
      await disconnectWhoop();
    } finally {
      await loadWhoop();
      setWhoopBusy(false);
    }
  }

  function changeSource(next: HrSource) {
    if (next === hrSource) return;
    if (hrSource === "phone") whoopHr.disconnect();
    setHrSource(next);
  }

  const sim = hrSource === "sim";
  const busy = hrStatus === "scanning" || hrStatus === "connecting";
  const connected = hrStatus === "connected";
  const canStart = sim || connected;

  async function onStart() {
    setStarting(true);
    try {
      const res = await startWorkout();
      setWarnings(res.warnings);
      router.push("/workout");
    } finally {
      setStarting(false);
    }
  }

  const zone = mode === "hr" ? hrZone : paceZone;
  const step = mode === "hr" ? 1 : 15;
  const fmt = (v: number) => (mode === "hr" ? String(v) : formatPace(v));
  const updateZone = (key: "min" | "max", v: number) => {
    const next = { ...zone, [key]: v };
    if (next.min >= next.max) return; // keep min < max
    setZone(mode, next);
  };

  const zoneValue = mode === "hr" ? hrZone : paceZone;
  const liveHr = sim || connected ? hr : null;
  const whoopDot = whoopMode === "live" ? colors.ok : whoopMode === "offline" ? colors.error : colors.muted;
  const hrDot = sim || connected ? colors.ok : busy ? colors.primary : colors.muted;
  const hrChip = sim ? "Simulated HR" : connected ? `HR ${hrSource === "phone" ? "via phone" : "via laptop"}` : "No heart rate";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View>
            <Eyebrow>{canStart ? "Ready to run" : "Getting ready"}</Eyebrow>
            <Text style={text.h1}>BPM Coach</Text>
          </View>
          <Pill label={liveHr != null ? `♥ ${liveHr}` : "♥ --"} color={liveHr != null ? colors.hr : colors.muted} />
        </View>

        <View style={styles.chips}>
          <Pill label="Whoop" dot={whoopDot} />
          <Pill label={hrChip} dot={hrDot} />
          {musicSource === "spotify" && (
            <Pill label="Spotify" dot={spotifyMode === "live" ? colors.ok : spotifyMode === "offline" ? colors.error : colors.muted} />
          )}
        </View>

        <Card title="Heart rate">
          <Segmented<HrSource> options={SOURCE_OPTIONS} value={hrSource} onChange={changeSource} />

          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: hrDot }]} />
            <Text style={styles.status}>
              {sim ? "Simulated HR (follows your cadence)" : STATUS_TEXT[hrSource][hrStatus]}
              {!sim && hrDevice && connected ? ` · ${hrDevice}` : ""}
            </Text>
            {!sim && busy && <ActivityIndicator size="small" color={colors.primary} />}
            {!sim && connected && hr != null && <Text style={styles.liveHr}>{hr} bpm</Text>}
          </View>

          {!sim && hrError && !connected && <Text style={text.error}>{hrError}</Text>}

          {hrSource === "laptop" && !connected && (
            <Text style={text.help}>
              On the laptop: start the backend, turn on Heart Rate Broadcast in the Whoop app, then run{" "}
              <Text style={styles.code}>python scripts/whoop_live_hr.py</Text> in backend/. Keep the band near the laptop.
            </Text>
          )}

          {hrSource === "phone" && (
            <>
              {!connected && (
                <Text style={text.help}>
                  In the Whoop app, open your device settings and turn on Heart Rate Broadcast. Keep the strap close to
                  your phone, then tap Connect.
                </Text>
              )}
              {connected ? (
                <Button label="Disconnect" variant="secondary" onPress={() => whoopHr.disconnect()} />
              ) : (
                <Button label="Connect Whoop" onPress={() => whoopHr.connect()} disabled={busy} busy={busy} />
              )}
            </>
          )}

          {isExpoGo && <Text style={text.help}>Phone Bluetooth needs a development build, so it's hidden in Expo Go.</Text>}

          <View style={styles.row}>
            <Text style={[styles.status, { flex: 1 }]}>Simulated running (test at a desk)</Text>
            <Switch
              value={simMotion}
              onValueChange={setSimMotion}
              trackColor={{ true: colors.primary, false: colors.surface2 }}
              thumbColor={colors.text}
            />
          </View>
        </Card>

        <Card title="Whoop account">
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: whoopDot }]} />
            <Text style={styles.status}>
              {whoopShared ? "Using the laptop's shared Whoop login" : WHOOP_MODE_TEXT[whoopMode ?? "loading"]}
            </Text>
            {whoopBusy && <ActivityIndicator size="small" color={colors.primary} />}
          </View>
          {whoopMsg && <Text style={text.error}>{whoopMsg}</Text>}
          {(whoopMode === "not_connected" || whoopShared) && (
            <Button
              label={whoopShared ? "Connect my own Whoop" : "Connect Whoop account"}
              onPress={onConnectWhoop}
              disabled={whoopBusy}
            />
          )}
          {whoopMode === "live" && !whoopShared && (
            <Button label="Disconnect Whoop account" variant="secondary" onPress={onDisconnectWhoop} disabled={whoopBusy} />
          )}
          {whoopMode === "offline" && <Button label="Retry" variant="secondary" onPress={loadWhoop} />}
        </Card>

        <Card
          title="Target zone"
          right={
            <View style={{ width: 170 }}>
              <Segmented<ZoneMode>
                options={[
                  { value: "hr", label: "Heart rate" },
                  { value: "pace", label: "Pace" },
                ]}
                value={mode}
                onChange={setMode}
              />
            </View>
          }
        >
          {mode === "hr" && whoop && whoop.hr_zones.length > 0 && (
            <View style={styles.zones}>
              {whoop.hr_zones.map((z) => {
                const active = hrZone.min === z.min_bpm && hrZone.max === z.max_bpm;
                return (
                  <Pressable
                    key={z.zone}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setZone("hr", { min: z.min_bpm, max: z.max_bpm })}
                    style={[styles.zoneTile, active && styles.zoneTileActive]}
                  >
                    <Text style={[styles.zoneName, active && styles.onPrimary]}>Z{z.zone}</Text>
                    <Text style={[styles.zoneRange, active && styles.onPrimaryMuted]}>
                      {z.min_bpm}–{z.max_bpm}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          <View style={styles.row}>
            <Stepper
              label={mode === "hr" ? "min bpm" : "fastest /km"}
              value={zoneValue.min}
              display={fmt(zoneValue.min)}
              step={step}
              onChange={(v) => updateZone("min", v)}
            />
            <View style={{ width: spacing.lg }} />
            <Stepper
              label={mode === "hr" ? "max bpm" : "slowest /km"}
              value={zoneValue.max}
              display={fmt(zoneValue.max)}
              step={step}
              onChange={(v) => updateZone("max", v)}
            />
          </View>
          {mode === "hr" && whoop && whoop.mode !== "live" && whoop.hr_zones.length > 0 && (
            <Text style={text.help}>Zones from sample data. Connect your Whoop account for your own.</Text>
          )}
        </Card>

        <Card title="Music">
          <View style={styles.sources}>
            {MUSIC_OPTIONS.map((o) => {
              const active = o.value === musicSource;
              return (
                <Pressable
                  key={o.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setMusicSource(o.value)}
                  style={[styles.source, active && styles.sourceActive]}
                >
                  <View style={styles.sourceIcon}>
                    <Text style={[styles.sourceGlyph, { color: active ? colors.primary : colors.text }]}>{o.glyph}</Text>
                  </View>
                  <Text style={styles.sourceName}>{o.label}</Text>
                  <Text style={styles.sourceDesc}>{o.desc}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={text.help}>
            {musicSource === "dj"
                ? "Real songs from Jamendo (Creative Commons), each locked to the exact BPM and blended into the next like a DJ. Artist and license are shown while playing."
                : `Plays songs from your Liked Songs at the target tempo, switching song by song. Tip: turn on Crossfade in Spotify (Settings → Playback) so songs blend. ${
                    spotifyShared ? "Using the laptop's shared Spotify login." : SPOTIFY_MODE_TEXT[spotifyMode ?? "loading"]
                  }`}
          </Text>
          {musicSource === "spotify" && (
            <>
              {spotifyMsg && <Text style={text.error}>{spotifyMsg}</Text>}
              {(spotifyMode === "not_connected" || spotifyShared) && (
                <Button
                  label={spotifyShared ? "Connect my own Spotify" : "Connect Spotify"}
                  onPress={onConnectSpotify}
                  disabled={spotifyBusy}
                  busy={spotifyBusy}
                />
              )}
              {spotifyMode === "live" && !spotifyShared && (
                <Button label="Disconnect Spotify" variant="secondary" onPress={onDisconnectSpotify} disabled={spotifyBusy} />
              )}
              {spotifyMode === "offline" && <Button label="Retry" variant="secondary" onPress={loadSpotify} />}
              {spotifyMode !== "offline" && (
                <Text style={text.help}>
                  Open Spotify on your phone and play any song first, so there's an active device to control.
                </Text>
              )}
              <Link href="/music" style={styles.link}>
                Spotify music screen →
              </Link>
            </>
          )}
        </Card>

        {warnings.map((w) => (
          <Text key={w} style={text.error}>
            {w}
          </Text>
        ))}

        <Button label={starting ? "Starting…" : "▶  Start workout"} onPress={onStart} disabled={!canStart || starting} busy={starting} />
        {!canStart && (
          <Text style={[text.help, { textAlign: "center" }]}>Waiting for live heart rate, or pick Simulated to start now.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const MUSIC_OPTIONS: { value: MusicSource; label: string; desc: string; glyph: string }[] = [
  { value: "spotify", label: "Spotify", desc: "Your songs, picked by tempo", glyph: "♫" },
  { value: "dj", label: "DJ", desc: "Open songs locked to the beat", glyph: "◉" },
];

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, paddingTop: spacing.sm, gap: 16, paddingBottom: spacing.xl },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 15, color: colors.text, flexShrink: 1 },
  liveHr: { marginLeft: "auto", fontSize: 15, fontWeight: "700", color: colors.hr },
  code: { fontFamily: "Menlo", fontSize: 12, color: colors.text },
  zones: { flexDirection: "row", gap: 6 },
  zoneTile: {
    flex: 1,
    height: 54,
    borderRadius: 14,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  zoneTileActive: { backgroundColor: colors.primary },
  zoneName: { fontSize: 15, fontWeight: "800", color: colors.text },
  zoneRange: { fontSize: 11, color: colors.muted, fontVariant: ["tabular-nums"] },
  onPrimary: { color: colors.onPrimary },
  onPrimaryMuted: { color: "rgba(10,11,15,0.7)" },
  sources: { flexDirection: "row", gap: 10 },
  source: {
    flex: 1,
    borderRadius: 18,
    backgroundColor: colors.surface2,
    padding: 12,
    gap: 8,
    borderWidth: 2,
    borderColor: "transparent",
  },
  sourceActive: { borderColor: colors.primary, backgroundColor: "rgba(200,255,61,0.08)" },
  sourceIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  sourceGlyph: { fontSize: 18, fontWeight: "700" },
  sourceName: { fontSize: 15, fontWeight: "700", color: colors.text },
  sourceDesc: { fontSize: 11, color: colors.muted, lineHeight: 15 },
  link: { textAlign: "center", color: colors.primary, fontSize: 14, fontWeight: "600", paddingVertical: spacing.sm },
});
