# Video handoff: Promise Graph demo video (3:00)

**Written Oct 18, 2026, ~18:55 IST.** Hackathon deadline: **Oct 18, 23:59 IST** (submit by the evening).
Rule 10 needs "a demo video showing the working project". Goal: a polished 3-minute explainer that
mixes motion graphics with real footage of the app, with narration, captions, music and sound effects.

## Where it stands

| Piece | State |
|---|---|
| Narration script (`script.json`) | **Done.** 13 scenes, 44 lines, exactly **180.0 s** (`build/timeline.json`). |
| Voiceover (`build/vo/*.wav`) | **Done** with Kokoro (local, voice `af_heart`, speed 1.05). Committed, so no Kokoro is needed unless a line changes. |
| Captions (`promise-graph-demo.srt`) | Done (voice.py writes it). |
| App footage (`clips/*.mp4`) | **Captured on Kevin's laptop, NOT in git** (2400x1350 all-intra, 25-230 MB each). Recreate with `capture.mjs` (~3 min, see below). |
| Composition (`index.html`) | **Built, needs the fixes listed below.** All 13 scenes render; 29 stills were reviewed. |
| Sound cues (`build/cues.json`) | Done (95 cues). Re-run `node video/render.mjs --cues` after editing index.html. |
| Music + mix (`audio.py` → `build/mix.wav`) | **Not run yet.** |
| Full render (`promise-graph-demo.mp4`) | **Not done yet.** |
| Upload + link in README | Not done. |

## The pipeline (all in `video/`, adapted from Kevin's own promo tooling)

```bash
python video/voice.py                 # script.json -> build/vo/*.wav + build/timeline.json + .srt   (only if lines change)
node video/capture.mjs                # films the real app -> clips/*.mp4                             (needs the app, below)
node video/render.mjs --cues          # build/cues.json: the sound cues index.html lists
python video/audio.py                 # build/music.wav, sfx.wav, mix.wav (voice ducks the music, -14 LUFS)
node video/render.mjs --stills 6.5,45,90,106,149   # stills/*.jpg to check frames first
node video/render.mjs                 # promise-graph-demo.mp4, 1920x1080, 30 fps, with build/mix.wav as sound
```

* `index.html` paints any moment t exactly (`window.__seek`). Timing comes from `build/timeline.json`.
  Each scene's `render(t, s)` places its elements relative to its lines (`at('a1')` = when line a1 starts).
  Open it in a browser without `?render` to preview it in real time (no sound).
* `render.mjs` screenshots every frame over the DevTools protocol and pipes them to ffmpeg. It needs
  Chrome (or Edge) and `ffmpeg` on PATH. A full render is 5,400 frames, roughly 15-25 minutes.
* `audio.py` needs Python with numpy, scipy and soundfile. On Kevin's laptop, `python` (3.11) has them,
  and Kokoro too.
* Fonts: `assets/inter.woff2` (Inter, from the app). The mono font is Cascadia Mono or Consolas.

## Recreating the footage (clips/ is not in git)

1. `docker compose up -d`. On a fresh machine, also run `cd backend && python -m scripts.load`.
2. Build the UI (`npm --prefix frontend run build`) and run **one** API process serving it on :8000:
   `backend/.venv/Scripts/python.exe -m uvicorn promisegraph.api:app --app-dir backend --port 8000`.
   **Only one API against FalkorDB.** Two processes can briefly show 741 orders instead of 755.
3. `cd backend && python -m scripts.reset_demo`, then `node video/capture.mjs` from the repo root, then
   `reset_demo` again (the clips run and approve a real agent run).
4. Clips: landing, ask, split, why, engines, agents, approve, walk, memory, bench. The capture bug that
   held a stale frame at the start of each clip is fixed in capture.mjs. Clips filmed before that fix
   were trimmed by hand.
5. Check them: `ffmpeg -i clips/agents.mp4 -vf "fps=6/20,scale=640:-1,tile=3x2" -frames:v 1 sheet.jpg`.

## Fixes to apply to index.html before the full render (found in the still review)

1. **Footage that never seeks (the important one).** In `render(t)`, a clip counts as active only if
   `+r.el.style.opacity !== 0`, but an unset opacity is `''`, so `+'' === 0` and the clip is never seeked.
   That's why the agents, gate (approve) and engines scenes froze on the clip's first frame. Replace that line with:
   `for (const r of videos) { const op = r.el.style.opacity; const on = r.el.closest('.scene').style.display !== 'none' && (op === '' || +op > 0.001); r.active = on && r.want != null; }`
2. **why scene:** the timeline wasn't drawn yet at clip time 5.6. Change `lerp(5.6, 13.4, P(lt, 1.75, w3))`
   to `lerp(7.0, 13.5, P(lt, 1.75, w3))`.
