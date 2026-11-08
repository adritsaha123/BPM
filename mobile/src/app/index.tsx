import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { connectWhoop, disconnectWhoop } from "../accounts";
import { api, type WhoopMode, type WhoopSummary } from "../api";
import { prepare, restorePlaylist, useMusicPrep } from "../audio/appleMusicOutput";
import { Artwork, Button, Card, Segmented, Stepper, songCount, text } from "../components/ui";
import { formatPace } from "../engine/controller";
import { startWorkout } from "../engine/workout";
import { whoopHr } from "../sources/whoopBle";
import { useBio, type HrStatus } from "../store/bio";
import { useSession, type ZoneMode } from "../store/session";
import { colors, radius, spacing } from "../theme";

const BAND_TEXT: Record<HrStatus, string> = {
  idle: "Band not connected",
  "bluetooth-off": "Bluetooth is off",
  scanning: "Looking for your band…",
  connecting: "Connecting…",
  connected: "Band connected",
  disconnected: "Connection lost, reconnecting…",
  error: "Couldn't connect",
};

type Account = WhoopMode | "offline" | null; // null = still checking

export default function SetupScreen() {
  const mode = useSession((s) => s.mode);
  const playlist = useSession((s) => s.playlist);
  const hrStatus = useBio((s) => s.hrStatus);
  const prep = useMusicPrep((s) => s.status);

  const [whoop, setWhoop] = useState<WhoopSummary | null>(null);
  const [account, setAccount] = useState<Account>(null);
  const [shared, setShared] = useState(false); // backend's default login, not this user's own
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // This user's WHOOP account status + personal HR zones.
  async function loadWhoop() {
    try {
      const status = await api.whoopStatus();
      setAccount(status.mode);
      setShared(Boolean(status.shared));
      setWhoop(status.mode === "live" && !status.shared ? await api.whoopSummary() : null);
    } catch {
      setAccount("offline");
      setWhoop(null);
    }
  }

  useEffect(() => {
    loadWhoop();
    restorePlaylist().catch(() => {});
  }, []);

  // Get the playlist ready as soon as it's picked, so Start doesn't wait for it.
  const playlistId = playlist?.id;
  useEffect(() => {
    if (playlistId) prepare(playlistId).catch(() => {});
  }, [playlistId]);

  const bandConnected = hrStatus === "connected";
  const needsBand = mode === "hr" && !bandConnected;
  const canStart = !!playlist && prep !== "error" && !needsBand;
  const hint = !playlist
    ? "Choose a playlist to start."
    : prep === "error"
      ? "Your playlist can't play right now. Try again or pick another one."
      : needsBand
        ? "Connect your WHOOP band to start, or set a pace target instead."
        : null;

  async function onStart() {
    setStarting(true);
    setStartError(null);
    try {
      await startWorkout();
      router.push("/workout");
    } catch (e) {
      setStartError(`Couldn't start the workout: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={text.h1}>BPM Coach</Text>
          <Text style={text.help}>Music that keeps you in the zone.</Text>
        </View>

        <WhoopCard account={account} shared={shared} reload={loadWhoop} />
        <ZoneCard whoop={whoop} />
        <MusicCard disabled={starting} />

        {startError && <Text style={text.error}>{startError}</Text>}
        <Button
          label={starting ? "Starting…" : "Start workout"}
          onPress={onStart}
          disabled={!canStart || starting}
          busy={starting}
        />
        {hint && <Text style={[text.help, styles.centerText]}>{hint}</Text>}
        <Button label="Past runs" variant="secondary" onPress={() => router.push("/runs")} />
      </ScrollView>
    </SafeAreaView>
  );
}

/** The band (live heart rate over Bluetooth) and the account (heart rate zones). */
function WhoopCard({ account, shared, reload }: { account: Account; shared: boolean; reload: () => Promise<void> }) {
  const hrStatus = useBio((s) => s.hrStatus);
  const hrDevice = useBio((s) => s.hrDevice);
  const hrError = useBio((s) => s.hrError);
  const hr = useBio((s) => s.hr);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const connected = hrStatus === "connected";
  const searching = hrStatus === "scanning" || hrStatus === "connecting";
  const dot = connected ? colors.ok : searching ? colors.primary : hrStatus === "error" ? colors.error : colors.muted;

  async function onConnectAccount() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await connectWhoop();
      if (!res.ok) setMessage(res.message);
      await reload();
    } catch {
      setMessage("Couldn't open the WHOOP sign-in. Check your internet connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnectAccount() {
    setBusy(true);
    setMessage(null);
    try {
      await disconnectWhoop();
    } catch {
      setMessage("Couldn't disconnect right now. Try again in a moment.");
    } finally {
      await reload();
      setBusy(false);
    }
  }

  const ownAccount = account === "live" && !shared;
  return (
    <Card title="WHOOP">
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={styles.status} numberOfLines={1}>
          {BAND_TEXT[hrStatus]}
          {connected && hrDevice ? ` · ${hrDevice}` : ""}
        </Text>
        {searching && <ActivityIndicator size="small" color={colors.primary} />}
        {connected && hr != null && <Text style={styles.liveHr}>♥ {hr}</Text>}
      </View>
      {hrError && !connected && !searching && <Text style={text.error}>{hrError}</Text>}
      {!connected && (
        <>
          <Text style={text.help}>
            In the WHOOP app, turn on Heart Rate Broadcast and keep the band close to your phone.
          </Text>
          <Button label="Connect band" onPress={() => whoopHr.connect()} disabled={searching} busy={searching} />
        </>
      )}

      <View style={styles.divider} />

      {account === null ? (
        <Text style={text.help}>Checking your WHOOP account…</Text>
      ) : account === "offline" ? (
        <View style={styles.row}>
          <Text style={[text.help, styles.flex]}>Can't check your WHOOP account right now.</Text>
          <TextButton label="Try again" onPress={reload} />
        </View>
      ) : ownAccount ? (
        <View style={styles.row}>
          <Text style={[text.help, styles.flex]}>Your heart rate zones come from your WHOOP account.</Text>
          <TextButton label="Disconnect" onPress={onDisconnectAccount} disabled={busy} />
        </View>
      ) : (
        <>
          <Text style={text.help}>Connect your WHOOP account to use your own heart rate zones.</Text>
          <Button label="Connect account" variant="secondary" onPress={onConnectAccount} disabled={busy} busy={busy} />
        </>
      )}
      {message && <Text style={text.error}>{message}</Text>}
    </Card>
  );
}

function ZoneCard({ whoop }: { whoop: WhoopSummary | null }) {
  const mode = useSession((s) => s.mode);
  const hrZone = useSession((s) => s.hrZone);
  const paceZone = useSession((s) => s.paceZone);
  const { setMode, setZone } = useSession.getState();

  const zone = mode === "hr" ? hrZone : paceZone;
  const step = mode === "hr" ? 1 : 15;
  const fmt = (v: number) => (mode === "hr" ? String(v) : formatPace(v));
  const updateZone = (key: "min" | "max", v: number) => {
    const next = { ...zone, [key]: v };
    if (next.min >= next.max) return; // keep min < max
    setZone(mode, next);
  };
  const zones = mode === "hr" ? (whoop?.hr_zones ?? []) : [];

  return (
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
      {zones.length > 0 && (
        <View style={styles.zones}>
          {zones.map((z) => {
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
          value={zone.min}
          display={fmt(zone.min)}
          step={step}
          onChange={(v) => updateZone("min", v)}
        />
        <View style={{ width: spacing.lg }} />
        <Stepper
          label={mode === "hr" ? "max bpm" : "slowest /km"}
          value={zone.max}
          display={fmt(zone.max)}
          step={step}
          onChange={(v) => updateZone("max", v)}
        />
      </View>
      <Text style={text.help}>
        {mode === "hr"
          ? "The music speeds up when your heart rate is below the zone and slows down when it's above."
          : "The music speeds up when you're slower than the zone and slows down when you're faster."}
      </Text>
    </Card>
  );
}

/** The playlist the workout plays from, and how close its songs are to ready. */
function MusicCard({ disabled }: { disabled: boolean }) {
  const playlist = useSession((s) => s.playlist);
  const prep = useMusicPrep();
  const left = prep.total - prep.checked;

  return (
    <Card title="Music">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playlist ? `Playlist ${playlist.name}. Change playlist` : "Choose a playlist"}
        disabled={disabled}
        onPress={() => router.push("/playlists")}
        style={({ pressed }) => [styles.playlist, pressed && { opacity: 0.8 }]}
      >
        <Artwork uri={playlist?.artworkUri} size={48} />
        <View style={styles.flex}>
          <Text style={styles.playlistName} numberOfLines={1}>
            {playlist ? playlist.name : "Choose a playlist"}
          </Text>
          <Text style={text.help} numberOfLines={1}>
            {playlist ? songCount(prep.total || playlist.count) : "From your Apple Music library"}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      {!playlist ? (
        <Text style={text.help}>
          The workout plays only songs from this playlist, sped up or slowed down a little (pitch kept) so the beat
          matches your target.
        </Text>
      ) : prep.status === "error" ? (
        <>
          <Text style={text.error}>{prep.error}</Text>
          <Button label="Try again" variant="secondary" onPress={() => prepare(playlist.id).catch(() => {})} />
        </>
      ) : prep.status === "ready" ? (
        <View style={styles.row}>
          <View style={[styles.dot, { backgroundColor: colors.ok }]} />
          <Text style={[text.help, styles.flex]}>
            {prep.looking && left > 0
              ? `Ready · checking the tempo of ${songCount(left)} more`
              : `Ready · ${prep.playable} of ${songCount(prep.total)} can play`}
          </Text>
        </View>
      ) : (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[text.help, styles.flex]}>
            {prep.total ? `Getting your songs ready… ${prep.checked} of ${prep.total}` : "Getting your songs ready…"}
          </Text>
        </View>
      )}
    </Card>
  );
}

function TextButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} hitSlop={8}>
      <Text style={[styles.textButton, disabled && { opacity: 0.4 }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, paddingTop: spacing.sm, gap: 16, paddingBottom: spacing.xl },
  header: { gap: 2, paddingVertical: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flex: { flex: 1 },
  centerText: { textAlign: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 15, color: colors.text, flexShrink: 1 },
  liveHr: { marginLeft: "auto", fontSize: 15, fontWeight: "700", color: colors.hr },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  textButton: { fontSize: 14, fontWeight: "700", color: colors.primary },
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
  playlist: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
  },
  playlistName: { fontSize: 16, fontWeight: "700", color: colors.text },
  chevron: { fontSize: 26, color: colors.muted, paddingHorizontal: spacing.xs },
});
