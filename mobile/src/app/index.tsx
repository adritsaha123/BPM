import { Link, router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { Button, Card, Segmented, Stepper } from "../components/ui";
import { formatPace } from "../engine/controller";
import { startWorkout } from "../engine/workout";
import { isExpoGo } from "../runtime";
import { whoopHr } from "../sources/whoopBle";
import { useBio, type HrStatus } from "../store/bio";
import { useSession, type ZoneMode } from "../store/session";
import { colors, spacing } from "../theme";

const STATUS_TEXT: Record<HrStatus, string> = {
  idle: "Not connected",
  "bluetooth-off": "Bluetooth is off",
  scanning: "Searching for Whoop…",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected — reconnecting…",
  error: "Couldn't connect",
};

export default function SetupScreen() {
  const hrStatus = useBio((s) => s.hrStatus);
  const hrDevice = useBio((s) => s.hrDevice);
  const hrError = useBio((s) => s.hrError);
  const hr = useBio((s) => s.hr);

  const mode = useSession((s) => s.mode);
  const hrZone = useSession((s) => s.hrZone);
  const paceZone = useSession((s) => s.paceZone);
  const simHr = useSession((s) => s.simHr);
  const simMotion = useSession((s) => s.simMotion);
  const { setMode, setZone, setSimHr, setSimMotion } = useSession.getState();

  const [starting, setStarting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const busy = hrStatus === "scanning" || hrStatus === "connecting";
  const connected = hrStatus === "connected";
  const canStart = simHr || connected;

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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {isExpoGo && (
        <Card style={styles.notice}>
          <Text style={styles.noticeText}>
            Running in Expo Go: Whoop Bluetooth isn't available, so heart rate is simulated. Cadence and pace use your
            phone's real sensors. Keep the app open while testing.
          </Text>
        </Card>
      )}

      <Card title="Heart rate · Whoop">
        <View style={styles.row}>
          <View
            style={[styles.dot, { backgroundColor: simHr || connected ? colors.ok : busy ? colors.primary : colors.muted }]}
          />
          <Text style={styles.status}>
            {simHr ? "Using simulated heart rate" : STATUS_TEXT[hrStatus]}
            {!simHr && hrDevice && connected ? ` · ${hrDevice}` : ""}
          </Text>
          {busy && <ActivityIndicator size="small" />}
          {!simHr && connected && hr != null && <Text style={styles.liveHr}>{hr} bpm</Text>}
        </View>

        {!simHr && (
          <>
            {hrError && <Text style={styles.error}>{hrError}</Text>}
            {!connected && (
              <Text style={styles.help}>
                In the Whoop app, open your device settings and turn on Heart Rate Broadcast. Keep the strap close to
                your phone, then tap Connect.
              </Text>
            )}
            {connected ? (
              <Button label="Disconnect" variant="secondary" onPress={() => whoopHr.disconnect()} />
            ) : (
              <Button label="Connect Whoop" onPress={() => whoopHr.connect()} disabled={busy} />
            )}
          </>
        )}

        <View style={styles.row}>
          <Text style={[styles.status, { flex: 1 }]}>
            Simulated heart rate{isExpoGo ? " (required in Expo Go)" : ""}
          </Text>
          <Switch value={simHr} onValueChange={setSimHr} disabled={isExpoGo} />
        </View>
        <View style={styles.row}>
          <Text style={[styles.status, { flex: 1 }]}>Simulated running (test at a desk)</Text>
          <Switch value={simMotion} onValueChange={setSimMotion} />
        </View>
      </Card>

      <Card title="Target zone">
        <Segmented<ZoneMode>
          options={[
            { value: "hr", label: "Heart rate" },
            { value: "pace", label: "Pace" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <View style={styles.row}>
          <Stepper
            label={mode === "hr" ? "Min bpm" : "Fastest /km"}
            value={zone.min}
            display={fmt(zone.min)}
            step={step}
            onChange={(v) => updateZone("min", v)}
          />
          <View style={{ width: spacing.lg }} />
          <Stepper
            label={mode === "hr" ? "Max bpm" : "Slowest /km"}
            value={zone.max}
            display={fmt(zone.max)}
            step={step}
            onChange={(v) => updateZone("max", v)}
          />
        </View>
      </Card>

      {warnings.map((w) => (
        <Text key={w} style={styles.error}>
          {w}
        </Text>
      ))}

      <Button label={starting ? "Starting…" : "Start workout"} onPress={onStart} disabled={!canStart || starting} />
      {!canStart && <Text style={styles.help}>Connect your Whoop or turn on simulated heart rate to start.</Text>}

      <Link href="/ai" style={styles.link}>
        AI demo →
      </Link>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  status: { fontSize: 15, color: colors.text, flexShrink: 1 },
  liveHr: { marginLeft: "auto", fontSize: 15, fontWeight: "700", color: colors.error },
  help: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  error: { fontSize: 14, color: colors.error },
  notice: { backgroundColor: "#EEF2FF" },
  noticeText: { fontSize: 14, color: colors.text, lineHeight: 20 },
  link: { textAlign: "center", color: colors.primary, fontSize: 14, paddingVertical: spacing.sm },
});
