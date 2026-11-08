// Pieces shared by the Spotify and Apple Music screens: coach zone picker, heart rate stepper,
// match colors, buttons and base styles.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { Coach, HrZones, TempoMatch } from "../api";
import { colors, spacing } from "../theme";

/** Backend errors look like `403 Forbidden: {"detail":"..."}`; show just the detail. */
export function errorText(e: unknown): string {
  const s = String(e);
  const m = s.match(/"detail":"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : s.replace(/^Error: /, "");
}

export function statusColor(m: TempoMatch | null | undefined): string {
  if (!m) return colors.muted;
  return m.status === "in_sync" ? colors.ok : m.status === "close" ? colors.warn : colors.error;
}

export function statusLabel(m: TempoMatch | null | undefined): string {
  if (!m) return "No match yet";
  if (m.status === "in_sync") return "In sync";
  const sign = m.diff_bpm > 0 ? "+" : "";
  return `${m.status === "close" ? "Close" : "Off"} (${sign}${m.diff_bpm} BPM)`;
}

export const DIRECTION = {
  push: { icon: "↑", text: "Below your zone: songs a step faster to push you up", color: colors.primary },
  hold: { icon: "✓", text: "In your zone: songs match your heart rate", color: colors.ok },
  ease: { icon: "↓", text: "Above your zone: songs a step slower to ease you off", color: colors.warn },
} as const;

function zonesSourceText(source: HrZones["source"] | undefined): string {
  if (source === "whoop") return "zones from your WHOOP";
  if (source === "whoop_mock") return "zones from WHOOP demo data";
  return "zones estimated from a 190 max heart rate (connect WHOOP for yours)";
}

export function CoachBanner({ coach }: { coach: Coach }) {
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

/** "Coach me into" card: Off (just match the heart rate) or a zone, plus what coaching is doing. */
export function ZonePicker(props: {
  zones: HrZones | null;
  zone: number | null;
  onChange: (zone: number | null) => void;
  coach: Coach | null;
}) {
  const { zones, zone, onChange, coach } = props;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Coach me into</Text>
      <View style={styles.zoneRow}>
        <Pressable onPress={() => onChange(null)} style={[styles.zoneChip, zone === null && styles.chipActive]}>
          <Text style={[styles.zoneName, zone === null && styles.chipTextActive]}>Off</Text>
          <Text style={[styles.zoneRange, zone === null && styles.chipTextActive]}>match HR</Text>
        </Pressable>
        {(zones?.zones ?? []).map((z) => (
          <Pressable
            key={z.zone}
            onPress={() => onChange(z.zone)}
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
  );
}

/** No band connected: pretend heart rate, adjustable in steps of 5. */
export function SimulateStepper({ value, onChange }: { value: number; onChange: (bpm: number) => void }) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.body}>No band · simulate</Text>
      <Pressable style={styles.stepBtn} onPress={() => onChange(Math.max(60, value - 5))}>
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <Text style={[styles.body, styles.stepValue]}>{value}</Text>
      <Pressable style={styles.stepBtn} onPress={() => onChange(Math.min(220, value + 5))}>
        <Text style={styles.stepText}>+</Text>
      </Pressable>
      <Text style={styles.body}>BPM</Text>
    </View>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  const off = props.busy || props.disabled;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.button,
        props.primary && styles.buttonPrimary,
        props.disabled && { opacity: 0.4 },
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

/** Styles both music screens use; spread into a screen's StyleSheet.create. */
export const baseStyles = {
  flex: { flex: 1, backgroundColor: colors.bg },
  flex1: { flex: 1 },
  container: { padding: spacing.lg, paddingTop: spacing.xl * 2, gap: spacing.md, paddingBottom: spacing.xl },
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
  trackRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  art: { width: 64, height: 64, borderRadius: 8 },
  artPlaceholder: { backgroundColor: colors.border, alignItems: "center", justifyContent: "center" },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: spacing.sm },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  controls: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
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
} as const;

const styles = StyleSheet.create({
  ...baseStyles,
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
});
