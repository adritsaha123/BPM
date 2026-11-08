import { setAudioModeAsync } from "expo-audio";

/**
 * The app's audio session, set once before DJ mode plays: sound even with the silent switch on,
 * and keep playing (which keeps the app and its workout loop alive) with the screen locked.
 */
export async function initAudioSession() {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: "duckOthers",
  });
}
