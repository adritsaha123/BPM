import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";

import { api } from "../api";
import { colors } from "../theme";

/**
 * Loading screen at app start. The free cloud backend sleeps when idle and takes ~45 s to wake,
 * so instead of a frozen setup screen this shows the logo, a progress bar, and what's happening.
 * Done when /health answers; "Continue" appears if it takes long (the setup screen still opens,
 * but music needs the server).
 */
const EXPECTED_WAKE_MS = 45_000;
const SKIP_AFTER_MS = 8_000;
const MIN_SHOW_MS = 1_200; // don't flash
const GIVE_UP_MS = 90_000;

export function Splash({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState("Starting up…");
  const [canSkip, setCanSkip] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const finished = useRef(false);

  useEffect(() => {
    const started = Date.now();
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    // Creep toward 90% over the expected wake time; the last 10% happens when the backend answers.
    Animated.timing(progress, { toValue: 0.9, duration: EXPECTED_WAKE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();

    const finish = () => {
      if (finished.current) return;
      finished.current = true;
      const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - started));
      setTimeout(() => {
        Animated.timing(progress, { toValue: 1, duration: 250, useNativeDriver: false }).start(() =>
          Animated.timing(fade, { toValue: 0, duration: 300, useNativeDriver: true }).start(onDone),
        );
      }, wait);
    };

    const slow = setTimeout(() => setStep("Waking up the server… (about a minute)"), 2_500);
    const skip = setTimeout(() => setCanSkip(true), SKIP_AFTER_MS);
    const giveUp = setTimeout(finish, GIVE_UP_MS);
    api
      .health()
      .then(() => {
        setStep("Ready");
        finish();
      })
      .catch(() => {
        setStep("Can't reach the server. Music needs it: check your connection.");
        setCanSkip(true);
      });

    return () => {
      loop.stop();
      clearTimeout(slow);
      clearTimeout(skip);
      clearTimeout(giveUp);
    };
  }, [fade, onDone, progress, pulse]);

  const ring = (delay: number) => {
    const t = Animated.modulo(Animated.add(pulse, delay), 1);
    return {
      opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
      transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1.35] }) }],
    };
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      <View style={styles.center}>
        <View style={styles.rings}>
          {[0, 0.33, 0.66].map((d) => (
            <Animated.View key={d} style={[styles.ring, ring(d)]} />
          ))}
          <Logo size={112} />
        </View>
        <View style={{ alignItems: "center" }}>
          <Text style={styles.title}>BPM Coach</Text>
          <Text style={styles.tag}>Music that keeps you in the zone</Text>
        </View>
      </View>

      <View style={styles.bottom}>
        <View style={styles.bar}>
          <Animated.View
            style={[styles.barFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]}
          />
        </View>
        <View style={styles.stepRow}>
          <View style={styles.dot} />
          <Text style={styles.step}>{step}</Text>
        </View>
        {canSkip && (
          <Pressable accessibilityRole="button" onPress={() => Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(onDone)}>
            <Text style={styles.skip}>Continue</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

/** App mark: lime tile with a beat (equalizer bars). */
export function Logo({ size = 112 }: { size?: number }) {
  const s = size / 112;
  const bars = [26, 46, 70, 46, 30];
  return (
    <View style={[styles.logo, { width: size, height: size, borderRadius: 34 * s, gap: 6 * s }]}>
      {bars.map((h, i) => (
        <View key={i} style={{ width: 9 * s, height: h * s, borderRadius: 5 * s, backgroundColor: colors.onPrimary }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, zIndex: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 28 },
  rings: { width: 220, height: 220, alignItems: "center", justifyContent: "center" },
  ring: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  logo: { backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  title: { fontSize: 34, fontWeight: "800", letterSpacing: -0.8, color: colors.text },
  tag: { fontSize: 16, color: colors.muted, marginTop: 6 },
  bottom: { paddingHorizontal: 48, paddingBottom: 72, alignItems: "center", gap: 14 },
  bar: { width: "100%", height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  step: { fontSize: 14, color: colors.muted, textAlign: "center", flexShrink: 1 },
  skip: { fontSize: 15, fontWeight: "700", color: colors.primary, paddingVertical: 8, paddingHorizontal: 16 },
});
