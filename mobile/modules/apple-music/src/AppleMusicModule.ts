import { NativeModule, requireOptionalNativeModule } from "expo";

import type {
  AppleMusicModuleEvents,
  AppleMusicSong,
  AppleMusicState,
  AuthorizationStatus,
  PlayerKind,
} from "./AppleMusic.types";

declare class AppleMusicNativeModule extends NativeModule<AppleMusicModuleEvents> {
  /** true in the iOS Simulator, which has no Apple Music */
  readonly isSimulator: boolean;
  getAuthorizationStatus(): Promise<AuthorizationStatus>;
  requestAuthorization(): Promise<AuthorizationStatus>;
  /** library songs, most recently added first */
  getSongs(limit: number, offset: number): Promise<{ total: number; songs: AppleMusicSong[] }>;
  /** replace the queue with these songs and start playing at startIndex */
  play(ids: string[], startIndex: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  skipToNext(): Promise<void>;
  stop(): Promise<void>;
  /** speed multiplier (1.05 = 5% faster = BPM x 1.05), clamped to 0.5-2.0 */
  setRate(rate: number): Promise<{ desiredRate: number; rate: number }>;
  setPlayerKind(kind: PlayerKind): Promise<void>;
  /** stop the screen from auto-locking (the heart rate sync only runs while the app is open) */
  setKeepScreenOn(on: boolean): Promise<void>;
  getState(): Promise<AppleMusicState>;
}

/**
 * The native Apple Music module, or null where it can't run: Expo Go, web, Android.
 * It needs the custom iPhone build (`npx expo run:ios --device`). See docs/APPLE_MUSIC.md.
 */
const AppleMusic = requireOptionalNativeModule<AppleMusicNativeModule>("AppleMusic");
export default AppleMusic;
