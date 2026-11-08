import AppleMusic, { type AppleMusicSong } from "../../modules/apple-music";
import { api, type TempoInfo } from "../api";
import { useSession } from "../store/session";
import { lockRate, matchTempo, rankForTarget } from "../tempo";

/**
 * Apple Music output for workouts: songs from your library, picked by tempo and sped up or slowed
 * down (pitch kept) so the beat lands on the target BPM. Uses Will's native module
 * (modules/apple-music, docs/APPLE_MUSIC.md), so it needs the Xcode build — not Expo Go.
 *
 * - start: loads the most recently added songs, looks up their tempos (backend /tempo/lookup,
 *   cached), queues the best fits and locks the speed.
 * - setBpm: re-rates the current song when a ±MAX_STRETCH speed change reaches the target,
 *   otherwise switches to a song that fits.
 * - When a song ends and the queue moves on, the new song gets locked to the target too.
 */

const MAX_STRETCH = 0.1; // at most 10% faster/slower, beyond that songs sound off
const SONG_LIMIT = 300; // most recently added songs considered
const LOOKUP_BATCH = 50; // backend limit per /tempo/lookup call
const QUEUE_LENGTH = 25;
const POLL_MS = 1000;

/** The native player, or null where it can't play: Expo Go, web, Android, the iOS Simulator. */
const native = AppleMusic && !AppleMusic.isSimulator ? AppleMusic : null;

let songs: AppleMusicSong[] = [];
const tempos: Record<string, TempoInfo | null> = {}; // kept between workouts
let target = 0;
let currentId: string | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let active = false;

const bpmOf = (s: AppleMusicSong) => tempos[s.id]?.bpm ?? (s.libraryBpm > 0 ? s.libraryBpm : null);
const songById = (id: string | null) => (id ? songs.find((s) => s.id === id) ?? null : null);

/** Whether a speed change within MAX_STRETCH puts this song on the target. */
function fits(song: AppleMusicSong | null, bpm: number): boolean {
  const m = song ? matchTempo(bpmOf(song), bpm) : null;
  return !!m && Math.abs(m.speed_to_match - 1) <= MAX_STRETCH;
}

async function loadLibrary() {
  if (!native) throw new Error("Apple Music needs the Xcode build of the app (it can't run in Expo Go or the Simulator)");
  let auth = await native.getAuthorizationStatus();
  if (auth === "notDetermined") auth = await native.requestAuthorization();
  if (auth !== "authorized") throw new Error("Apple Music access is off. Turn it on in Settings → BPM Coach → Media & Apple Music");

  const page = await native.getSongs(SONG_LIMIT, 0);
  songs = page.songs;
  if (!songs.length) throw new Error("Your Apple Music library has no songs");

  const todo = songs.filter((s) => tempos[s.id] === undefined);
  for (let i = 0; i < todo.length; i += LOOKUP_BATCH) {
    const batch = todo.slice(i, i + LOOKUP_BATCH).map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      duration_s: s.durationS || null,
      library_bpm: s.libraryBpm || null,
    }));
    Object.assign(tempos, (await api.tempoLookup(batch)).tempos);
  }
  if (!songs.some((s) => bpmOf(s))) throw new Error("Couldn't find the tempo of any song in your library");
}

/** Queue the songs that fit the target best (skipping `avoid`) and start the first one. */
async function playBest(bpm: number, avoid?: string | null) {
  const ranked = rankForTarget(songs, bpmOf, bpm).filter((s) => s.id !== avoid);
  if (!ranked.length) throw new Error("No song with a known tempo to play");
  const queue = ranked.slice(0, QUEUE_LENGTH);
  await native!.play(
    queue.map((s) => s.id),
    0,
  );
  currentId = queue[0].id;
  await applyRate();
}

/** Lock the current song's speed to the target and show it as now playing. */
async function applyRate() {
  const song = songById(currentId);
  const songBpm = song ? bpmOf(song) : null;
  const rate = lockRate(songBpm, target, MAX_STRETCH);
  await native!.setRate(rate).catch(() => {});
  const label = song
    ? `${song.title} — ${song.artist} · ${songBpm ? `${Math.round(songBpm)} BPM` : "tempo unknown"}`
    : null;
  useSession.getState().setNowPlaying(label ?? "Apple Music", rate);
}

/** Notice when iOS moves to the next queued song (or the user skips) and lock that one too. */
async function check() {
  if (!active || !native) return;
  try {
    const state = await native.getState();
    const id = state.song?.id ?? null;
    if (id && id !== currentId) {
      currentId = id;
      await applyRate();
    }
  } catch {
    // keep polling; a failed read now and then is harmless
  }
}

export const appleMusicOutput = {
  async start(bpm: number) {
    target = bpm;
    await loadLibrary();
    await playBest(bpm);
    active = true;
    poll = setInterval(check, POLL_MS);
  },

  setBpm(bpm: number) {
    if (!active || bpm === target) return;
    target = bpm;
    if (useSession.getState().musicPaused) return; // resume() picks up the new target
    const run = fits(songById(currentId), bpm) ? applyRate() : playBest(bpm, currentId);
    run.catch(() => {});
  },

  /** Songs come from your own library, so there's no high-energy/calm choice to make. */
  setIntensity() {},

  /** Same tempo, different song (heart rate is holding steady). */
  rotate(): boolean {
    if (!active) return false;
    playBest(target, currentId).catch(() => {});
    return true;
  },

  async pause() {
    if (native && active) await native.pause();
  },

  async resume() {
    if (!native || !active) return;
    if (fits(songById(currentId), target)) {
      await native.resume();
      await applyRate();
    } else {
      await playBest(target, currentId);
    }
  },

  stop() {
    if (poll) clearInterval(poll);
    poll = null;
    const wasActive = active;
    active = false;
    currentId = null;
    if (wasActive) native?.stop().catch(() => {});
  },
};
