"""Song tempo (BPM) lookup, and matching a song's tempo to a live heart rate.

Spotify returns 403 on /audio-features for apps created after Nov 27 2024, so tempo comes from
ReccoBeats (free, no API key): GET https://api.reccobeats.com/v1/audio-features?ids=<spotify ids>
with at most 40 ids per call. Tracks ReccoBeats doesn't know are simply missing from the
response, so their tempo is None. Results are cached in memory for the life of the process.

ReccoBeats also returns each song's energy and danceability (0-1). Coach mode uses energy too:
pushing the heart rate up picks fast *and* high-energy songs, easing off picks calmer ones
(see fit_score).

Matching treats half and double time as the same groove: a 85 BPM song "fits" a heart rate of
170 (one beat every two heartbeats), and a 180 BPM song fits 90.
"""

from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from app import spotify

RECCOBEATS_URL = "https://api.reccobeats.com/v1/audio-features"
BATCH = 40  # ReccoBeats rejects more: "size must be between 1 and 40"
RETRY_AFTER_FAILURE_S = 30
IN_SYNC_BPM = 3  # |song - heart rate| within this = in sync
CLOSE_BPM = 8

FEATURES = ("tempo", "energy", "danceability")
Features = dict[str, float | None]

HEADERS = {"Accept": "application/json", "User-Agent": "BPM-hackathon/0.1"}

# Lookup by title + artist (see lookup_tempo). ReccoBeats answers 429 + Retry-After after ~40
# requests in ~10 s; Deezer allows 50 requests / 5 s. So Deezer finds the recordings and ReccoBeats
# gets as few requests as possible (40 ISRCs per tempo request).
RECCOBEATS_SEARCH_URL = "https://api.reccobeats.com/v1/track/search"
RECCOBEATS_MIN_INTERVAL_S = 0.25
SEARCH_PAGES = 2  # 50 hits per page, most popular first; a hit title has hundreds of covers
DEEZER_SEARCH_URL = "https://api.deezer.com/search"
DEEZER_TRACK_URL = "https://api.deezer.com/track/{}"
DEEZER_MIN_INTERVAL_S = 0.12
DEEZER_TRACKS = 2  # Deezer matches to open for their ISRC + BPM (one request each)
ISRCS_PER_SONG = 3  # recordings per song to ask ReccoBeats about
ARTISTS_CHECKED = 3  # covers list songwriters after the performers ("..., Mark Ronson, Bruno Mars")
DURATION_TOLERANCE_S = 15  # a match this far off in length is probably a live/extended/edited version
RATE_LIMIT_WAIT_S = 5  # pause when rate limited without a Retry-After
RATE_LIMIT_MAX_WAIT_S = 30  # longer than this: give up for now (not cached, so retried next time)
CACHE_FILE: Path | None = Path(__file__).resolve().parents[1] / "data" / "tempo_cache.json"  # gitignored
CACHE_VERSION = 2  # bump when matching changes, so cached misses get looked up again

_cache: dict[str, Features | None] = {}
_last_failure = 0.0

_meta_cache: dict[str, dict | None] | None = None  # "title|artist" -> lookup_tempo result or None
_meta_lock = threading.Lock()
_rate_lock = threading.Lock()
_next_call: dict[str, float] = {}  # host -> earliest time of its next request


def _fetch(ids: list[str]) -> dict[str, Features | None] | None:
    """One ReccoBeats call. None means the request failed (don't cache, retry later)."""
    try:
        r = httpx.get(
            RECCOBEATS_URL,
            params={"ids": ",".join(ids)},
            headers={"Accept": "application/json", "User-Agent": "BPM-hackathon/0.1"},
            timeout=15,
        )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    found: dict[str, Features | None] = dict.fromkeys(ids)
    for row in r.json().get("content") or []:
        spotify_id = (row.get("href") or "").rstrip("/").rsplit("/", 1)[-1]
        if spotify_id in found and row.get("tempo"):
            found[spotify_id] = {
                "tempo": round(float(row["tempo"]), 1),
                **{k: _round(row.get(k)) for k in FEATURES[1:]},
            }
    return found


