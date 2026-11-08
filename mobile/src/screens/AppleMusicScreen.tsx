import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import AppleMusic, {
  type AppleMusicSong,
  type AppleMusicState,
  type AuthorizationStatus,
  type PlayerKind,
} from "../../modules/apple-music";
import { API_URL, api, type CoachTarget, type HrZones, type TempoInfo, type TempoMatch } from "../api";
import {
  Button,
  DIRECTION,
  SimulateStepper,
  ZonePicker,
  baseStyles,
  errorText,
  statusColor,
  statusLabel,
} from "../components/shared";
import { lockRate, matchTempo, rankForTarget } from "../tempo";
import { colors, spacing } from "../theme";

const STATE_POLL_MS = 1000;
const TARGET_POLL_MS = 2000;
const SONG_PAGE = 500;
const LOOKUP_BATCH = 25; // songs per /tempo/lookup call (a first lookup takes a few seconds per batch)
const LOOKUP_STEP = 200; // look up the most recently added songs first, this many at a time
const QUEUE_LENGTH = 30; // songs queued after the one you pick, so music keeps going if the app sleeps
const LIST_STEP = 40;
const STRETCHES = [0.05, 0.1, 0.2];
const MANUAL_STEP = 0.05;

/** The native player, or null where it can't play: Expo Go, web, Android, the iOS Simulator. */
const music = AppleMusic && !AppleMusic.isSimulator ? AppleMusic : null;

const SOURCE_TEXT: Record<TempoInfo["source"], string> = {
  reccobeats: "tempo from ReccoBeats",
  deezer: "tempo from Deezer",
  library: "tempo from the song's BPM tag",
};

const KINDS: { kind: PlayerKind; label: string }[] = [
  { kind: "app", label: "This app" },
  { kind: "system", label: "Music app" },
];

/** 1.05 -> "+5%" */
function percent(rate: number): string {
  const p = Math.round((rate - 1) * 1000) / 10;
  return p === 0 ? "±0%" : `${p > 0 ? "+" : ""}${p}%`;
}

/** With the speed lock on, a song "fits" when stretching it by at most maxStretch lands on target. */
function fitColor(m: TempoMatch | null, maxStretch: number): string {
  if (!m) return colors.muted;
  const need = Math.abs(m.speed_to_match - 1);
  return need <= maxStretch ? colors.ok : need <= maxStretch * 2 ? colors.warn : colors.error;
}

function songTempo(song: AppleMusicSong, tempos: Record<string, TempoInfo | null>): TempoInfo | null {
  return tempos[song.id] ?? (song.libraryBpm > 0 ? { bpm: song.libraryBpm, source: "library" } : null);
}

