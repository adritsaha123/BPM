import { Redirect } from "expo-router";

/**
 * Landing route for the Spotify login redirect (bpm://spotify-connected or exp://…/--/spotify-connected).
 * Normally the in-app browser catches this URL itself; if the OS opens the app with it instead,
 * just go back to setup, which re-checks the Spotify status when it loads.
 */
export default function SpotifyConnected() {
  return <Redirect href="/" />;
}
