import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

import { api } from "./api";

/**
 * In-app "Connect WHOOP account":
 *   app → in-app browser → backend /<service>/login → service login → backend /<service>/callback
 *       → backend saves tokens for this user → redirects to the app URL → browser closes
 *
 * Client secrets never touch the phone. The service must be able to redirect to the backend, so
 * its redirect URL has to be a public https address (the cloud deploy, or an ngrok tunnel).
 */
export type ConnectResult = { ok: true } | { ok: false; message: string };
type Service = "whoop";

const NAMES: Record<Service, string> = { whoop: "WHOOP" };

async function connect(service: Service, loginUrl: (returnTo: string) => Promise<string>): Promise<ConnectResult> {
  // exp://<laptop>:8081/--/<service>-connected in Expo Go, bpm://<service>-connected in a build
  const returnTo = Linking.createURL(`${service}-connected`);
  const result = await WebBrowser.openAuthSessionAsync(await loginUrl(returnTo), returnTo);

  if (result.type !== "success") return { ok: false, message: "Sign-in was cancelled." };
  const { queryParams } = Linking.parse(result.url);
  if (queryParams?.[service] === "connected") return { ok: true };
  return { ok: false, message: `${NAMES[service]} sign-in didn't finish. Try again.` };
}

export const connectWhoop = () => connect("whoop", api.whoopLoginUrl);

export async function disconnectWhoop(): Promise<void> {
  await api.whoopDisconnect();
}
