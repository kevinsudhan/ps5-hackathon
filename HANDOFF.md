# Handoff: Promise Graph (Graph Hacks, Track 2)

**Written Oct 16, 2026, evening of day 2; updated Oct 17 and Oct 18 by Shyam.** Deadline: **Oct 18, 23:59 IST**.
Submit by the evening, not at 23:50. Everything marked "checked" was run on Kevin's laptop on Oct 16 or on
Shyam's on Oct 17 (fresh clone). If something was not run, it says so.

The product: a closed port breaks customer orders; Promise Graph shows which ones, why (a path through
the graph), which few shipments to rescue and what that costs. Six agents hand off through FalkorDB and
remember past disruptions. Postgres + pgRouting is only the benchmark baseline. Details: [README.md](README.md).

---

## Where it stands

| Part | State |
|---|---|
| Backend (FalkorDB, agents, memory, API) | Done. 39 integration tests pass, parity and concurrency scripts pass (checked Oct 18). |
| Frontend (query-driven answer graph 2D/3D, engine switch, agents timeline, memory, Benchmark, story) | Done. Builds with no warnings; every flow screenshot-checked on both companies and both disruptions (Oct 18). |
| Demo rehearsal | **Passed twice in a row** through the API and once fully in the UI (checked, details below). |
| FalkorDB bug report | Still reproduces (checked Oct 17). **Not posted.** B is already upstream (#2972, fix PR #3264): comment there. A is new: post it. Details at the top of `docs/falkordb-bug-report.md`. |
| Deploy | **Packaged, not hosted.** `docker compose --profile app up -d --build` runs everything on :8080 and loads the data on first start (checked from empty volumes). Hosting needs a VM with Docker (or FalkorDB Cloud + any container host): someone with an account. |
| README final pass | Done (Oct 18): status, both ways to run, screenshots of every view, the five views, a demo walkthrough with the numbers, architecture, bug section, rules checklist, demo video link. Only a deployment URL is missing. |
| Blog post | In `docs/blog-post.md` (linked in the submission). Not posted on a blogging platform. |
| Demo video | **Done (Oct 18):** `explainer/promise-graph-demo-quick.mp4`, 3:26, narrated with captions; real app footage plus slides. How it was made and how to rebuild it: `explainer/README.md`. (`video/` holds a teammate's separate motion-graphics version, not finished.) |

## Get it running (Windows, about 5 minutes)

Quickest (only Docker): `docker compose --profile app up -d --build`, then http://localhost:8080. For
development (hot reload), the steps below.

```bash
# Docker Desktop must be running first
docker compose up -d                      # FalkorDB :6379, Browser http://localhost:3300, Postgres :5544
cd backend
python -m venv .venv && .venv/Scripts/activate
pip install -r requirements.txt
cp .env.example .env                      # optional GEMINI_API_KEY; without it agents use templates
python -m scripts.load                    # northwind (20k orders) + lumen (3k), ~15 s
python -m pytest -q tests                 # 19 passed
cd ../frontend && npm install
```

Then start both servers from the repo root, or use the `api` / `web` entries in `.claude/launch.json`:

```bash
backend/.venv/Scripts/python.exe -m uvicorn promisegraph.api:app --app-dir backend --port 8000
npm --prefix frontend run dev             # http://localhost:5173
```

The data lives in Docker volumes, so after a restart you only need `docker compose up -d`.
`python -m scripts.load` is only needed on a fresh machine.

## What changed on Oct 18 (afternoon): globe, timeline, agents view, step by step

The stage's view switch is now **Diagram / Globe / Timeline / Agents** (the old 3D node view is no longer offered).

* **Globe** (`WorldMap.tsx`, `lib/geoScene.ts`, `backend/promisegraph/geo.py`): the answer on a dotted globe
  (globe.gl) with real port coordinates. Singapore shows a pulsing "Closed Oct 20-24" badge, shipments are arcs
  sized by impact, late orders are count bubbles, and a faint backdrop shows every port and lane. The corner card
  counts what the map draws. The story also plays on the globe.
* **Timeline** (why-late answers only; `OrderTimeline.tsx`, `timeline.py`): the chain on a calendar. Each step's
  planned trip, "+N days late here", buffer that soaked up delay, and the promised date vs the new arrival.
* **Agents** (once a run exists; `AgentRunGraph.tsx`, `runviz.py`): the run as handoffs. Memory (past runs,
  playbooks) sits above, world data below, and the approval and Comms write-back come at the end. It builds live.
* **Step by step** (button in the stage, Diagram or Globe): splits the stage. On the right (`AgentTrace.tsx`,
  `trace/`, `GET /runs/{id}/trace`) is how FalkorDB worked it out: what was asked, what it walked (with the
  Cypher), what came back, the answer. After a run there's also each agent's question to the graph, the
  FalkorDB feature it used, its result, memory and conclusion. Picking a step lights up its nodes on the left.
  Good for the video: Globe + Step by step, then click through the agents' run.

## What changed on Oct 18: a query-driven console

* **No graph until you ask.** The landing shows what happened (title, dates, four count-up figures) and a centred
  ask box with chips. After a question: the answer sentence, then a graph of **only the entities that answer it**,
  then "How it was found" (engine, time, the exact query with Copy, plain-English steps, Compare engines).
  The ask box docks at the bottom.
* **One shape per question** (backend `questions.py` `*_graph`, additive fields `rank`, `metric`, `count`, `blocked`,
  `weight`, `route`): ranked stuck shipments for orders at risk, a numbered chain for "why late", ranked rescue
  groups, hubs sized by score, fastest / cheapest options around a blocked hub. Max ~20 nodes; the UI folds the
  rest into "+N more" (click to expand) and lays fan-outs out as a grid (`frontend/src/lib/answerLayout.ts`).
* **New template `top_loss_orders`** ("the 10 most loss-inducing orders", N 1-50): the head of `at_risk`, Cypher
  and SQL twins, parity-tested. New chip. `/chips?event_id=` names the chosen disruption in its questions.
* **Top bar:** the Technical-details toggle is gone; an **engine switch** (FalkorDB primary / PostgreSQL) sits in
  its place and only changes who answers questions. Benchmark and Memory open the drawer.
* **Palette and tokens:** every colour, radius, shadow and timing lives in `frontend/src/styles/tokens.css`
  (contrast checked to WCAG AA; tints adjusted, the six core colours untouched).
* **Story graph:** orders are now linked to a *delayed* feeder of their last mile (three were drawn unlinked).
* **Memory drawer "duplicates"** are real repeated demo runs of the same disruption (different requesters), not a
  display bug; each item now says who requested and who approved it. Nothing was deleted.
* Demo numbers unchanged (755 / $114,065 / $19,180 / $68,257 / 406; LA 1,474 / $681,534 / $220,656).

## What changed on Oct 17 (afternoon): the three Track 2 features and a new console

* **Memory now changes decisions, and we can prove it.** Before, Finance's "rule out air freight" memory never
  changed a plan (air was never the best option anyway). Now each learned habit has a **track record**
  (actual / expected saving over its past outcomes, `memory.track_record`), Finance prices options with it,
  records whether that changed the plan (`USED_MEMORY {effect}`), and the Verifier re-reads it.
  Seeded history now stores expected vs actual savings (`history.py`).
* **LA / Long Beach now runs Nov 20-30** (into Thanksgiving week; was Nov 20-24), so air freight wins on paper
  there and memory flips the plan: without memory, air-freight 5 containers for $409,441; with memory, no rescue;
  expected loss avoided $220,656. **Singapore is unchanged** (755 / $114,065 / $19,180 / $68,257 / 406 / 13 of 13);
  memory is checked there and says it did not change the plan. Data was reloaded (`scripts.load`).
* **With vs without memory:** `POST /runs/{id}/without-memory` reruns the analysis with memory off (a real run,
  `COUNTERFACTUAL_OF`, never approvable) and compares; the inputs are checked identical.
* **Live agent timeline:** `POST /runs {live: true}` + `GET /runs/{id}/stream` (server-sent events). Each step is timed.
* **New console UI** (dark): incident bar with the numbers, graph in the middle, the agents' response on the right
  (timeline, approval, recommendation, memory influence, compare), technical details behind a toggle. The old
  Agents tab is gone (the timeline replaces it); the drawer keeps Memory and Benchmark.
* **FalkorDB bug C:** a query shape that panics the engine (server exits). Worked around; both containers now
  `restart: unless-stopped`. Text in `docs/falkordb-bug-report.md`.
* Recall only counts earlier disruptions (an approved LA run used to show up as "past" for Singapore).
* 31 tests (12 new in `tests/test_memory_features.py`); parity passes; screenshots retaken.

## What changed on Oct 17 (just after midnight)

* **One-command run / deploy packaging.** Root `Dockerfile` (builds the frontend, FastAPI serves it next to
  `/api`, one origin, no CORS) and an `app` service under the compose profile `app`. On start it runs
  `python -m scripts.load --if-missing` (new flag), so the first start loads both tenants (~12 s) and later
  starts skip it. `backend/.env` is passed in at run time and kept out of the image (`.dockerignore`).
* **Database ports now bind to 127.0.0.1** (healthchecks added), so a VM only exposes the app on 8080.
  Because of that, the backend defaults are now `127.0.0.1` instead of `localhost` (`config.py`): on
  Windows "localhost" tries IPv6 first, which cost ~2 s per FalkorDB connection and hung Postgres calls.
  `FALKOR_USERNAME` / `FALKOR_PASSWORD` are read too, for FalkorDB Cloud.
* **README final pass**, screenshots in `docs/screenshots/` (taken with headless Chrome at 1440x900;
  memory was reset afterwards with `scripts.reset_demo`).
* **Bug report re-checked** against open FalkorDB issues (see the table above), and a **blog post draft**.

## What changed on Oct 16 (evening)

* **Rehearsal.** Every suggestion chip on both engines gave the same rows. `Compare` reported the same
  answer, nonsense got a 422 with suggestions, the story loaded, the agents ran, self-approval got a 403,
  another person's approval worked and Comms drafted the message. Recall also worked. Two passes back to
  back, no reload. In the UI: story (all 6 steps), Agents, Memory, Benchmark, Compare, 3D.
* **Fixed: shipment names were lowercased** ("northwind dc venlo"). `str.capitalize()` lowercases the
  rest of the string; replaced with `questions._cap()`.
* **Fixed: internal codes in agent and memory text.** "one lane away from SGSIN" and "8 routes around
  SGSIN" now say "Port of Singapore". The frontend's plain-English filter (`frontend/src/lib/format.ts`
  `plain()`) now also rewrites "chokepoint by betweenness" and "3 or more hops".
* **Fixed: top bar overflowed below ~1000 px.** "Play the story" was pushed off-screen. It now wraps
  onto a second row.
* **FalkorDB bugs reduced to minimal repros.** `python -m scripts.repro_falkordb` (exits 1 while they
  still reproduce). Issue text: [docs/falkordb-bug-report.md](docs/falkordb-bug-report.md).
  `bench/NOTES.md` findings 2 and 8 were corrected: the earlier note "single hops still work" was wrong.

## Demo flow and the numbers you should see (northwind, Singapore Oct 20-24)

1. Open http://localhost:5173. What happened: **755 orders at risk, $114,065 exposure, 6 groups**; no graph yet,
   just the ask box and chips; the right panel lists the six agents, waiting.
   Click **Orders at risk from Singapore**: the sentence, then 5 stuck shipments ranked by late fees with their
   order groups (Aisha's order kept), "+3 more shipments" folded, then "How it was found".
2. **Run the agents** (requester = your name). The timeline fills step by step with real timings (~0.6-0.9 s in all):
   12 shipments hit, 755 / $114,065 / 6 groups, 8 routes, **Reroute 3 shipments by sea for $19,180**, **13 of 13 checks**.
   Recommendation: $19,180, $68,257 avoided, 406 orders back on time. Memory card: "checked; it did not change this decision".
3. **Compare with and without memory**: same plan either way (honest). Then use **Switch disruption (2)** and pick
   **LA / Long Beach labour action**: 1,474 orders, $681,534.
4. **Run the agents** again: Finance says **No rescue: inform affected customers**, tagged "Past experience changed this
   plan". Open the memory card: Suez (Jul 2026) → spent $96,000 expecting $148,000, avoided $41,000 → air freight delivered
   28% → at face value air-freighting 5 shipments saves $681,534 for $409,441 → counted at 28% it saves ~$188,785, so no rescue.
5. **Compare with and without memory**: without memory, **Air-freight 5 shipments, $409,441**; with memory, no rescue;
   **"Using past experience avoided an expected loss of $220,656."** All five "same input" checks are green.
6. Approve as the requester: **blocked** ("You can't approve your own request"). Approve as someone else: Comms runs.
7. Chip "Why is Aisha's order late?" (any time): a numbered chain, **3 days late**, traced back to Port of Singapore.
   "10 most loss-inducing orders": the 10 costliest, ranked, **$32,897** together, worst $4,692 (Atlanta).
8. Top-bar **engine switch** to PostgreSQL: the same sentence, the answer says "Answered by PostgreSQL"; **Compare
   engines** under any answer; **Benchmark** (FalkorDB flat ~30-50 ms, Postgres jumps at step 4); the Cypher under
   "How it was found" and in the memory card.
9. **Play the 30-second story** still works for either disruption.

**Before recording, run `python -m scripts.reset_demo`** (from `backend/`). Every run, including the one
the story starts, adds a run to memory and bumps the playbook counts ("Worked 6 of 6 times").
The reset puts memory back to the 3 seeded past disruptions without reloading the graphs.

## Gotchas

* **Run only one API process against a FalkorDB during the demo.** Clusters tag shipments with a shared
  `:Impacted` label under a per-process lock. Two API processes on the same graph (or `uvicorn --workers 2`)
  can interleave, and the landing then showed 741 orders instead of 755 for one load. The Docker image runs one
  process. The extra `api-globe` / `api-agents` / `api-timeline` entries in `.claude/launch.json` were only for
  parallel development; don't run them during the demo.
* **The API's `--reload` can hang on Windows.** After a backend edit it logged "Reloading..." but kept
  serving the old code. If a backend change does not show up, stop and start the API.
* **Gemini often returns 503** ("high demand"). The agents fall back to template wording, and the numbers
  are identical either way. The UI re-reads the run for ~16 s in case Gemini answers late.
* **Small screens:** answers fit the stage on their own (drag, wheel zoom, Re-centre still work). Below
  ~1180 px the right panel moves under the answer. The top-10 answer is small at 1280x800; record at 1920x1080.
* **Git identity on this laptop is a placeholder** (`Your Name <your.email@example.com>` in the global
  config). The first commit was made with an explicit author instead. Set your own:
  `git config --global user.name "..."` and `user.email`.
* `backend/.env` holds the Gemini key and is git-ignored. **Rotate that key** (it was pasted into a chat).

## Left to do (day 3, Oct 17, then day 4)

| Task | Done when | Notes |
|---|---|---|
| **Deploy** | Public URL in the README | FAQ: "A live deployment is preferred"; otherwise complete local setup + a working video (the README now has both). Packaging is done: on any VM with Docker, clone and `docker compose --profile app up -d --build`, open port 8080 (DB ports are localhost-only). ~2 GB RAM is plenty. Alternative: FalkorDB Cloud + the image on Render/Railway/Fly with `FALKOR_HOST/PORT/USERNAME/PASSWORD` (and `PG_DSN`, or the engine switch, Compare and Benchmark fail). Single origin, so no CORS change needed. |
| **README** | Video link + deployment URL filled in | Everything else done Oct 17. The rules checklist has a "link to come" for the video. |
| **Post the FalkorDB bug report** | Issue link in README and bench/NOTES.md | Searched Oct 17: post A as a new issue, B as a comment on PR #3264 (see the top of `docs/falkordb-bug-report.md`). Needs someone's GitHub account. |
| **Blog post** (AirPods side prize) | Posted, linked in README | Draft: `docs/blog-post.md`. Edit into the team's voice, add repo + video links, post (dev.to / Hashnode / Medium). |
| **Record the video** (day 4) | Uploaded | Shot list below. Reset memory first. |
| Optional: Q3 speed-up | Only if everything above is done | Tag only backbone shipments, est. ~360 ms to ~240 ms at 100k. Would only draw level with pgRouting. |

### Proposed video shot list (~3 minutes)

1. 10 s: the pitch over the console (Singapore: 755 orders, $114,065), say what each area is.
2. 30 s: ask "Orders at risk from Singapore", then Run the agents; let the timeline fill; read the recommendation; self-approval blocked.
3. 45 s: switch to LA / Long Beach, analyze, open the memory card (Suez → 28% → no rescue), then Compare with and
   without memory: $409,441 on air freight vs no rescue, **$220,656 expected loss avoided**. This is the Track 2 moment.
4. 20 s: "Why is Aisha's order late?" (the path through the graph), click a card.
5. 25 s: the engine switch: PostgreSQL vs FalkorDB on the same answer, How it was found, Compare engines, the benchmark. Say the honest
   result: FalkorDB wins the multi-step questions here; Postgres + pgRouting wins clusters.
6. 15 s: the FalkorDB Browser at http://localhost:3300: the run, its decisions, `USED_MEMORY` to the Suez playbook.
7. 10 s: close on the repo URL and team names. (Record at 1920x1080; run `scripts.reset_demo` first.)

## Before submitting

* Everyone joins team code **BBJWAC** (the page showed 1 of 4).
* Check the judging criteria and FAQ (existing-project rule, deployment, AI disclosure format).
* Every teammate can explain Q1 (cascade), Q3 (clusters), the agent handoffs and the memory model.
* Never commit `backend/.env`.

## Where things are

`backend/promisegraph/` product code (queries in `falkor_store.py` and `questions.py`, agents in `agents.py`,
memory in `memory.py`, API in `api.py`). `backend/scripts/` load, parity, bench, reset_demo, repro_falkordb.
`frontend/src/` React app (`App.tsx`, `components/`, `lib/format.ts` for wording). `docs/` contracts, graph model,
queries, task board, bug report. `bench/` results and the honest notes.
