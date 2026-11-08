import { useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { colors, radius, spacing } from "../theme";

export function Card({ title, right, children, style }: { title?: string; right?: ReactNode; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.card, style]}>
      {(title || right) && (
        <View style={styles.cardHead}>
          {title ? <Eyebrow>{title}</Eyebrow> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

/** Small uppercase section label. */
export function Eyebrow({ children, color = colors.muted }: { children: ReactNode; color?: string }) {
  return <Text style={[styles.eyebrow, { color }]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  onLongPress,
  variant = "primary",
  disabled,
  busy,
}: {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
}) {
  const v = VARIANTS[variant];
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={700}
      style={({ pressed }) => [styles.button, { backgroundColor: v.bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
    >
      {busy && <ActivityIndicator color={v.fg} />}
      <Text style={[styles.buttonText, { color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}

const VARIANTS = {
  primary: { bg: colors.primary, fg: colors.onPrimary },
  secondary: { bg: colors.surface2, fg: colors.text },
  danger: { bg: "rgba(255,77,94,0.14)", fg: colors.error },
};

/** Rounded status chip: a colored dot + short text. */
export function Pill({ label, dot, color, bg }: { label: string; dot?: string; color?: string; bg?: string }) {
  return (
    <View style={[styles.pill, bg ? { backgroundColor: bg } : null]}>
      {dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
      <Text style={[styles.pillText, color ? { color } : null]}>{label}</Text>
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="button"
          accessibilityState={{ selected: o.value === value }}
          onPress={() => onChange(o.value)}
          style={[styles.segment, o.value === value && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, o.value === value && styles.segmentTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Stepper({
  label,
  value,
  display,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display?: string;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable accessibilityLabel={`Decrease ${label}`} style={styles.stepperBtn} onPress={() => onChange(value - step)}>
        <Text style={styles.stepperBtnText}>−</Text>
      </Pressable>
      <View style={styles.stepperMid}>
        <Text style={styles.stepperValue}>{display ?? value}</Text>
        <Text style={styles.stepperLabel}>{label}</Text>
      </View>
      <Pressable accessibilityLabel={`Increase ${label}`} style={styles.stepperBtn} onPress={() => onChange(value + step)}>
        <Text style={styles.stepperBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

/** Album or playlist cover, with a music note when there's none (or it can't be loaded). */
export function Artwork({ uri, size = 52 }: { uri?: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const box = { width: size, height: size, borderRadius: size * 0.24 };
  if (uri && failed !== uri) {
    return <Image source={{ uri }} style={[styles.art, box]} onError={() => setFailed(uri)} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[styles.art, box]}>
      <Text style={[styles.artGlyph, { fontSize: size * 0.45 }]}>♪</Text>
    </View>
  );
}

/** "1 song", "12 songs" */
export const songCount = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

export const text = StyleSheet.create({
  h1: { fontSize: 32, fontWeight: "800", letterSpacing: -0.8, color: colors.text },
  body: { fontSize: 15, color: colors.text },
  help: { fontSize: 13, color: colors.muted, lineHeight: 19 },
  error: { fontSize: 13, color: colors.error, lineHeight: 19 },
  num: { fontVariant: ["tabular-nums"] },
});

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 18, gap: 14 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  button: {
    height: 56,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  buttonText: { fontSize: 17, fontWeight: "700" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.surface2,
  },
  pillText: { fontSize: 13, fontWeight: "600", color: colors.text },
  dot: { width: 8, height: 8, borderRadius: 4 },
  segmented: { flexDirection: "row", backgroundColor: colors.surface2, borderRadius: radius.sm, padding: 3 },
  segment: { flex: 1, paddingVertical: spacing.sm, alignItems: "center", borderRadius: 9 },
  segmentActive: { backgroundColor: colors.border },
  segmentText: { fontSize: 14, color: colors.muted, fontWeight: "600" },
  segmentTextActive: { color: colors.text },
  stepper: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepperMid: { alignItems: "center" },
  stepperBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperBtnText: { fontSize: 20, color: colors.text, fontWeight: "500" },
  stepperValue: { fontSize: 28, fontWeight: "800", letterSpacing: -0.8, color: colors.text, fontVariant: ["tabular-nums"] },
  stepperLabel: { fontSize: 12, color: colors.muted },
  art: { backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  artGlyph: { color: colors.primary, fontWeight: "800" },
});
