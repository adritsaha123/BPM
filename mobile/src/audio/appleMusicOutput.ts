import { create } from "zustand";

import AppleMusic, { type AppleMusicPlaylist, type AppleMusicSong } from "../../modules/apple-music";
import { api, type TempoInfo, type TempoLookupTrack } from "../api";
import { savedPlaylist, useSession } from "../store/session";
import { lockRate, matchTempo, rankForTarget } from "../tempo";

/**
 * Apple Music for workouts: plays only the playlist picked on the setup screen. Songs are picked
 * by tempo and sped up or slowed down (pitch kept) so the beat lands on the target BPM. Uses the
 * native module in modules/apple-music (docs/APPLE_MUSIC.md), so it needs the Xcode build.
 *
 * - prepare(id): reads the playlist and looks up its songs' tempos (backend /tempo/lookup, about
 *   a second per song the first time). It runs as soon as a playlist is picked: after a small
 *   first batch the playlist is ready to play, and the rest fill in in the background.
 * - start: waits for prepare, queues the songs that fit the target best and locks the speed.
 * - setBpm: re-rates the current song when a ±MAX_STRETCH speed change reaches the target,
 *   otherwise switches to a song that fits.
 * - When a song ends and the queue moves on, the new song gets locked to the target too.
 */

const MAX_STRETCH = 0.1; // at most 10% faster/slower, beyond that songs sound off
const FIRST_BATCH = 10; // tempos looked up before the playlist can play
const LOOKUP_BATCH = 50; // backend limit per /tempo/lookup call
const QUEUE_LENGTH = 25;
const POLL_MS = 1000;

/** The native player, or null where it can't play: Expo Go, web, Android, the iOS Simulator. */
const native = AppleMusic && !AppleMusic.isSimulator ? AppleMusic : null;

type MusicPrep = {
  /** playlist being prepared */
  playlistId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  /** songs in the playlist */
  total: number;
  /** songs whose tempo has been looked up, found or not */
  checked: number;
  /** songs with a known tempo: the ones a workout can play */
  playable: number;
  /** still looking up tempos (also in the background once it's ready) */
  looking: boolean;
  error: string | null;
};

/** Progress of prepare(), for the setup screen. */
export const useMusicPrep = create<MusicPrep>()(() => ({
  playlistId: null,
  status: "idle",
  total: 0,
  checked: 0,
  playable: 0,
  looking: false,
  error: null,
}));

let songs: AppleMusicSong[] = []; // the prepared playlist
const tempos: Record<string, TempoInfo | null> = {}; // kept between workouts and playlists
let prepToken = 0;
let ready: Promise<void> | null = null; // settles once the prepared playlist can play

let target = 0;
let currentId: string | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let active = false;
let runToken = 0; // bumped by stop(), so a start() still waiting gives up

const bpmOf = (s: AppleMusicSong) => tempos[s.id]?.bpm ?? (s.libraryBpm > 0 ? s.libraryBpm : null);
/** Songs with a BPM tag don't need a lookup. */
const looked = (s: AppleMusicSong) => s.libraryBpm > 0 || tempos[s.id] !== undefined;
const songById = (id: string | null) => (id ? (songs.find((s) => s.id === id) ?? null) : null);

const toTrack = (s: AppleMusicSong): TempoLookupTrack => ({
  id: s.id,
  title: s.title,
  artist: s.artist,
  duration_s: s.durationS || null,
  library_bpm: s.libraryBpm || null,
});

/** Error text a runner can act on. */
export function musicErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/network request failed|failed to fetch|timed out/i.test(msg)) {
    return "Can't look up song tempos right now. Check your internet connection and try again.";
  }
  if (/^\d{3} /.test(msg)) return "Song tempos aren't available right now. Try again in a minute."; // backend error
  return msg.replace(/^Error: /, "");
}

/** Apple Music access was turned off for this app: only the Settings app can turn it back on. */
export class MusicAccessError extends Error {}

async function ensureAccess() {
  if (!native) throw new Error("Apple Music only plays in the app installed on your iPhone (not in Expo Go or the Simulator).");
  let auth = await native.getAuthorizationStatus();
  if (auth === "notDetermined") auth = await native.requestAuthorization();
  if (auth !== "authorized") {
    throw new MusicAccessError("Apple Music access is off. Turn it on in Settings → BPM Coach → Media & Apple Music.");
  }
}

/** Your Apple Music playlists, A to Z. Asks for access the first time. */
export async function listPlaylists(): Promise<AppleMusicPlaylist[]> {
  await ensureAccess();
  return native!.getPlaylists();
}

/** Bring back the playlist picked last time, with its current cover and song count. */
export async function restorePlaylist() {
  const saved = await savedPlaylist();
  if (!saved || useSession.getState().playlist) return;
  useSession.setState({ playlist: saved });
  if (!native || (await native.getAuthorizationStatus().catch(() => null)) !== "authorized") return;
  const fresh = (await native.getPlaylists().catch(() => [])).find((p) => p.id === saved.id);
  if (fresh && useSession.getState().playlist?.id === saved.id) useSession.setState({ playlist: fresh });
}

