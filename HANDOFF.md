# Handoff: Promise Graph (Graph Hacks, Track 2)

**Written Oct 16, 2026, evening of day 2; updated just after midnight (Oct 17) by Shyam.** Deadline: **Oct 18, 23:59 IST**.
Submit by the evening, not at 23:50. Everything marked "checked" was run on Kevin's laptop on Oct 16 or on
Shyam's on Oct 17 (fresh clone). If something was not run, it says so.

The product: a closed port breaks customer orders; Promise Graph shows which ones, why (a path through
the graph), which few shipments to rescue and what that costs. Six agents hand off through FalkorDB and
remember past disruptions. Postgres + pgRouting is only the benchmark baseline. Details: [README.md](README.md).

---

## Where it stands

| Part | State |
|---|---|
| Backend (FalkorDB, agents, memory, API) | Done. 19 integration tests pass, parity script passes (checked). |
| Frontend (2D/3D stage, prompt box, Compare, Agents, Memory, Benchmark, story) | Done. Type-checks and builds (checked). |
| Demo rehearsal | **Passed twice in a row** through the API and once fully in the UI (checked, details below). |
| FalkorDB bug report | Still reproduces (checked Oct 17). **Not posted.** B is already upstream (#2972, fix PR #3264): comment there. A is new: post it. Details at the top of `docs/falkordb-bug-report.md`. |
| Deploy | **Packaged, not hosted.** `docker compose --profile app up -d --build` runs everything on :8080 and loads the data on first start (checked from empty volumes). Hosting needs a VM with Docker (or FalkorDB Cloud + any container host): someone with an account. |
| README final pass | Done except the demo video link and a deployment URL: status, both ways to run (one command; step by step incl. the frontend), screenshots, architecture diagram, bug section, rules checklist. |
| Blog post | Draft in `docs/blog-post.md`, numbers checked against `bench/NOTES.md`. Needs the team's edit, then posting. |
| Demo video | Not recorded. Proposed shot list below. |

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

1. Open http://localhost:5173. The first answer: **755 orders late, $114,065 in late fees**, FalkorDB ~30 ms.
2. Flip the engine switch to PostgreSQL: same sentence, slower (~40-100 ms). **Compare** shows "Same answer".
3. Chip "Why is Aisha's order late?": a 5-step chain, **3 days late**, traced back to Port of Singapore.
4. **Play the story** (~30 s): port closes, the delay spreads (57 shipments), 755 count-up, camera
   flies to Aisha Rahman's order, agent lines, then the memory card (Suez, July 2026, air freight did not pay off).
5. **Agents** tab: type your name as requester, **Run the agents**. Expect 6 cards: 12 root
   shipments, 6 groups, Finance proposes **3 rescues by sea for $19,180, saving $68,257, 406 orders back on time**,
   Verifier passes 13 of 13 checks.
6. Approve as the requester: **blocked** ("You can't approve your own request").
7. Approve as someone else: Finance shows "Approved by ...", Comms drafts a message to Aisha.
8. **Memory** tab: Suez (did not pay off), Port Klang and Colombo (worked), and two learned habits.
9. **Benchmark** tab: the depth sweep chart (FalkorDB flat ~30 ms, Postgres jumps at step 4).

**Before recording, run `python -m scripts.reset_demo`** (from `backend/`). Every run, including the one
the story starts, adds a run to memory and bumps the playbook counts ("Worked 6 of 6 times").
The reset puts memory back to the 3 seeded past disruptions without reloading the graphs.

## Gotchas

* **The API's `--reload` can hang on Windows.** After a backend edit it logged "Reloading..." but kept
  serving the old code. If a backend change does not show up, stop and start the API.
* **Gemini often returns 503** ("high demand"). The agents fall back to template wording, and the numbers
  are identical either way. The UI re-reads the run for ~16 s in case Gemini answers late.
* **Narrow windows:** the 2D diagram does not fit the width at ~800 px; use drag, the scroll wheel or
  Re-centre. The Re-centre button sits partly under the story caption at that width. Record at full width.
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

1. 10 s: the one-line pitch over the first answer screen (755 orders, $114,065).
2. 30 s: the story, full screen, uncut.
3. 25 s: "Why is Aisha's order late?", click a card to show the "why" lines, open "How it was found" to show the Cypher.
4. 25 s: engine switch to PostgreSQL, then Compare (same answer, both queries). Say the honest result: FalkorDB wins the
   multi-step questions here; Postgres + pgRouting wins clusters.
5. 40 s: Agents: run, self-approval blocked, approve as a teammate, Comms message.
6. 20 s: Memory tab: the agents recalled Suez and avoided air freight.
7. 15 s: Benchmark sweep chart, then the FalkorDB Browser at http://localhost:3300 with the README's Cypher query.
8. 10 s: close on the repo URL and team names.

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
