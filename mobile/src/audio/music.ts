import type { Intensity } from "../api";
import { useSession } from "../store/session";
import { musicPlayer } from "./player";
import { spotifyOutput } from "./spotifyOutput";

/**
 * One interface for the workout loop, whichever music source is selected:
 *  - "builtin": bundled tracks, time-stretched smoothly to the exact BPM (audio/player.ts)
 *  - "spotify": real songs picked by tempo, switching song by song (audio/spotifyOutput.ts)
 */
const source = () => useSession.getState().musicSource;

export const music = {
  async start(bpm: number) {
    if (source() === "spotify") return spotifyOutput.start(bpm);
    await musicPlayer.init();
    musicPlayer.start(bpm);
  },

  setBpm(bpm: number) {
    if (source() === "spotify") spotifyOutput.setBpm(bpm);
    else musicPlayer.setBpm(bpm);
  },

  /** Spotify only: favor high-energy songs (push) or calmer ones (ease). Built-in tracks ignore it. */
  setIntensity(intensity: Intensity) {
    if (source() === "spotify") spotifyOutput.setIntensity(intensity);
  },

  stop() {
    spotifyOutput.stop();
    musicPlayer.stop();
  },
};