def _round(v: object) -> float | None:
    return round(float(v), 2) if isinstance(v, int | float) else None


def _as_features(v: Features | float | None) -> Features | None:
    """Cache entries are feature dicts; a bare number is treated as just a tempo."""
    if v is None or isinstance(v, dict):
        return v
    return {"tempo": float(v), "energy": None, "danceability": None}


def get_features(track_ids: list[str]) -> dict[str, Features | None]:
    """Spotify track id -> {tempo, energy, danceability} (None if ReccoBeats doesn't know it)."""
    global _last_failure
    out: dict[str, Features | None] = {}
    missing: list[str] = []
    for tid in dict.fromkeys(track_ids):  # dedupe, keep order
        if tid in _cache:
            out[tid] = _as_features(_cache[tid])
        elif (mock := spotify.mock_features(tid)) is not None:
            out[tid] = mock
        else:
            missing.append(tid)

    for i in range(0, len(missing), BATCH):
        chunk = missing[i : i + BATCH]
        fetched = None
        if time.time() - _last_failure >= RETRY_AFTER_FAILURE_S:
            fetched = _fetch(chunk)
            if fetched is None:
                _last_failure = time.time()
        if fetched is None:
            out.update(dict.fromkeys(chunk))
            continue
        fetched = {k: _as_features(v) for k, v in fetched.items()}
        _cache.update(fetched)
        out.update(fetched)
    return out


def get_tempos(track_ids: list[str]) -> dict[str, float | None]:
    """Spotify track id -> tempo in BPM (None if unknown)."""
    return {tid: (f or {}).get("tempo") for tid, f in get_features(track_ids).items()}


def get_tempo(track_id: str) -> float | None:
    return get_tempos([track_id]).get(track_id)


# Coach mode works in running tempo: runners fall into step with the beat, and heart rate follows
# cadence. So the music steps from the current song's tempo toward the zone, one song at a time.
# --------------------------------------------------------------------------- by title + artist


def _load_meta_cache() -> dict[str, dict | None]:
    global _meta_cache
    with _meta_lock:
        if _meta_cache is None:
            _meta_cache = {}
            if CACHE_FILE and CACHE_FILE.exists():
                try:
                    saved = json.loads(CACHE_FILE.read_text())
                    if saved.get("version") == CACHE_VERSION:
                        _meta_cache = saved.get("songs") or {}
                except (OSError, ValueError, AttributeError):
                    pass
        return _meta_cache


def _save_meta_cache() -> None:
    if not CACHE_FILE or _meta_cache is None:
        return
    with _meta_lock:
        try:
            CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            CACHE_FILE.write_text(json.dumps({"version": CACHE_VERSION, "songs": _meta_cache}))
        except OSError:
            pass


def reset_meta_cache() -> None:
    global _meta_cache
    with _meta_lock:
        _meta_cache = None


class _Unreachable(Exception):
    """A tempo source didn't answer (network error, still rate limited): don't cache, retry later."""


def _wait_turn(host: str, min_interval: float) -> None:
    """Space requests to a host min_interval apart across threads (and past a rate-limit pause)."""
    with _rate_lock:  # reserve the host's next free slot, then wait for it outside the lock
        now = time.time()
        slot = max(now, _next_call.get(host, 0.0))
        _next_call[host] = slot + min_interval
    if slot > now:
        time.sleep(slot - now)


def _pause(host: str, seconds: float) -> None:
    """Rate limited: hold every request to this host for a while."""
    with _rate_lock:
        _next_call[host] = max(_next_call.get(host, 0.0), time.time() + seconds)


