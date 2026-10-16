# Handoff: Promise Graph (Graph Hacks, Track 2)

**Written Oct 16, 2026, evening of day 2.** Deadline: **Oct 18, 23:59 IST**. Submit by the evening, not at 23:50.
Everything marked "checked" below was run on Kevin's laptop on Oct 16. If something was not run, it says so.

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
| FalkorDB bug report | Minimal repro + issue text ready. **Not posted.** |
| Deploy | Not started. Needs accounts (FalkorDB Cloud or a VM, plus a host for the API). |
| README final pass | Not done. Its "Status" section is stale (still says the frontend is in progress). |
| Blog post | Not started. |
| Demo video | Not recorded. Proposed shot list below. |

## Get it running (Windows, about 5 minutes)

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
| **Deploy** | Public URL, or a written local-setup fallback | Check the FAQ first: is a live deployment required? Frontend is static (`npm run build`, `frontend/dist`); the API needs FalkorDB reachable (`FALKOR_HOST`/`FALKOR_PORT` env vars, `PG_DSN` for the race/compare endpoints). CORS only allows `http://localhost:5173` (`backend/promisegraph/api.py`), so add the deployed origin. |
| **README final pass** | A judge can run it from the README alone | Update the stale Status section, add an architecture diagram and screenshots, a rules checklist, and link the posted bug report. |
| **Post the FalkorDB bug report** | Issue link in README and bench/NOTES.md | Search existing issues first. Text is ready in `docs/falkordb-bug-report.md`. |
| **Blog post** (AirPods side prize) | Draft in `docs/` | "What we learned racing FalkorDB against Postgres honestly". Material: `bench/NOTES.md` (findings 1-9 and the honest summary). |
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
