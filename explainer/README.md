# The demo video

`promise-graph-demo-quick.mp4`: 3:26, 1920x1080, narrated, captions burned in (also as
`promise-graph-explainer.srt`). Real footage of the app for every feature, with slides for the
problem, the graph model, the agents, memory and why FalkorDB. No Remotion; just Chrome and ffmpeg.

| Part | Time | What you see |
|---|---|---|
| The problem | 0:00 | Aisha's order, Singapore closes, the delay travelling 4 steps down the chain; 755 orders, $114,065 |
| Promise Graph | 0:36 | What it does |
| The graph | 0:44 | The FalkorDB model and the Cypher that walks the damage (`FEEDS*0..8`) |
| Ask the graph | 0:56 | Footage: a question typed in plain English, the answer graph, Globe, Step by step, Aisha's chain and Timeline, four more questions |
| Coordination | 1:32 | The six agents and their FalkorDB tools; footage of a real run, self-approval blocked, approval, the Agents view, the agents walking the globe |
| Memory | 2:15 | Suez delivered 28%, sea reroutes 95%; LA: memory turns $409,441 of air freight into "no rescue"; footage of the memory card and the with/without comparison ($220,656 avoided) |
| Why FalkorDB | 3:03 | Footage of Compare engines; Postgres as a same-rows baseline; bugs found; nothing runs without FalkorDB |

## Rebuilding it

Everything regenerable goes to `build/` (git-ignored, ~1 GB with the footage frames).

```bash
# 1. narration: script.json -> build/vo/*.wav, build/narration.wav, build/timeline.json, the .srt
#    (needs Python 3.12 with: pip install kokoro soundfile; the first run downloads the Kokoro-82M voice)
python explainer/voice.py

# 2. footage: the app must be running (docker compose up -d, API on :8000, web on :5173)
node explainer/capture.mjs            # every clip -> build/clips/<name>/00001.jpg ...

# 3. the cut: slides.html -> PNGs, footage timed to the narration, captions, loudness-normalised audio
node explainer/quick.mjs              # -> explainer/promise-graph-demo-quick.mp4
```

`capture.mjs` runs real agent runs (Singapore, requested by Kevin and approved by Pranay; LA / Long
Beach), so it adds runs to the demo memory. Run `python -m scripts.reset_demo` from `backend/` first if
you want the seeded memory only.

The narration voice is synthetic (Kokoro, voice `af_heart`), and all data in the video is synthetic.
A fuller motion-graphics version was planned but not built; `video/` holds a teammate's separate,
unfinished one.