def _get_json(url: str, params: dict | None, host: str, min_interval: float) -> Any:
    """Rate-limited GET -> JSON. Waits out one rate limit (429 + Retry-After, or Deezer's quota
    error), then raises _Unreachable on a network error, non-200 or error body."""
    for attempt in range(2):
        _wait_turn(host, min_interval)
        try:
            r = httpx.get(url, params=params, headers=HEADERS, timeout=15)
            data = r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            raise _Unreachable(url) from None
        error = data.get("error") if isinstance(data, dict) else None
        quota = isinstance(error, dict) and error.get("code") == 4  # Deezer: "Quota limit exceeded"
        if attempt == 0 and (r.status_code == 429 or quota):
            try:
                wait = float(r.headers.get("retry-after") or RATE_LIMIT_WAIT_S)
            except ValueError:
                wait = RATE_LIMIT_WAIT_S
            if wait <= RATE_LIMIT_MAX_WAIT_S:
                _pause(host, wait)
                continue
        if data is None or error:
            raise _Unreachable(url)
        return data
    raise _Unreachable(url)


def _norm(text: str) -> str:
    """For comparing names: "Beyoncé & JAY-Z" -> "beyonce and jay z"."""
    text = unicodedata.normalize("NFKD", text.replace("&", " and "))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[\W_]+", " ", text).split())


_FEATURING = re.compile(r"\s*[\(\[](?:feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]", re.IGNORECASE)
_TRAILING_TAG = re.compile(r"(?:\s*[\(\[]([^\(\)\[\]]*)[\)\]]|\s+[-–—]\s+(.+?))\s*$")
# Tags that don't change a recording's tempo: "- 2011 Remaster", "(Radio Edit)", "(From "Barbie")".
_SAME_TEMPO_TAG = re.compile(
    r"\b(?:remaster(?:ed)?|mono|stereo|deluxe|radio edit|single version|album version|original mix"
    r"|explicit|clean|bonus track|from|feat|ft|featuring|with)\b"
)
# Tags that mean another recording, maybe at another tempo. Never stripped, so "Song - Live" can't
# match "Song".
_OTHER_VERSION = re.compile(
    r"\b(?:live|remix|acoustic|instrumental|karaoke|cover|demo|sped up|slowed|reverb|nightcore"
    r"|unplugged|a cappella|acapella|orchestral|lofi|lo fi|piano version|8d)\b"
)


def _strip_tags(title: str) -> str:
    """Title without featuring credits and tags that keep the tempo: "Hey Jude - Remastered 2015"
    -> "Hey Jude". Tags like "- Live" or "(Remix)" stay."""
    title = _FEATURING.sub("", title).strip()
    while m := _TRAILING_TAG.search(title):
        tag = _norm(m.group(1) or m.group(2) or "")
        if not _SAME_TEMPO_TAG.search(tag) or _OTHER_VERSION.search(tag) or not title[: m.start()].strip():
            break
        title = title[: m.start()].strip()
    return title


def _main_artist(artist: str) -> str:
    return re.split(r",|&| feat\.? | ft\.? | x ", artist, maxsplit=1, flags=re.IGNORECASE)[0].strip()


@dataclass(frozen=True)
class _Song:
    """A library song being looked up, normalized for checking search hits against it."""

    search: str  # title to search for, without tags
    title: str  # normalized search
    artist: str  # normalized full credit, e.g. "calvin harris and dua lipa"
    main_artist: str  # first credited artist, as written
    duration_s: float | None

    @classmethod
    def of(cls, title: str, artist: str, duration_s: float | None) -> _Song:
        search = _strip_tags(title)
        return cls(search, _norm(search), _norm(artist), _main_artist(artist), duration_s)

    def same_song(self, title: str, artists: list[str], duration_s: float | None) -> bool:
        """Same title (ignoring tags like "Remastered"), about as long, by one of the same artists.
        Most hits for a popular title are covers, so the artist has to match."""
        if _norm(_strip_tags(title)) != self.title:
            return False
        if self.duration_s and duration_s and abs(duration_s - self.duration_s) > DURATION_TOLERANCE_S:
            return False
        if not self.artist:
            return True  # nothing to check against: the most popular hit wins
        main = _norm(self.main_artist)
        names = [_norm(a) for a in artists[:ARTISTS_CHECKED]]
        return any(n and (n == main or f" {n} " in f" {self.artist} ") for n in names)