/** Apple Music library player that changes song speed so the beat follows your heart rate. */
export default function AppleMusicScreen() {
  const [auth, setAuth] = useState<AuthorizationStatus | null>(null);
  const [songs, setSongs] = useState<AppleMusicSong[]>([]);
  const [songsLoaded, setSongsLoaded] = useState(false);
  const [tempos, setTempos] = useState<Record<string, TempoInfo | null>>({});
  const temposRef = useRef(tempos);
  const [lookupLimit, setLookupLimit] = useState(LOOKUP_STEP);
  const [lookupRun, setLookupRun] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const [player, setPlayer] = useState<AppleMusicState | null>(null);
  const [target, setTarget] = useState<CoachTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [zones, setZones] = useState<HrZones | null>(null);
  const [zone, setZone] = useState<number | null>(3); // null = just match the heart rate
  const [fallbackBpm, setFallbackBpm] = useState(125);

  const [lock, setLock] = useState(true);
  const [stretch, setStretch] = useState(0.1);
  const [manualRate, setManualRate] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [shown, setShown] = useState(LIST_STEP);

  // Heart rate + coach target from the backend (live band, or the simulated heart rate).
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .coachTarget(fallbackBpm, zone)
        .then((t) => {
          if (!alive) return;
          setTarget(t);
          setTargetError(null);
        })
        .catch((e) => alive && setTargetError(errorText(e)));
    tick();
    const id = setInterval(tick, TARGET_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fallbackBpm, zone]);

  useEffect(() => {
    api.coachZones().then(setZones).catch(() => setZones(null));
  }, []);

  useEffect(() => {
    music?.getAuthorizationStatus().then(setAuth).catch((e) => setMessage(errorText(e)));
  }, []);

  // The library, most recently added first.
  useEffect(() => {
    if (!music || auth !== "authorized") return;
    let alive = true;
    (async () => {
      try {
        const all: AppleMusicSong[] = [];
        for (let offset = 0; ; offset += SONG_PAGE) {
          const page = await music.getSongs(SONG_PAGE, offset);
          if (!alive) return;
          all.push(...page.songs);
          if (page.songs.length < SONG_PAGE || all.length >= page.total) break;
        }
        setSongs(all);
      } catch (e) {
        if (alive) setMessage(errorText(e));
      } finally {
        if (alive) setSongsLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [auth]);

  // Tempos for the first `lookupLimit` songs, a batch at a time so the list fills in as it goes.
  useEffect(() => {
    const todo = songs.slice(0, lookupLimit).filter((s) => temposRef.current[s.id] === undefined);
    if (!todo.length) return;
    let alive = true;
    (async () => {
      setProgress({ done: 0, total: todo.length });
      for (let i = 0; i < todo.length; i += LOOKUP_BATCH) {
        const batch = todo.slice(i, i + LOOKUP_BATCH).map((s) => ({
          id: s.id,
          title: s.title,
          artist: s.artist,
          duration_s: s.durationS || null,
          library_bpm: s.libraryBpm || null,
        }));
        try {
          const { tempos: found } = await api.tempoLookup(batch);
          if (!alive) return;
          temposRef.current = { ...temposRef.current, ...found };
          setTempos(temposRef.current);
          setProgress({ done: Math.min(i + LOOKUP_BATCH, todo.length), total: todo.length });
        } catch (e) {
          if (alive) setMessage(`Tempo lookup paused: ${errorText(e)}`);
          break;
        }
      }
      if (alive) setProgress(null);
    })();
    return () => {
      alive = false;
    };
  }, [songs, lookupLimit, lookupRun]);

  // Player state: poll (it also re-applies the speed if iOS resets it) + instant updates on changes.
  const refreshState = useCallback(() => {
    music
      ?.getState()
      .then(setPlayer)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!music || auth !== "authorized") return;
    refreshState();
    const id = setInterval(refreshState, STATE_POLL_MS);
    const sub = music.addListener("onPlaybackChange", refreshState);
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [auth, refreshState]);

  const song = player?.song ?? null;
  const tempo = song ? songTempo(song, tempos) : null;
  const songBpm = tempo?.bpm ?? null;
  const targetBpm = target?.target_bpm ?? null;
  const coach = target?.coach ?? null;
  const hrLive = target?.heart_rate.live ?? false;
  const playing = player?.state === "playing";
  const audibleRate = player && player.state === "playing" ? player.rate : (player?.desiredRate ?? 1);
  const hearing = songBpm ? songBpm * audibleRate : null; // the tempo you hear right now
  const match = matchTempo(hearing, targetBpm);
  const wantRate = lock ? lockRate(songBpm, targetBpm, stretch) : manualRate;

  // Speed: follow the heart rate (lock) or the manual setting.
  const sent = useRef({ rate: 1, at: 0 });
  useEffect(() => {
    if (!music || !player || Math.abs(player.desiredRate - wantRate) < 0.001) return;
    if (sent.current.rate === wantRate && Date.now() - sent.current.at < 3000) return; // in flight
    sent.current = { rate: wantRate, at: Date.now() };
    music
      .setRate(wantRate)
      .then(refreshState)
      .catch((e) => setMessage(errorText(e)));
  }, [player, wantRate, refreshState]);

  // The heart rate sync only runs while the app is on screen, so don't let the phone lock.
  useEffect(() => {
    music?.setKeepScreenOn(playing && lock).catch(() => {});
  }, [playing, lock]);
  useEffect(
    () => () => {
      music?.setKeepScreenOn(false).catch(() => {});
    },
    [],
  );

  const bpmOf = useCallback((s: AppleMusicSong) => songTempo(s, tempos)?.bpm ?? null, [tempos]);
  const targetBucket = targetBpm ? Math.round(targetBpm / 4) * 4 : null; // re-sort every ~4 BPM
  const ranked = useMemo(
    () => (targetBucket ? rankForTarget(songs, bpmOf, targetBucket) : songs.filter((s) => bpmOf(s) != null)),
    [songs, bpmOf, targetBucket],
  );
  // Songs with a tempo first (best fit first), then the rest, so every song can still be played.
  const listed = useMemo(() => [...ranked, ...songs.filter((s) => bpmOf(s) == null)], [ranked, songs, bpmOf]);
  const lookedUp = songs.slice(0, lookupLimit);
  const unknownCount = lookedUp.filter((s) => tempos[s.id] === null && !(s.libraryBpm > 0)).length;

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      setBusy(label);
      setMessage(null);
      try {
        const done = await fn();
        if (done) setMessage(done);
      } catch (e) {
        setMessage(errorText(e));
      } finally {
        setBusy(null);
        refreshState();
      }
    },
    [refreshState],
  );

  /** Play `first`, then the songs that fit the current target best. */
  const playFrom = async (first: AppleMusicSong): Promise<string> => {
    if (!music) return "Apple Music isn't available here.";
    const rest = (ranked.length ? ranked : songs).filter((s) => s.id !== first.id);
    await music.play([first, ...rest].slice(0, QUEUE_LENGTH).map((s) => s.id), 0);
    const bpm = bpmOf(first);
    return `Playing ${first.title}${bpm ? ` (${Math.round(bpm)} BPM)` : ""}`;
  };

  const playBest = async (): Promise<string> => {
    if (!targetBpm) return "No heart rate yet: connect the band or use the simulate buttons.";
    const best = ranked[0];
    if (!best) return progress ? "Still looking up tempos, try again in a moment." : "No songs with a known tempo yet.";
    return playFrom(best);
  };

  // ---- Screens for when Apple Music can't run ----

  if (!music) {
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
        <Text style={styles.title}>Apple Music</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {AppleMusic ? "The Simulator has no Apple Music" : "Needs the BPM iPhone app"}
          </Text>
          <Text style={styles.body}>
            {AppleMusic
              ? "Run the app on your iPhone to play your library and change song speed."
              : "Apple Music runs through iOS code that Expo Go and the web don't have. Install the BPM build on your iPhone instead:"}
          </Text>
          <Text style={styles.code}>cd mobile{"\n"}npx expo run:ios --device</Text>
          <Text style={styles.muted}>Step by step (Apple ID, Developer Mode): docs/APPLE_MUSIC.md</Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
      <Text style={styles.title}>Apple Music</Text>
      <Text style={styles.muted}>
        {auth === "authorized" && (songsLoaded ? `${songs.length} songs in your library` : "Loading your library…")}
        {auth === null && "Checking access…"}
      </Text>

      {targetError && (
        <View style={styles.card}>
          <Text style={[styles.body, { color: colors.error }]}>{targetError}</Text>
          <Text style={styles.muted}>Backend: {API_URL}</Text>
        </View>
      )}

      {auth === "notDetermined" && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connect Apple Music</Text>
          <Text style={styles.body}>
            BPM plays songs from your library and speeds them up or slows them down to your heart rate.
          </Text>
          <View style={styles.controls}>
            <Button
              label="Connect Apple Music"
              primary
              busy={busy === "auth"}
              onPress={() => run("auth", async () => setAuth(await music.requestAuthorization()))}
            />
          </View>
        </View>
      )}

      {(auth === "denied" || auth === "restricted" || auth === "unknown") && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Apple Music access is off</Text>
          <Text style={styles.body}>
            Turn it on in Settings → Privacy & Security → Media & Apple Music → BPM, then come back.
          </Text>
          <View style={styles.controls}>
            <Button
              label="Check again"
              onPress={() => run("auth", async () => setAuth(await music.getAuthorizationStatus()))}
            />
          </View>
        </View>
      )}

      <ZonePicker zones={zones} zone={zone} onChange={setZone} coach={coach} />

      {/* Heart rate vs the song's tempo at its current speed */}
      <View style={styles.card}>
        <View style={styles.bpmRow}>
          <View style={styles.bpmCol}>
            <Text style={styles.bpmLabel}>Heart rate</Text>
            <Text style={styles.bpmValue}>{target?.current_bpm != null ? Math.round(target.current_bpm) : "–"}</Text>
            <Text style={styles.muted}>{hrLive ? "live from band" : "simulated (no band)"}</Text>
          </View>
          {coach && coach.direction !== "hold" && (
            <View style={styles.bpmCol}>
              <Text style={styles.bpmLabel}>Music aims</Text>
              <Text style={[styles.bpmValue, { color: DIRECTION[coach.direction].color }]}>
                {Math.round(coach.target_bpm)}
              </Text>
              <Text style={styles.muted}>{coach.direction === "push" ? "a step faster" : "a step slower"}</Text>
            </View>
          )}
          <View style={styles.bpmCol}>
            <Text style={styles.bpmLabel}>Song</Text>
            <Text style={[styles.bpmValue, { color: statusColor(match) }]}>
              {hearing ? Math.round(hearing) : "–"}
            </Text>
            <Text style={styles.muted}>
              {songBpm
                ? audibleRate !== 1
                  ? `${Math.round(songBpm)} at ${audibleRate.toFixed(3)}×`
                  : "original speed"
                : song
                  ? "tempo unknown"
                  : "BPM"}
            </Text>
          </View>
        </View>
        <View style={[styles.pill, { backgroundColor: statusColor(match) }]}>
          <Text style={styles.pillText}>{statusLabel(match)}</Text>
        </View>
        {match && match.multiple !== 1 && (
          <Text style={[styles.muted, styles.center]}>
            Feels like {Math.round(match.effective_bpm)} ({match.multiple === 2 ? "one step per half beat" : "one step every other beat"})
          </Text>
        )}
        {!hrLive && <SimulateStepper value={fallbackBpm} onChange={setFallbackBpm} />}
      </View>

      {auth === "authorized" && (
        <>
          {/* Now playing + controls */}
          <View style={styles.card}>
            {song ? (
              <View style={styles.trackRow}>
                {song.artworkUri ? (
                  <Image source={{ uri: song.artworkUri }} style={styles.art} />
                ) : (
                  <View style={[styles.art, styles.artPlaceholder]}>
                    <Text style={styles.muted}>♪</Text>
                  </View>
                )}
                <View style={styles.flex1}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {song.title}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {song.artist}
                    {tempo ? ` · ${SOURCE_TEXT[tempo.source]}` : ""}
                  </Text>
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${Math.min(100, ((player?.positionS ?? 0) / (song.durationS || 1)) * 100)}%` },
                      ]}
                    />
                  </View>
                </View>
              </View>
            ) : (
              <Text style={styles.muted}>Nothing playing. Tap a song below, or Match my BPM.</Text>
            )}
            <View style={styles.controls}>
              <Button
                label={playing ? "Pause" : "Play"}
                busy={busy === "toggle"}
                onPress={() =>
                  run("toggle", async () => {
                    if (playing) await music.pause();
                    else if (song) await music.resume();
                    else return playBest();
                  })
                }
              />
              <Button
                label="Next"
                busy={busy === "next"}
                disabled={!song}
                onPress={() => run("next", () => music.skipToNext())}
              />
              <Button label="Match my BPM" primary busy={busy === "match"} onPress={() => run("match", playBest)} />
            </View>
            {message && <Text style={styles.message}>{message}</Text>}
          </View>

          {/* Speed */}
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <View style={styles.flex1}>
                <Text style={styles.cardTitle}>Lock to my heart rate</Text>
                <Text style={styles.muted}>
                  {lock
                    ? `Speeds the song up or down, up to ±${Math.round(stretch * 100)}%, so the beat matches ${coach ? "the coach target" : "your heart rate"}. Keeps the screen on while playing.`
                    : "Off: set the speed yourself."}
                </Text>
              </View>
              <Switch value={lock} onValueChange={setLock} />
            </View>

            {lock ? (
              <View style={styles.chipRow}>
                <Text style={styles.body}>Max change</Text>
                {STRETCHES.map((s) => (
                  <Pressable key={s} onPress={() => setStretch(s)} style={[styles.chip, stretch === s && styles.chipActive]}>
                    <Text style={[styles.chipText, stretch === s && styles.chipTextActive]}>±{Math.round(s * 100)}%</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <View style={styles.controls}>
                <Button
                  label={`−${MANUAL_STEP * 100}%`}
                  onPress={() => setManualRate((r) => Math.max(0.5, Math.round((r - MANUAL_STEP) * 100) / 100))}
                />
                <Button label="Normal" onPress={() => setManualRate(1)} />
                <Button
                  label={`+${MANUAL_STEP * 100}%`}
                  onPress={() => setManualRate((r) => Math.min(2, Math.round((r + MANUAL_STEP) * 100) / 100))}
                />
              </View>
            )}

            <Text style={styles.body}>
              Speed {wantRate.toFixed(3)}× ({percent(wantRate)})
              {playing && player && Math.abs(player.rate - player.desiredRate) > 0.01
                ? ` · iOS is playing at ${player.rate.toFixed(2)}×`
                : ""}
            </Text>
            {player && player.rateResets > 0 && (
              <Text style={styles.muted}>
                iOS reset the speed {player.rateResets}× and BPM put it back. If it won't stick, play through
                the Music app instead.
              </Text>
            )}

            <View style={styles.chipRow}>
              <Text style={styles.body}>Play through</Text>
              {KINDS.map(({ kind, label }) => (
                <Pressable
                  key={kind}
                  onPress={() => run("kind", () => music.setPlayerKind(kind))}
                  style={[styles.chip, player?.playerKind === kind && styles.chipActive]}
                >
                  <Text style={[styles.chipText, player?.playerKind === kind && styles.chipTextActive]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Library, best fit for the current target first */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {targetBucket ? `Your songs, best for ${Math.round(targetBpm ?? 0)} BPM` : "Your songs"}
            </Text>
            {progress && (
              <Text style={styles.muted}>
                Looking up tempos… {progress.done}/{progress.total}
              </Text>
            )}
            {songsLoaded && songs.length === 0 && (
              <Text style={styles.body}>
                Your library is empty. Add songs to your library in the Music app, then reopen this tab.
              </Text>
            )}
            {listed.slice(0, shown).map((s) => {
              const bpm = bpmOf(s);
              const m = matchTempo(bpm, targetBpm);
              return (
                <Pressable
                  key={s.id}
                  style={({ pressed }) => [styles.matchRow, pressed && { opacity: 0.6 }]}
                  onPress={() => run(`play-${s.id}`, () => playFrom(s))}
                >
                  <View style={styles.flex1}>
                    <Text style={[styles.body, s.id === song?.id && styles.nowPlaying]} numberOfLines={1}>
                      {s.id === song?.id ? "▶ " : ""}
                      {s.title}
                    </Text>
                    <Text style={styles.muted} numberOfLines={1}>
                      {s.artist}
                    </Text>
                  </View>
                  <View style={styles.right}>
                    <Text style={[styles.matchBpm, { color: lock ? fitColor(m, stretch) : statusColor(m) }]}>
                      {bpm != null ? Math.round(bpm) : "–"}
                      {m && m.multiple !== 1 ? (m.multiple === 2 ? " ×2" : " ½") : ""}
                    </Text>
                    {m && <Text style={styles.muted}>{percent(m.speed_to_match)}</Text>}
                  </View>
                </Pressable>
              );
            })}
            {listed.length > shown && (
              <Button label={`Show ${Math.min(LIST_STEP, listed.length - shown)} more`} onPress={() => setShown((n) => n + LIST_STEP)} />
            )}
            {unknownCount > 0 && !progress && (
              <View style={styles.switchRow}>
                <Text style={[styles.muted, styles.flex1]}>{unknownCount} songs have no tempo data.</Text>
                <Pressable
                  onPress={() => {
                    const keep = { ...temposRef.current };
                    for (const s of lookedUp) if (keep[s.id] === null) delete keep[s.id];
                    temposRef.current = keep;
                    setTempos(keep);
                    setLookupRun((n) => n + 1);
                  }}
                >
                  <Text style={styles.link}>Try again</Text>
                </Pressable>
              </View>
            )}
            {songs.length > lookupLimit && !progress && (
              <View style={styles.switchRow}>
                <Text style={[styles.muted, styles.flex1]}>
                  {songs.length - lookupLimit} older songs not looked up yet.
                </Text>
                <Pressable onPress={() => setLookupLimit((n) => n + LOOKUP_STEP)}>
                  <Text style={styles.link}>Look up {Math.min(LOOKUP_STEP, songs.length - lookupLimit)} more</Text>
                </Pressable>
              </View>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  ...baseStyles,
  center: { textAlign: "center" },
  right: { alignItems: "flex-end" },
  nowPlaying: { color: colors.primary, fontWeight: "600" },
  link: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  chipRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
});
