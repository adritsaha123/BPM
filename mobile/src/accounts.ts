import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

import { api } from "./api";

/**
 * In-app "Connect WHOOP" / "Connect Spotify":
 *   app → in-app browser → backend /<service>/login → service login → backend /<service>/callback
 *       → backend saves tokens for this user → redirects to the app URL → browser closes
 *
 * Client secrets never touch the phone. The service must be able to redirect to the backend, so
 * its redirect URL has to be a public https address (the cloud deploy, or an ngrok tunnel).
 */
export type ConnectResult = { ok: true } | { ok: false; message: string };
type Service = "whoop" | "spotify";

const NAMES: Record<Service, string> = { whoop: "WHOOP", spotify: "Spotify" };

async function connect(service: Service, loginUrl: (returnTo: string) => Promise<string>): Promise<ConnectResult> {
  // exp://<laptop>:8081/--/<service>-connected in Expo Go, bpm://<service>-connected in a build
  const returnTo = Linking.createURL(`${service}-connected`);
  const result = await WebBrowser.openAuthSessionAsync(await loginUrl(returnTo), returnTo);

  if (result.type !== "success") return { ok: false, message: "Login was cancelled." };
  const { queryParams } = Linking.parse(result.url);
  if (queryParams?.[service] === "connected") return { ok: true };
  return { ok: false, message: `${NAMES[service]} login failed (${String(queryParams?.reason ?? "unknown error")}).` };
}

export const connectWhoop = () => connect("whoop", api.whoopLoginUrl);
export const connectSpotify = () => connect("spotify", api.spotifyLoginUrl);

export async function disconnectWhoop(): Promise<void> {
  await api.whoopDisconnect();
}

export async function disconnectSpotify(): Promise<void> {
  await api.spotifyDisconnect();
}