def _best_first(hits: list[dict]) -> list[dict]:
    """Most popular first: the original release, not a compilation or re-release."""
    return sorted(hits, key=lambda h: -(h["popularity"] or 0))


def _deezer_search(song: _Song) -> list[dict]:
    """The song's recordings on Deezer (searchable by artist + title), opened for ISRC and BPM."""
    q = f"{song.main_artist} {song.search}".strip()
    data = _get_json(DEEZER_SEARCH_URL, {"q": q, "limit": 10}, "deezer", DEEZER_MIN_INTERVAL_S)
    hits = []
    for t in data.get("data") or []:
        artists = [(t.get("artist") or {}).get("name") or ""]
        if song.same_song(t.get("title") or "", artists, t.get("duration")):
            hits.append(
                {"id": t.get("id"), "title": t.get("title"), "artists": artists, "popularity": t.get("rank")}
            )
    hits = _best_first(hits)[:DEEZER_TRACKS]
    for hit in hits:
        track = _get_json(DEEZER_TRACK_URL.format(hit["id"]), None, "deezer", DEEZER_MIN_INTERVAL_S)
        hit["isrc"], hit["bpm"] = track.get("isrc"), float(track.get("bpm") or 0)
    return hits


def _reccobeats_search(song: _Song) -> list[dict]:
    """The song's recordings on ReccoBeats. Its search takes only a title (most popular first)."""
    hits: list[dict] = []
    for page in range(SEARCH_PAGES):
        params = {"searchText": song.search, "size": 50, "page": page}
        data = _get_json(RECCOBEATS_SEARCH_URL, params, "reccobeats", RECCOBEATS_MIN_INTERVAL_S)
        for t in data.get("content") or []:
            artists = [a.get("name") or "" for a in t.get("artists") or []]
            seconds = (t.get("durationMs") or 0) / 1000
            if song.same_song(t.get("trackTitle") or "", artists, seconds):
                hits.append(
                    {
                        "title": t.get("trackTitle"),
                        "artists": artists,
                        "popularity": t.get("popularity"),
                        "isrc": t.get("isrc"),
                    }
                )
        if hits or page + 1 >= (data.get("totalPages") or 0):
            break
    return _best_first(hits)


def _result(bpm: float, source: str, hit: dict) -> dict:
    matched = f"{hit['title']} - {', '.join(hit['artists'][:ARTISTS_CHECKED])}"
    return {"bpm": round(bpm, 1), "source": source, "matched": matched, "isrc": hit.get("isrc")}


@dataclass
class _Lookup:
    """One song's lookup in progress."""

    song: _Song
    hits: list[dict] = field(default_factory=list)  # its recordings found so far, best first
    asked: set[str] = field(default_factory=set)  # ISRCs ReccoBeats was already asked about
    result: dict | None = None
    failed: bool = False  # a source didn't answer, so "not found" might be wrong: don't cache it


def _search_each(jobs: list[_Lookup], search: Callable[[_Song], list[dict]], workers: int) -> None:
    def run(job: _Lookup) -> None:
        try:
            job.hits += search(job.song)
        except _Unreachable:
            job.failed = True

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(run, jobs))


