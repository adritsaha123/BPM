import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";

import type { RoutePoint } from "../sources/route";
import { colors } from "../theme";

/**
 * The run's GPS track on Apple Maps.
 * live: follows the runner and draws the route as it grows.
 * otherwise: zooms to fit the whole route, with start (green) and finish (red) pins.
 */
export function RouteMap({ points, live = false, style }: { points: RoutePoint[]; live?: boolean; style?: ViewStyle }) {
  const map = useRef<MapView>(null);
  const coords = useMemo(() => points.map((p) => ({ latitude: p.lat, longitude: p.lon })), [points]);
  const first = coords[0];
  const last = coords[coords.length - 1];

  const fit = () => {
    if (live || coords.length < 2) return;
    map.current?.fitToCoordinates(coords, {
      edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
      animated: false,
    });
  };

  // Live: keep the newest point in view (without changing the zoom the runner picked).
  useEffect(() => {
    if (live && last) map.current?.animateCamera({ center: last }, { duration: 500 });
  }, [live, last]);

  return (
    <View style={[styles.wrap, style]}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        showsUserLocation={live}
        initialRegion={
          first ? { latitude: first.latitude, longitude: first.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 } : undefined
        }
        onMapReady={fit}
        onLayout={fit}
        pitchEnabled={false}
        toolbarEnabled={false}
      >
        {coords.length > 1 && <Polyline coordinates={coords} strokeColor={colors.primary} strokeWidth={5} lineCap="round" lineJoin="round" />}
        {first && <Marker coordinate={first} pinColor={colors.ok} title="Start" />}
        {!live && last && coords.length > 1 && <Marker coordinate={last} pinColor={colors.error} title="Finish" />}
      </MapView>
      {live && coords.length === 0 && (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>Waiting for GPS…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 260, borderRadius: 16, overflow: "hidden", backgroundColor: colors.border },
  badge: {
    position: "absolute",
    top: 10,
    alignSelf: "center",
    backgroundColor: "rgba(17,24,39,0.75)",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