3. **hook scene:** the "Port of Singapore · CLOSED" label runs off the right edge. Anchor it to the left
   of its dot (`text-anchor: end`, x - 22, y + 40). Push the 14 "LATE" mini cards further out horizontally
   (`rr * 1.72` instead of `rr * 1.45`, and `0.86` vertically, in both the position and the `d` distance)
   so they don't collide with "Which promises just broke?".
4. **model scene:** the Cypher lines overflow the code card. Break the `CASE WHEN ...` line in two
   (`CASE WHEN d > f.buffer_days` / `THEN d - f.buffer_days ELSE 0 END) AS delay`), end with
   `RETURN pr.id, delay`, set `.code` to 22px, and widen the card (left 1000, top 170, width 870).
5. **memory scene:** the tenants row (`top:900px`) sits under the captions. Move it to `top:858px`.
6. **honest scene:** the chart line labels are clipped ("Post", "Falk"). Make the svg width `cw + 300`
   and `cw = 800, ch = 440`. Move the clusters card to `left:1150px; width:700px`. Replace the bottom
   row of three bug pills (under the captions) with a card at top right (`left:1150px; top:150px;
   width:700px`, fading in at line b5): A, a grouped node loses its relationships; B, WHERE dropped
   before a variable-length path (known upstream, #2972); C, server panic on collect() over OPTIONAL MATCH;
   plus the tag `python -m scripts.repro_falkordb`. The bench clip has faded out by then, so the space is free.

After these: `node video/render.mjs --cues`, then `--stills` at 6.5, 9.8, 33, 40, 61, 74, 90, 100, 106,
111, 131, 149, 153. Check them, then audio.py and the full render.

## Nice-to-have, only if there's time

* The agents clip doesn't show the run "building": the run finished before the Agents view opened. If
  you re-film it, switch to the Agents view before clicking "Run the agents" (the view only exists once a
  run exists, so: run once, reset nothing, switch to Agents, click "Run again").
* A short FalkorDB Browser shot (http://localhost:3300) running the README's Cypher query.

## The story, scene by scene (times from build/timeline.json)

| Scene | Time | Visual |
|---|---|---|
| hook | 0-11 | "Every order is a promise", a promise card, a port lane map with Singapore closing, promises flipping to LATE |
| logo | 11-17 | Promise Graph logo, "Agents with a memory, built on FalkorDB", event/track/team pills |
| problem | 17-30 | Aisha's real chain: Port of Singapore → radio modules (+8d) → PCB assemblies (+6d, 2 days buffer) → smart home devices (+5d) → replenishment (+4d) → parcel (+4d) → her order, 3 days late, $63 |
| model | 30-43 | The graph model (Event, Hub, Leg, Shipment FEEDS Shipment, Order, Customer, Promise) and the Q1 Cypher |
| answer | 43-59 | Footage: typing the question → diagram → globe, a 755 / $114,065 count-up, "the AI only picks a template" |
| why | 59-71 | Footage: Aisha on the globe, then the Timeline, then Step by step |
| engines | 71-80 | Footage: switch to PostgreSQL, Compare engines ("same rows") |
| agents | 80-104 | Footage of the run, plus the six agents with their FalkorDB tools, then the decision chain |
| gate | 104-114 | Footage: Kevin's self-approval blocked (stamp), Pranay approves (stamp), Comms |
| memory | 114-133 | Past runs (Suez didn't pay off; Port Klang, Colombo worked) → playbooks → Finance: 3 by sea, $19,180, $68,257 saved, 406 orders; one graph per company |
| honest | 133-155 | Bench clip, parity, sweep chart (FalkorDB ~30 ms vs Postgres ~100 ms), clusters (pgRouting wins: 54 vs 135 ms), three engine bugs |
| tracks | 155-171 | Track 2 and Track 1 checklists next to the agents walking the globe |
| outro | 171-180 | Logo, tagline, repo URL, team, disclosures (synthetic data, synthetic voice, Claude Code) |

Every number is from the live app on Oct 18 (northwind, Singapore Oct 20-24): 755 orders, $114,065,
6 groups, 12 root shipments, 1,784 shipments delayed. Rerouter: 8 routes for 4 of 12 roots. Finance:
3 by sea for $19,180, saving $68,257, 406 orders back on time, fees $114,065 → $45,808. Verifier: 13 of 13.
Sweep and clusters numbers are from bench/NOTES.md and the README. If you change a figure, check it there.

## After the render

* Watch it once through: every scene start, captions vs voice, no frozen footage, no clipped text.
* Upload it (YouTube unlisted or Drive), put the link in the README ("Demo video") and in the submission form.
* `python -m scripts.reset_demo` so the app's demo memory is back to the seeded state.