def _tempos_by_isrc(jobs: list[_Lookup]) -> None:
    """Tempo of each job's best hit that ReccoBeats has audio features for, 40 ISRCs per request."""
    todo = {id(j): [h["isrc"] for h in j.hits if h.get("isrc") and h["isrc"] not in j.asked] for j in jobs}
    todo = {k: list(dict.fromkeys(v))[:ISRCS_PER_SONG] for k, v in todo.items()}
    isrcs = list(dict.fromkeys(i for v in todo.values() for i in v))
    tempos: dict[str, float] = {}
    failed: set[str] = set()
    for n in range(0, len(isrcs), BATCH):
        chunk = isrcs[n : n + BATCH]
        try:
            data = _get_json(
                RECCOBEATS_URL, {"ids": ",".join(chunk)}, "reccobeats", RECCOBEATS_MIN_INTERVAL_S
            )
        except _Unreachable:
            failed.update(chunk)
            continue
        for row in data.get("content") or []:  # one row per Spotify release of the recording
            if row.get("isrc") and row.get("tempo"):
                tempos.setdefault(row["isrc"], float(row["tempo"]))
    for j in jobs:
        j.failed |= bool(failed.intersection(todo[id(j)]))
        j.asked.update(i for i in todo[id(j)] if i not in failed)
        best = next((h for h in j.hits if h.get("isrc") in tempos), None)
        if best and not j.result:
            j.result = _result(tempos[best["isrc"]], "reccobeats", best)


def _find_tempos(songs: list[_Song], workers: int) -> list[_Lookup]:
    jobs = [_Lookup(s) for s in songs]
    _search_each(jobs, _deezer_search, workers)  # 1. find each recording on Deezer -> ISRC
    _tempos_by_isrc(jobs)  # 2. tempo of those ISRCs on ReccoBeats
    rest = [j for j in jobs if not j.result]
    _search_each(rest, _reccobeats_search, workers)  # 3. not found: search ReccoBeats by title
    _tempos_by_isrc(rest)
    for j in rest:  # 4. last resort: Deezer's own BPM (0 = unknown; often missing for big labels)
        best = next((h for h in j.hits if h.get("bpm")), None)
        if best and not j.result:
            j.result = _result(best["bpm"], "deezer", best)
    return jobs


def lookup_many(tracks: list[dict], max_workers: int = 4) -> dict[str, dict | None]:
    """[{"id", "title", "artist", "duration_s"}] -> {id: lookup_tempo result or None}."""
    cache = _load_meta_cache()
    out: dict[str, dict | None] = {}
    songs: dict[str, _Song] = {}  # cache key -> song
    ids: dict[str, list[str]] = {}  # cache key -> track ids (a library can have a song twice)
    for t in tracks:
        artist = t.get("artist") or ""
        key = f"{t['title'].strip().lower()}|{artist.strip().lower()}"
        song = _Song.of(t["title"], artist, t.get("duration_s"))
        if key in cache or not song.title:
            out[t["id"]] = cache.get(key)
        else:
            songs.setdefault(key, song)
            ids.setdefault(key, []).append(t["id"])
    if not songs:
        return out
    jobs = _find_tempos(list(songs.values()), max_workers)
    with _meta_lock:
        for key, job in zip(songs, jobs, strict=True):
            out.update(dict.fromkeys(ids[key], job.result))
            if job.result or not job.failed:
                cache[key] = job.result
    _save_meta_cache()
    return out


def lookup_tempo(title: str, artist: str, duration_s: float | None = None) -> dict | None:
    """Tempo of a song by title + artist: {"bpm", "source", "matched", "isrc"}, or None if unknown.

    1. Deezer search by artist + title; keep the same song by the same artist at about the same
       length (not a cover, live or remixed version), then open it for its ISRC.
    2. ReccoBeats audio features for that ISRC -> tempo.
    3. Not found: ReccoBeats search by title, same checks, then its ISRC's tempo.
    4. Still nothing: Deezer's own BPM, if it has one.
    Hits and misses are cached on disk; a source being down or rate limiting is not cached.
    """
    return lookup_many([{"id": "song", "title": title, "artist": artist, "duration_s": duration_s}])["song"]


RUN_MIN_BPM = 150  # slower than this stops feeling like running music
RUN_MAX_BPM = 185
RUN_START_BPM = 160  # nothing playing yet: an easy running cadence
COACH_STEP_BPM = 8  # per song: Spotify changes tempo song by song, so smaller steps get lost


