import * as SecureStore from "expo-secure-store";

/**
 * Anonymous per-install user id. The backend keys each person's WHOOP login by it
 * (sent as the X-User-Id header), so several teammates can connect their own WHOOP.
 * Hackathon-grade: whoever knows the id can read that user's WHOOP data through the backend.
 */
const KEY = "bpm.userId";
let cached: Promise<string> | null = null;

function uuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getUserId(): Promise<string> {
  cached ??= (async () => {
    try {
      const existing = await SecureStore.getItemAsync(KEY);
      if (existing) return existing;
      const id = uuidV4();
      await SecureStore.setItemAsync(KEY, id);
      return id;
    } catch {
      return uuidV4(); // storage unavailable: still works for this session
    }
  })();
  return cached;
}
