import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import {
  API_URL,
  api,
  type HrZones,
  type MatchList,
  type NowPlaying,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from "../api";
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
import { colors } from "../theme";

const POLL_MS = 2000;
const AUTO_DJ_LEAD_MS = 20000; // queue the next match when this much of the song is left

function artistLine(t: SpotifyTrack): string {
  return t.artists.join(", ");
}

/** Live BPM sync: the song's tempo next to your live heart rate, and songs that match it. */
export default function MusicScreen() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [npError, setNpError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [playlistId, setPlaylistId] = useState("liked");
  const [matches, setMatches] = useState<MatchList | null>(null);
  const [fallbackBpm, setFallbackBpm] = useState(125);
  const [zone, setZone] = useState<number | null>(3); // null = just match the heart rate
  const [zones, setZones] = useState<HrZones | null>(null);
  const [autoDj, setAutoDj] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const autoQueuedFor = useRef<string | null>(null);

  const mode = np?.mode;
  const hrLive = np?.heart_rate.live ?? false;
  const current = np?.current_bpm ?? null;
  const target = np?.target_bpm ?? null;
  const coach = np?.coach ?? null;
  const targetBucket = target ? Math.round(target / 4) : null; // refresh matches every ~4 BPM

  // Poll now-playing (song + tempo + heart rate + coach target + match).
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .nowPlaying(fallbackBpm, zone)
        .then((data) => {
          if (!alive) return;
          setNp(data);
          setNpError(null);
        })
        .catch((e) => alive && setNpError(errorText(e)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fallbackBpm, zone]);

  useEffect(() => {
    api.spotifyZones().then(setZones).catch(() => setZones(null));
  }, []);

  // Playlists once Spotify is usable.
  useEffect(() => {
    if (mode !== "live" && mode !== "mock") return;
    api.spotifyPlaylists().then(setPlaylists).catch((e) => setMessage(errorText(e)));
  }, [mode]);

  // Ranked matches for the selected playlist; refresh when the target moves.
  useEffect(() => {
    if (mode !== "live" && mode !== "mock") return;
    api
      .spotifyMatches({ playlistId, fallbackBpm, zone })
      .then(setMatches)
      .catch((e) => setMessage(errorText(e)));
  }, [mode, playlistId, targetBucket, fallbackBpm, zone]);

  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      setBusy(label);
      setMessage(null);
      try {
        const done = await fn();
        if (done) setMessage(done);
        setNp(await api.nowPlaying(fallbackBpm, zone));
      } catch (e) {
        setMessage(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [fallbackBpm, zone],
  );

  // Auto-DJ: shortly before the song ends, queue the best match for the current heart rate.
  useEffect(() => {
    const t = np?.track;
    if (!autoDj || !t || !np?.is_playing || !t.duration_ms || np.progress_ms == null) return;
    if (t.duration_ms - np.progress_ms > AUTO_DJ_LEAD_MS || autoQueuedFor.current === t.id) return;
    autoQueuedFor.current = t.id;
    api
      .spotifySync({ playlistId, fallbackBpm, zone })
      .then((r) => setMessage(`Up next: ${r.track.name} (${r.track.tempo} BPM)`))
      .catch((e) => setMessage(errorText(e)));
  }, [np, autoDj, playlistId, fallbackBpm, zone]);

  const track = np?.track ?? null;
  const match = np?.match ?? null;
  const progress = track?.duration_ms && np?.progress_ms != null ? np.progress_ms / track.duration_ms : 0;

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
      <Text style={styles.title}>BPM Sync</Text>
      <Text style={styles.muted}>
        {mode === "mock" && "Spotify: demo library (add Spotify keys to backend/.env for your real music)"}
        {mode === "live" && "Spotify connected"}
        {mode === "not_connected" && "Spotify not connected yet"}
        {!mode && !npError && "Connecting…"}
      </Text>

      {npError && (
        <View style={styles.card}>
          <Text style={[styles.body, { color: colors.error }]}>{npError}</Text>
          <Text style={styles.muted}>Backend: {API_URL}</Text>
        </View>
      )}

      {mode === "not_connected" && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connect Spotify</Text>
          <Text style={styles.body}>
            On the laptop running the backend, open{"\n"}
            <Text style={styles.code}>http://127.0.0.1:8000/spotify/login</Text>
            {"\n"}and sign in. This screen updates by itself.
          </Text>
        </View>
      )}

      {/* Coach mode: which zone to steer toward */}
      <ZonePicker zones={zones} zone={zone} onChange={setZone} coach={coach} />

      {/* Heart rate vs song tempo */}
      <View style={styles.card}>
        <View style={styles.bpmRow}>
          <View style={styles.bpmCol}>
            <Text style={styles.bpmLabel}>Heart rate</Text>
            <Text style={styles.bpmValue}>{current != null ? Math.round(current) : "–"}</Text>
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
              {track?.tempo != null ? Math.round(track.tempo) : "–"}
            </Text>
            <Text style={styles.muted}>
              {match && match.multiple !== 1
                ? `feels like ${Math.round(match.effective_bpm)} (${match.multiple === 2 ? "×2" : "½"})`
                : track && track.tempo == null
                  ? "tempo unknown"
                  : "BPM"}
            </Text>
          </View>
        </View>

        <View style={[styles.pill, { backgroundColor: statusColor(match) }]}>
          <Text style={styles.pillText}>{statusLabel(match)}</Text>
        </View>
        {match && match.status !== "in_sync" && (
          <Text style={styles.muted}>
            Would need {match.speed_to_match.toFixed(2)}× speed to lock in. Spotify can't change speed, so
            "Match my BPM" switches to a song that fits instead.
          </Text>
        )}

        {!hrLive && <SimulateStepper value={fallbackBpm} onChange={setFallbackBpm} />}
      </View>

      {/* Now playing + controls */}
      <View style={styles.card}>
        {track ? (
          <View style={styles.trackRow}>
            {track.image ? (
              <Image source={{ uri: track.image }} style={styles.art} />
            ) : (
              <View style={[styles.art, styles.artPlaceholder]}>
                <Text style={styles.muted}>♪</Text>
              </View>
            )}
            <View style={styles.flex1}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {track.name}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {artistLine(track)}
              </Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
              </View>
            </View>
          </View>
        ) : (
          <Text style={styles.muted}>Nothing playing. Start any song in Spotify, or tap a match below.</Text>
        )}

        <View style={styles.controls}>
          <Button
            label={np?.is_playing ? "Pause" : "Play"}
            busy={busy === "toggle"}
            onPress={() => run("toggle", () => (np?.is_playing ? api.spotifyPause() : api.spotifyPlay()))}
          />
          <Button label="Next" busy={busy === "next"} onPress={() => run("next", () => api.spotifyNext())} />
          <Button
            label="Match my BPM"
            primary
            busy={busy === "sync"}
            onPress={() =>
              run("sync", async () => {
                const r = await api.spotifySync({ playlistId, fallbackBpm, zone, playNow: true });
                return `Playing ${r.track.name} (${r.track.tempo} BPM)`;
              })
            }
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.body}>Auto-DJ</Text>
            <Text style={styles.muted}>
              {zone ? `Before each song ends, queues one that steers you into Zone ${zone}` : "Before each song ends, queues one that fits your heart rate"}
            </Text>
          </View>
          <Switch
            value={autoDj}
            onValueChange={(v) => {
              setAutoDj(v);
              autoQueuedFor.current = null;
            }}
          />
        </View>

        {message && <Text style={styles.message}>{message}</Text>}
      </View>

      {/* Playlist picker + ranked matches */}
      {playlists.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {playlists.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => setPlaylistId(p.id)}
              style={[styles.chip, p.id === playlistId && styles.chipActive]}
            >
              <Text style={[styles.chipText, p.id === playlistId && styles.chipTextActive]}>{p.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {matches && matches.tracks.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Best matches for {Math.round(matches.target_bpm ?? 0)} BPM</Text>
          {matches.tracks.map((t) => (
            <Pressable
              key={t.id}
              style={({ pressed }) => [styles.matchRow, pressed && { opacity: 0.6 }]}
              onPress={() => run(`play-${t.id}`, async () => {
                await api.spotifyPlay([t.uri]);
                return `Playing ${t.name}`;
              })}
            >
              <View style={styles.flex1}>
                <Text style={styles.body} numberOfLines={1}>
                  {t.name}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {artistLine(t)}
                </Text>
              </View>
              <Text style={[styles.matchBpm, { color: statusColor(t.match) }]}>
                {t.tempo != null ? Math.round(t.tempo) : "–"}
                {t.match && t.match.multiple !== 1 ? (t.match.multiple === 2 ? " ×2" : " ½") : ""}
              </Text>
            </Pressable>
          ))}
          {matches.no_tempo_count > 0 && (
            <Text style={styles.muted}>{matches.no_tempo_count} songs in this playlist have no tempo data.</Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ ...baseStyles });
