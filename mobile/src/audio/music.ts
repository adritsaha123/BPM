import { useSession } from "../store/session";
import { appleMusicOutput } from "./appleMusicOutput";

/**
 * The music side of the workout loop: songs from the Apple Music playlist picked on the setup
 * screen, sped up or slowed down to the target BPM (audio/appleMusicOutput.ts).
 */
export const music = {
  async start(bpm: number) {
    useSession.getState().setMusicPaused(false);
    await appleMusicOutput.start(bpm);
  },

  setBpm(bpm: number) {
    appleMusicOutput.setBpm(bpm);
  },

  /** Switch to a different song at the same tempo (the heart rate is holding steady).
   *  Returns whether a switch started. */
  rotate(): boolean {
    if (useSession.getState().musicPaused) return false;
    return appleMusicOutput.rotate();
  },

  /** Pause the music; the workout and coach keep running, so resume() plays at the current target. */
  async pause() {
    await appleMusicOutput.pause();
    useSession.getState().setMusicPaused(true);
  },

  async resume() {
    await appleMusicOutput.resume();
    useSession.getState().setMusicPaused(false);
  },

  stop() {
    useSession.getState().setMusicPaused(false);
    appleMusicOutput.stop();
  },
};