/**
 * Read a playlist and look up its songs' tempos. Resolves as soon as some songs can play (the
 * rest keep loading); rejects when the playlist can't be used. Calling it again for the same
 * playlist reuses the work, unless the last try failed.
 */
export function prepare(id: string): Promise<void> {
  const prep = useMusicPrep.getState();
  if (ready && prep.playlistId === id && prep.status !== "error") return ready;

  const token = ++prepToken;
  useMusicPrep.setState({ playlistId: id, status: "loading", total: 0, checked: 0, playable: 0, looking: true, error: null });
  ready = new Promise<void>((resolve, reject) => {
    load(id, token, resolve).then(resolve, (e) => {
      if (token === prepToken) {
        // A failed background batch after the playlist is ready just leaves fewer songs to pick
        // from; the songs it missed are tried again next time.
        const playable = useMusicPrep.getState().status === "ready";
        useMusicPrep.setState(playable ? { looking: false } : { looking: false, status: "error", error: musicErrorText(e) });
      }
      reject(e);
    });
  });
  ready.catch(() => {}); // the error is shown from useMusicPrep; start() gets it too
  return ready;
}

async function load(id: string, token: number, onReady: () => void) {
  const stale = () => token !== prepToken;
  await ensureAccess();
  const list = await native!.getPlaylistSongs(id);
  if (stale()) return;
  songs = [...new Map(list.map((s) => [s.id, s])).values()]; // a song can be in a playlist twice
  if (!songs.length) throw new Error("This playlist has no songs. Pick another one.");

  const report = () => {
    if (stale()) return;
    const playable = songs.filter((s) => bpmOf(s) != null).length;
    useMusicPrep.setState({ total: songs.length, checked: songs.filter(looked).length, playable });
    if (playable > 0 && useMusicPrep.getState().status === "loading") {
      useMusicPrep.setState({ status: "ready" });
      onReady();
    }
  };
  report();

  const todo = songs.filter((s) => !looked(s));
  for (let i = 0; i < todo.length && !stale(); ) {
    const size = i === 0 ? FIRST_BATCH : LOOKUP_BATCH;
    const batch = todo.slice(i, i + size);
    i += size;
    Object.assign(tempos, (await api.tempoLookup(batch.map(toTrack))).tempos);
    report();
  }
  if (stale()) return;
  if (!songs.some((s) => bpmOf(s) != null)) {
    throw new Error("Couldn't find the tempo of any song in this playlist. Try a different one.");
  }
  useMusicPrep.setState({ looking: false });
}

/** Queue the songs that fit the target best (skipping `avoid`) and start the first one. */
async function playBest(bpm: number, avoid?: string | null) {
  const ranked = rankForTarget(songs, bpmOf, bpm).filter((s) => s.id !== avoid);
  if (!ranked.length) throw new Error("No song in this playlist has a known tempo yet.");
  const queue = ranked.slice(0, QUEUE_LENGTH);
  await native!.play(
    queue.map((s) => s.id),
    0,
  );
  currentId = queue[0].id;
  useSession.setState({ trackArt: null }); // check() shows the new cover
  await applyRate();
}

/** Whether a speed change within MAX_STRETCH puts this song on the target. */
function fits(song: AppleMusicSong | null, bpm: number): boolean {
  const m = song ? matchTempo(bpmOf(song), bpm) : null;
  return !!m && Math.abs(m.speed_to_match - 1) <= MAX_STRETCH;
}

/** Lock the current song's speed to the target and show it as now playing. */
async function applyRate() {
  const song = songById(currentId);
  const songBpm = song ? bpmOf(song) : null;
  const rate = lockRate(songBpm, target, MAX_STRETCH);
  await native!.setRate(rate).catch(() => {});
  const label = song ? `${song.title} — ${song.artist}${songBpm ? ` · ${Math.round(songBpm)} BPM` : ""}` : null;
  useSession.getState().setNowPlaying(label, rate);
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
    const art = state.song?.artworkUri ?? null;
    if (art !== useSession.getState().trackArt) useSession.setState({ trackArt: art });
  } catch {
    // keep polling; a failed read now and then is harmless
  }
}

export const appleMusicOutput = {
  /** Play the selected playlist at this tempo. Waits for prepare() when it's still loading. */
  async start(bpm: number) {
    const id = useSession.getState().playlist?.id;
    if (!id) throw new Error("Pick a playlist first.");
    const run = ++runToken;
    target = bpm;
    await prepare(id);
    if (run !== runToken) return; // the workout ended while the playlist was loading
    await playBest(target);
    if (run !== runToken) return void native?.stop().catch(() => {});
    active = true;
    poll = setInterval(check, POLL_MS);
  },

  setBpm(bpm: number) {
    if (bpm === target) return;
    target = bpm; // also while start() waits, so it starts at the latest target
    if (!active || useSession.getState().musicPaused) return; // resume() picks up the new target
    const next = fits(songById(currentId), bpm) ? applyRate() : playBest(bpm, currentId);
    next.catch(() => {});
  },

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
    runToken++;
    if (poll) clearInterval(poll);
    poll = null;
    const wasActive = active;
    active = false;
    currentId = null;
    useSession.getState().setNowPlaying(null, 1, null);
    if (wasActive) native?.stop().catch(() => {});
  },
};
