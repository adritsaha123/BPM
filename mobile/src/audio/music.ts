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

  stop() {
    spotifyOutput.stop();
    djOutput.stop();
    musicPlayer.stop();
  },
};