def running_tempo(song_bpm: float) -> float:
    """A song's tempo as a running cadence: halve or double it into 150-185 if that fits better
    (an 85 BPM song runs at 170), else the closest of the three."""

    def outside(b: float) -> float:
        return max(RUN_MIN_BPM - b, 0, b - RUN_MAX_BPM)

    return min((song_bpm, song_bpm * 2, song_bpm / 2), key=outside)


def coach_target(
    current_hr: float,
    zone_min: float,
    zone_max: float,
    song_bpm: float | None = None,
    step: float = COACH_STEP_BPM,
) -> dict:
    """Coach mode: the music tempo that nudges the heart rate toward a training zone.

    Start from the current song's tempo (as a running cadence) and move one step: faster when the
    heart rate is below the zone, slower above it, the same inside it. Always within 150-185.
    """
    base = running_tempo(song_bpm) if song_bpm else RUN_START_BPM
    base = min(max(base, RUN_MIN_BPM), RUN_MAX_BPM)
    if current_hr < zone_min:
        target, direction = base + step, "push"
    elif current_hr > zone_max:
        target, direction = base - step, "ease"
    else:
        target, direction = base, "hold"
    target = min(max(target, RUN_MIN_BPM), RUN_MAX_BPM)
    return {"target_bpm": round(target, 1), "direction": direction, "from_bpm": round(base, 1)}


def match(song_bpm: float | None, target_bpm: float | None) -> dict | None:
    """How well a song's tempo fits a target (usually the live heart rate).

    speed_to_match is the playback rate the song would need to lock in exactly. Spotify can't
    change speed, so it's informational (and what an own-audio player would use).
    """
    if not song_bpm or not target_bpm:
        return None
    options = [(song_bpm, 1.0), (song_bpm * 2, 2.0), (song_bpm / 2, 0.5)]
    effective, multiple = min(options, key=lambda o: abs(o[0] - target_bpm))
    diff = effective - target_bpm
    status = "in_sync" if abs(diff) <= IN_SYNC_BPM else "close" if abs(diff) <= CLOSE_BPM else "off"
    return {
        "song_bpm": round(song_bpm, 1),
        "target_bpm": round(target_bpm, 1),
        "effective_bpm": round(effective, 1),
        "multiple": multiple,
        "diff_bpm": round(diff, 1),
        "status": status,
        "speed_to_match": round(target_bpm / effective, 3),
    }


# How energetic the music should feel for each coaching direction (ReccoBeats energy, 0-1).
INTENSITY_ENERGY = {"push": 0.8, "hold": 0.65, "ease": 0.4}
ENERGY_WEIGHT = 10  # 0.1 of energy off the goal counts like being 1 BPM off
UNKNOWN_ENERGY_PENALTY = 0.2  # songs with no energy data rank as if 0.2 off
HALF_DOUBLE_PENALTY = 2  # BPM-equivalent cost of matching at half or double time


def fit_score(match_info: dict | None, energy: float | None, intensity: str | None) -> float | None:
    """Lower is better. Tempo stays in charge; energy breaks near-ties.

    - tempo: distance from the target in BPM
    - wrong way: when pushing, songs slower than the target count double (and faster ones when
      easing off), so energy never drags the tempo the wrong way
    - energy: how far the song is from what that direction wants (push = high, ease = calm)
    """
    if not match_info:
        return None
    diff = match_info["diff_bpm"]
    score = abs(diff)
    if (intensity == "push" and diff < 0) or (intensity == "ease" and diff > 0):
        score += abs(diff)
    if intensity and match_info.get("multiple", 1) != 1:
        score += HALF_DOUBLE_PENALTY  # a half/double-time fit works, a song at the real tempo drives better
    want = INTENSITY_ENERGY.get(intensity or "")
    if want is not None:
        off = abs(energy - want) if energy is not None else UNKNOWN_ENERGY_PENALTY
        score += ENERGY_WEIGHT * off
    return round(score, 2)
