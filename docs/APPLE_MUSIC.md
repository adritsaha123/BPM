# Apple Music + speed control

The workout music comes from **one of your Apple Music playlists**, picked on the setup screen.
The app **changes the songs' speed so the beat matches the target tempo**. iOS keeps the pitch the
same when it changes the speed, so voices don't sound like chipmunks.

- **Only that playlist plays.** As soon as you pick it, the app looks up its songs' tempos. When
  the first ones are known the setup screen says **Ready**; the rest keep loading in the
  background, also during the run.
- At the start it plays the playlist song that needs the smallest speed change and queues the
  next 24 best, so music keeps going even if the app goes to sleep. Each new song is locked to
  the target too.
- Speed = target tempo ÷ song tempo, at most ±10% from normal, in 0.5% steps, so small changes
  don't keep nudging it. Half and double time count: an 85 BPM song locks to a target of 170.
- When the coach changes the target, the current song's speed follows. If the new target is more
  than 10% away from it, the best-fitting song comes on instead.
- When your heart rate holds steady for a while, a long song gives way to another one at the
  same tempo, for variety.
- Songs whose tempo can't be found are skipped.

| Piece | Where |
|---|---|
| Player + speed + playlists (Apple's MediaPlayer framework) | `mobile/modules/apple-music/ios/AppleMusicModule.swift` (local Expo module) |
| Its JavaScript side + types | `mobile/modules/apple-music/src/` |
| Workout player (picks songs, sets the speed) | `mobile/src/audio/appleMusicOutput.ts` |
| Playlist picker | `mobile/src/app/playlists.tsx`, opened from the setup screen (`mobile/src/app/index.tsx`) |
| Song tempos by title + artist | `POST /tempo/lookup` → `backend/app/tempo.py` |

## Why Apple Music

Apple's MediaPlayer framework has a public playback speed setting (`currentPlaybackRate`) that
works for Apple Music songs. Other streaming services give apps no speed control, so they could only
pick songs that are close to the target, never land exactly on it.

**There is no EQ.** Apple never gives apps the audio of Apple Music songs (they're DRM protected),
so there's nothing to run through an equalizer. Apps like djay get that through a deal with Apple.

## What you need

- An **iPhone** with songs in its Music library: Apple Music songs you've added to your library,
  or purchased/synced songs. Songs that are only in iCloud stream if you have Apple Music.
- A **Mac with Xcode**. A free Apple ID is enough. The $99 developer program isn't needed, because
  this uses the MediaPlayer framework, not MusicKit.
- It does **not** run in Expo Go, on the web, on Android or in the iOS Simulator (the Simulator
  has no Music library). The playlist screen says so instead of crashing.

## 1. One-time Mac setup

1. **CocoaPods** (Xcode uses it to pull in React Native's iOS code). Check with `pod --version`.
   - With Homebrew: `brew install cocoapods`.
   - Without Homebrew (macOS's built-in Ruby 2.6): it's installed for your user in
     `~/.gem/ruby/2.6.0/bin`. Put that on your PATH once, then open a new terminal:
     ```bash
     echo 'export PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH"' >> ~/.zshrc
     ```
     To install it that way on another Mac, see [Installing CocoaPods on Ruby 2.6](#installing-cocoapods-on-ruby-26).
2. **Xcode → Settings → Accounts → + → Apple ID** and sign in. That creates a free
   "Personal Team" that signs the app for your own phone.

## 2. Install the app on your iPhone

1. Plug the iPhone into the Mac, unlock it, and tap **Trust This Computer**.
2. On the iPhone: **Settings → Privacy & Security → Developer Mode → On** and restart when it asks.
   (The switch only shows up after the phone has been connected to Xcode once.)
3. Start the backend as usual (from `backend/`, venv active):
   ```bash
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```
4. Build and install. The first build takes a few minutes:
   ```bash
   cd mobile
   npx expo run:ios --device
   ```
   Pick your iPhone from the list. It starts the dev server too, and the app finds the backend on
   the laptop by itself as long as the phone is on the same Wi-Fi.

   **Or from Xcode:**
   1. Start the dev server and leave it running: `cd mobile && npx expo start`. Xcode's ▶ makes a
      debug build, which loads the app's code from the dev server.
   2. `open ios/BPMCoach.xcworkspace`. Open the `.xcworkspace`, not the `.xcodeproj`. If
      `mobile/ios` doesn't exist yet, run `npx expo prebuild --platform ios` first. It also
      changes the `ios`/`android` scripts in `package.json`; don't commit that.
   3. Click **BPMCoach** at the top of the file list → **Signing & Capabilities** → **Team**:
      your Personal Team.
   4. Pick your iPhone in the device menu at the top of the window and press **▶** (⌘R).
   5. When the phone asks to find devices on your local network, tap **Allow**. That's how it
      reaches the laptop. If it then shows a red error screen, press ⌘R again.
5. First time only, on the iPhone: **Settings → General → VPN & Device Management →** your Apple ID
   **→ Trust**. Then open the app.
6. Setup screen → **Music → Choose a playlist** → **Allow** Apple Music access → tap a playlist.
   When the Music card says **Ready**, start the workout: songs from that playlist are chosen by
   tempo and sped up or slowed down (max ±10%) as the coach changes the target.

If the build stops with *"Signing … requires a development team"*: open
`mobile/ios/*.xcworkspace` in Xcode, click the app target → **Signing & Capabilities** → Team =
your Personal Team, and build again. Each person installing it needs their own bundle id. If Xcode
says `com.bpmemergent.bpm` is taken, change `ios.bundleIdentifier` in `mobile/app.json` (for
example `com.yourname.bpm`) and run `npx expo prebuild --clean --platform ios`.

With a free Apple ID the app stops opening after **7 days**. Run step 4 again to reinstall it.

## 3. Use it

- The playlist list shows your playlists A to Z (folders and empty playlists are left out). The app
  remembers the one you pick.
- The first time a song is looked up it takes about a second. The app looks up 10 songs first so
  you can start sooner; the others follow in batches of 50. Results are saved in
  `backend/data/tempo_cache.json`, so it's quick after that (the free cloud backend forgets them
  when it restarts).
- **Keep the app open on screen while running.** If iOS pauses the app, the speed stops following
  the target (the music keeps playing at the last speed). The workout screen keeps the screen
  awake.

## Where tempos come from

Library songs rarely carry a BPM tag (it's used when they do). The backend looks each song up by
title + artist:

1. **Deezer** search for "artist title". It keeps only the same song by the same artist at about
   the same length (within 15 s), and gets that recording's **ISRC**, a code that identifies the
   recording.
2. **ReccoBeats** audio features for that ISRC give the tempo, 40 songs per request.
3. Not found? ReccoBeats' own search by title, same checks. As a last resort, Deezer's BPM.

Covers, live versions, remixes and acoustic versions are never matched to the original. Tags like
"Remastered 2011", "Radio Edit" or "(feat. …)" are ignored, because they don't change the tempo.
A few songs come back at half tempo (Bohemian Rhapsody shows 71). Matching counts half and double
time, so they still work.

ReccoBeats answers "too many requests, retry after 17 seconds" after about 40 requests in 10
seconds. The backend asks it for 40 songs at a time and waits out a limit when it hits one. A
lookup that failed isn't saved, so **Try again** on the setup screen retries it.

## Known issues

- **iOS 26 speed bug.** Some people report that on iOS 26.0 the Music speed snaps back to normal,
  or the audio gets noisy. The app puts the speed back when iOS resets it (`getState` counts it in
  `rateResets`). If the speed won't stick, update iOS; the native module can also play through the
  Music app instead (`setPlayerKind("system")`). Try it on your phone before the demo.
- Only songs in your library show up. Searching the whole Apple Music catalog would need MusicKit
  and the paid developer program.

## API

```
POST /tempo/lookup                             {"tracks": [{"id", "title", "artist", "duration_s", "library_bpm"}]}
                                               at most 50 -> {"tempos": {id: {"bpm", "source", "matched", "isrc"} | null}}
```

## Installing CocoaPods on Ruby 2.6

The newest CocoaPods dependencies need Ruby 3. On macOS's built-in Ruby 2.6, without Homebrew,
install these older versions first, then CocoaPods (no `sudo`; everything goes in `~/.gem`):

```bash
for g in nap:1.1.1 ffi:1.16.3 securerandom:0.3.2 drb:2.0.6 i18n:1.14.8 zeitwerk:2.6.18 \
         minitest:5.15.0 activesupport:6.1.7.10; do
  gem install --user-install --no-document --conservative "${g%%:*}" -v "${g##*:}"
done
gem install --user-install --no-document --conservative cocoapods
```

If it stops with *"Try installing it with `gem install X -v Y`"*, run that (with the same flags)
and the last line again. Undo with `gem uninstall --user-install cocoapods`.
