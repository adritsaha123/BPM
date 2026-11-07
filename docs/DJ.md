# DJ mode (open-license music at the exact BPM)

Spotify can only *pick* songs near the target tempo: its API gives no access to the audio. DJ mode
uses openly licensed songs from **Jamendo** (Creative Commons) that the app streams and plays
itself, so it can do what a DJ app does:

- **Lock every song to the exact target BPM**: time-stretched with pitch correction (up to ±8%,
  where it still sounds natural).
- **Follow BPM changes smoothly mid-song**: a nudge re-stretches the current song; a jump too big
  for it blends into a better match over 3 s.
- **Blend into the next song** over 8 s, 12 s before the current one ends. The next pick is chosen
  by tempo and by energy toward your zone (push = high energy, ease = calm), like Spotify mode.
- **No choppy switches**: the next song is loaded ~40 s ahead, the blend only starts once it is
  actually playing, and volumes move every 50 ms on an equal-power curve (no loudness dip).
- Works in **Expo Go** (it just streams MP3s).

On the setup screen: **Music → DJ**. The workout uses `DJ_CONTROL` in
`mobile/src/engine/controller.ts`: 4 BPM steps every 20 s, kept at 145-185 BPM.

| Piece | Where |
|---|---|
| Song catalog (committed) | `backend/app/data/dj_catalog.json` |
| Catalog builder (laptop) | `backend/scripts/build_dj_catalog.py` |
| Ranking + playback rate | `backend/app/dj.py`, `GET /dj/match`, `GET /dj/status` |
| Player (stretch + crossfade) | `mobile/src/audio/djOutput.ts` |

## The catalog
Jamendo has stream links and licenses but **no BPM**, so the builder measures it: it downloads ~75 s
of each candidate, estimates tempo and loudness with librosa, and keeps songs whose running tempo
(half/double time counts) is 140-190 BPM. It searches styles with many fast songs (drum & bass, trap,
punk, EDM, pop, rock, trance, breakbeat, techno). Energy is the song's loudness rank within the catalog.

```powershell
cd backend
.venv\Scripts\activate
pip install -r requirements-catalog.txt        # once (laptop only; Render doesn't need it)
python scripts/build_dj_catalog.py             # ~4 s per new song; re-runs reuse measurements
python scripts/build_dj_catalog.py --per-tag 40   # bigger catalog
```
Needs `JAMENDO_CLIENT_ID` in `backend/.env` (free app at devportal.jamendo.com). The catalog holds no
keys, so it's committed; deploy it like any other change (merge to `main`, update `render`).

## Licenses
- Songs licensed **No Derivatives (ND)** are skipped, because the app changes their tempo.
- Every license used requires **credit**: the app shows "Song — Artist · CC license" while playing.
- Many songs are **NonCommercial (NC)**. Fine for a hackathon demo; anything commercial needs
  Jamendo's commercial licensing and a read of their API terms.
- BPM estimates can be off by a small amount, and occasionally land on half or double the felt
  tempo. Spot-check songs you rely on in a demo.
