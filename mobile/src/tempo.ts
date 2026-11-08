// Tempo math for the Apple Music player, which runs on the phone. Mirrors backend/app/tempo.py.
import type { TempoMatch } from "./api";

const IN_SYNC_BPM = 3; // |song - target| within this = in sync
const CLOSE_BPM = 8;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** How well a song's tempo fits a target. Half and double time count as the same groove: an
 * 85 BPM song fits a 170 BPM target (one beat every two steps). Same as backend tempo.match(). */
export function matchTempo(songBpm: number | null | undefined, targetBpm: number | null | undefined): TempoMatch | null {
  if (!songBpm || !targetBpm) return null;
  const options: [number, TempoMatch["multiple"]][] = [
    [songBpm, 1],
    [songBpm * 2, 2],
    [songBpm / 2, 0.5],
  ];
  const [effective, multiple] = options.reduce((best, o) =>
    Math.abs(o[0] - targetBpm) < Math.abs(best[0] - targetBpm) ? o : best,
  );
  const diff = effective - targetBpm;
  const status = Math.abs(diff) <= IN_SYNC_BPM ? "in_sync" : Math.abs(diff) <= CLOSE_BPM ? "close" : "off";
  return {
    song_bpm: round1(songBpm),
    target_bpm: round1(targetBpm),
    effective_bpm: round1(effective),
    multiple,
    diff_bpm: round1(diff),
    status,
    speed_to_match: Math.round((targetBpm / effective) * 1000) / 1000,
  };
}

/** Playback speed that puts the song on the target tempo, at most ±maxStretch (0.1 = 10%) away
 * from normal, in 0.5% steps so small heart rate wobbles don't keep nudging the speed. */
export function lockRate(songBpm: number | null | undefined, targetBpm: number | null | undefined, maxStretch: number): number {
  const m = matchTempo(songBpm, targetBpm);
  if (!m) return 1;
  const rate = Math.min(1 + maxStretch, Math.max(1 - maxStretch, m.speed_to_match));
  return Math.round(rate * 200) / 200;
}

/** Songs that can reach the target with the least speed change first; songs without a tempo are left out. */
export function rankForTarget<T>(songs: T[], bpmOf: (s: T) => number | null | undefined, targetBpm: number): T[] {
  return songs
    .map((s) => ({ s, m: matchTempo(bpmOf(s), targetBpm) }))
    .filter((x): x is { s: T; m: TempoMatch } => x.m !== null)
    .sort((a, b) => Math.abs(a.m.speed_to_match - 1) - Math.abs(b.m.speed_to_match - 1))
    .map((x) => x.s);
}
