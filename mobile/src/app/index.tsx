import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { api, type WhoopSummary } from "../api";
import { Button, Card, Segmented, Stepper } from "../components/ui";
import { formatPace } from "../engine/controller";
import { startWorkout } from "../engine/workout";
import { isExpoGo } from "../runtime";
import { relayHr } from "../sources/relayHr";
import { whoopHr } from "../sources/whoopBle";
import { useBio, type HrStatus } from "../store/bio";
import { useSession, type HrSource, type ZoneMode } from "../store/session";
import { colors, spacing } from "../theme";

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
  const { setMode, setZone, setHrSource, setSimMotion } = useSession.getState();

  const [starting, setStarting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [whoop, setWhoop] = useState<WhoopSummary | null>(null);

  // Laptop relay polls while selected so you can see live HR before starting.
  useEffect(() => {
    if (hrSource !== "laptop") return;
    relayHr.start();
    return () => relayHr.stop();
  }, [hrSource]);

  // Personal HR zones from the Whoop history API (sample data until Whoop is connected on the backend).
  useEffect(() => {
    api.whoopSummary().then(setWhoop).catch(() => setWhoop(null));
  }, []);

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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card title="Heart rate · Whoop">
        <Segmented<HrSource> options={SOURCE_OPTIONS} value={hrSource} onChange={changeSource} />

        <View style={styles.row}>
          <View
            style={[styles.dot, { backgroundColor: sim || connected ? colors.ok : busy ? colors.primary : colors.muted }]}
          />
          <Text style={styles.status}>
            {sim ? "Simulated HR (follows your cadence)" : STATUS_TEXT[hrSource][hrStatus]}
            {!sim && hrDevice && connected ? ` · ${hrDevice}` : ""}
          </Text>
          {!sim && busy && <ActivityIndicator size="small" />}
          {!sim && connected && hr != null && <Text style={styles.liveHr}>{hr} bpm</Text>}
        </View>

        {!sim && hrError && !connected && <Text style={styles.error}>{hrError}</Text>}

        {hrSource === "laptop" && !connected && (
          <Text style={styles.help}>
            On the laptop: start the backend, turn on Heart Rate Broadcast in the Whoop app, then run{" "}
            <Text style={styles.code}>python scripts/whoop_live_hr.py</Text> in backend/. Keep the band near the laptop.
          </Text>
        )}

        {hrSource === "phone" && (
          <>
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

        {isExpoGo && (
          <Text style={styles.help}>Phone Bluetooth needs a development build, so it's hidden in Expo Go.</Text>
        )}

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

        {mode === "hr" && whoop && whoop.hr_zones.length > 0 && (
          <View style={{ gap: spacing.sm }}>
            <Text style={styles.help}>
              Your Whoop zones{whoop.mode === "live" ? "" : " (sample data until Whoop is connected on the backend)"}:
            </Text>
            <View style={styles.chips}>
              {whoop.hr_zones.map((z) => {
                const active = hrZone.min === z.min_bpm && hrZone.max === z.max_bpm;
                return (
                  <Pressable
                    key={z.zone}
                    accessibilityRole="button"
                    onPress={() => setZone("hr", { min: z.min_bpm, max: z.max_bpm })}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      Z{z.zone} {z.min_bpm}–{z.max_bpm}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </Card>

      {warnings.map((w) => (
        <Text key={w} style={styles.error}>
          {w}
        </Text>
      ))}

      <Button label={starting ? "Starting…" : "Start workout"} onPress={onStart} disabled={!canStart || starting} />
      {!canStart && <Text style={styles.help}>Waiting for live heart rate, or pick Simulated to start now.</Text>}

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
  code: { fontFamily: "Menlo", fontSize: 13, color: colors.text },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text, fontVariant: ["tabular-nums"] },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  link: { textAlign: "center", color: colors.primary, fontSize: 14, paddingVertical: spacing.sm },
});
