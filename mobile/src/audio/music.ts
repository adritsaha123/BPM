import type { Intensity } from "../api";
import { useSession } from "../store/session";
import { djOutput } from "./djOutput";
import { musicPlayer } from "./player";
import { spotifyOutput } from "./spotifyOutput";

/**
 * One interface for the workout loop, whichever music source is selected:
 *  - "builtin": bundled tracks, time-stretched smoothly to the exact BPM (audio/player.ts)
 *  - "spotify": real songs picked by tempo, switching song by song (audio/spotifyOutput.ts)
 *  - "dj": open-license songs streamed and time-stretched to the exact BPM, with crossfades (audio/djOutput.ts)
 */
const source = () => useSession.getState().musicSource;

export const music = {
  async start(bpm: number) {
    useSession.getState().setMusicPaused(false);
    if (source() === "spotify") return spotifyOutput.start(bpm);
    await musicPlayer.init(); // audio session (plays in silent mode, keeps running when locked)
    if (source() === "dj") return djOutput.start(bpm);
    musicPlayer.start(bpm);
  },

  setBpm(bpm: number) {
    if (source() === "spotify") spotifyOutput.setBpm(bpm);
    else if (source() === "dj") djOutput.setBpm(bpm);
    else musicPlayer.setBpm(bpm);
  },

  /** Spotify and DJ: favor high-energy songs (push) or calmer ones (ease). Built-in tracks ignore it. */
  setIntensity(intensity: Intensity) {
    if (source() === "spotify") spotifyOutput.setIntensity(intensity);
    if (source() === "dj") djOutput.setIntensity(intensity);
  },

  /** Switch to a different song at the same tempo (the heart rate is holding steady).
   *  Spotify already changes songs at the end of each one, and a mid-song cut there is abrupt on
   *  iPhone, so it's left alone. Returns whether a switch started. */
  rotate(bpm: number): boolean {
    if (useSession.getState().musicPaused) return false;
    if (source() === "dj") return djOutput.rotate();
    if (source() === "builtin") return musicPlayer.rotate(bpm);
    return false;
  },

  /** Pause the music; the workout and coach keep running, so resume() plays at the current target.
   *  Spotify goes through the backend, so it can fail (e.g. Spotify closed): that throws. */
  async pause() {
    if (source() === "spotify") await spotifyOutput.pause();
    else if (source() === "dj") djOutput.pause();
    else musicPlayer.pause();
    useSession.getState().setMusicPaused(true);
  },

  async resume() {
    if (source() === "spotify") await spotifyOutput.resume();
    else if (source() === "dj") djOutput.resume();
    else musicPlayer.resume();
    useSession.getState().setMusicPaused(false);
  },

  stop() {
    useSession.getState().setMusicPaused(false);
    spotifyOutput.stop();
    djOutput.stop();
    musicPlayer.stop();
  },
};
