export type AuthorizationStatus = "authorized" | "denied" | "restricted" | "notDetermined" | "unknown";
export type PlaybackState = "playing" | "paused" | "stopped" | "interrupted" | "seeking" | "unknown";
/** "app" = plays inside this app; "system" = drives the Music app. */
export type PlayerKind = "app" | "system";

export type AppleMusicSong = {
  /** library persistent id (a UInt64, so it's a string) */
  id: string;
  title: string;
  artist: string;
  album: string;
  durationS: number;
  /** BPM tag stored with the song; 0 when missing (usual for Apple Music songs) */
  libraryBpm: number;
  /** in iCloud / Apple Music, not downloaded to the phone */
  isCloud: boolean;
  /** DRM-protected (Apple Music subscription song) */
  isProtected: boolean;
  /** file:// URI of the cover, only on the now-playing song */
  artworkUri?: string | null;
};

export type AppleMusicState = {
  state: PlaybackState;
  positionS: number;
  /** speed iOS is actually playing at right now */
  rate: number;
  /** speed we asked for */
  desiredRate: number;
  /** how many times iOS snapped the speed back and we re-applied it. If this keeps
   * climbing, this iOS version is ignoring speed changes. */
  rateResets: number;
  playerKind: PlayerKind;
  song?: AppleMusicSong;
};

export type AppleMusicModuleEvents = {
  onPlaybackChange: (event: { state: PlaybackState; songId: string | null }) => void;
};
