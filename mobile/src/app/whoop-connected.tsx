import { Redirect } from "expo-router";

/**
 * Landing route for the WHOOP login redirect (bpm://whoop-connected or exp://…/--/whoop-connected).
 * Normally the in-app browser catches this URL itself; if the OS opens the app with it instead,
 * just go back to setup, which re-checks the WHOOP status when it loads.
 */
export default function WhoopConnected() {
  return <Redirect href="/" />;
}
