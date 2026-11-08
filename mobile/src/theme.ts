// One place for colors/spacing so the app looks consistent when 3 people build screens.
// Dark, sporty look from the Figma redesign (https://www.figma.com/design/WRGXQ7mivpMKjUyNnbwlAm): lime = action + music, red = heart rate,
// blue / green / amber = below / in / above the zone.
export const colors = {
  bg: "#0A0B0F",
  card: "#15171E",
  surface2: "#1E212B", // controls inside cards (chips, steppers, segments)
  border: "#2A2E3A",
  text: "#F4F5F8",
  muted: "#8C92A3",
  primary: "#C8FF3D", // electric lime: buttons, selection, music BPM
  onPrimary: "#0A0B0F", // text/icons on lime
  hr: "#FF4D5E", // heart rate
  cool: "#4DA8FF", // below the zone
  ok: "#3DDC97", // in the zone
  warn: "#FFB547", // above the zone
  error: "#FF4D5E",
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 20, xl: 32 };

export const radius = { sm: 12, md: 18, lg: 24 };

/** Where the reading sits vs the zone: +1 below, 0 in, -1 above (engine/controller.ts zoneError). */
export const zoneColor = (err: -1 | 0 | 1 | null) =>
  err == null ? colors.muted : err > 0 ? colors.cool : err < 0 ? colors.warn : colors.ok;
