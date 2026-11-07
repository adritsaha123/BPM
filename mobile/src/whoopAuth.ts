import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

import { api } from "./api";

/**
 * In-app "Connect WHOOP":
 *   app → in-app browser → backend /whoop/login → WHOOP login → backend /whoop/callback
 *       → backend saves tokens for this user → redirects to the app URL → browser closes
 *
 * The WHOOP client secret never touches the phone. WHOOP must be able to redirect to the
 * backend, so WHOOP_REDIRECT_URI has to be a public https URL (e.g. an ngrok tunnel to the laptop).
 */
export type ConnectResult = { ok: true } | { ok: false; message: string };

export async function connectWhoop(): Promise<ConnectResult> {
  // exp://<laptop>:8081/--/whoop-connected in Expo Go, bpm://whoop-connected in a build
  const returnTo = Linking.createURL("whoop-connected");
  const result = await WebBrowser.openAuthSessionAsync(await api.whoopLoginUrl(returnTo), returnTo);

  if (result.type !== "success") return { ok: false, message: "Login was cancelled." };
  const { queryParams } = Linking.parse(result.url);
  if (queryParams?.whoop === "connected") return { ok: true };
  return { ok: false, message: `WHOOP login failed (${String(queryParams?.reason ?? "unknown error")}).` };
}

export async function disconnectWhoop(): Promise<void> {
  await api.whoopDisconnect();
}
