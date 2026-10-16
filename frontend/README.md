# Frontend

Vite 6 + React 19 + TypeScript, `react-force-graph-3d` (three.js) for the 3D view, Inter (self-hosted
via `@fontsource-variable/inter`). Plain CSS, no UI kit. Built against `docs/ui-contract.md` (ask,
compare, sweep, chips, story) and `docs/api-contract.md` (agents and memory).

Every number on screen comes from the API. The UI formats and draws; it never computes a business
number, and it never shows internal words or ids (no hops, chokepoints, cluster or decision ids).

## Run

```bash
cd frontend
npm install          # versions pinned exactly in package.json / package-lock.json
npm run dev          # http://localhost:5173, proxies /api -> http://localhost:8000
npm run build        # type-check (tsc -b) + production build into dist/
```

Or use the preview launcher in `.claude/launch.json`: `api` (uvicorn :8000) and `web` (Vite :5173).
Node 22.11 on the team laptops, so this stays on Vite 6 (Vite 7/8 need Node 22.12+).

## The screen

* **Top bar:** product name, company (from `/api/health` `companies`), the engine switch
  (FalkorDB | PostgreSQL: which database answers every question), **Compare**, then Agents, Memory,
  Benchmark (open a drawer) and **Play the story**.
* **Stage:** the current answer's own small graph (never the whole graph), as a **2D diagram**
  (default) or in **3D**; both use one shared layout (`src/lib/layout.ts`):
  * Cards flow left to right along the links; orders with the same neighbours are bundled into one
    block of dots, and a "+ N more orders" group becomes that block's footer. Long single chains
    wrap onto a second line. Graphs with loops (lanes between ports) are radial, most important in
    the middle. Very crowded columns show compact shape markers (name on hover).
  * 2D: SVG cards (shape = `kind`, colour = `tone`, "kind · state" line), soft curved links,
    drag to pan, wheel to zoom, Re-centre.
  * 3D: the same layout lifted into space: fixed positions (no wobbling simulation), each block of
    orders orbits its shipment as a small cloud, the flow bends slightly like a panorama, a floor
    grid for depth, a gentle sway (never a full spin) that stops when you drag.
  * Click any node, dot or link for its `why` lines. The story works in both views.
* **Dock:** how the question was read, the one-sentence answer, engine + ms + query length,
  a collapsible **How it was found** (exact query, parameters, first results), suggestion chips and
  the prompt. A 422 shows "Try one of these" with the returned suggestions.
* **Compare:** `POST /compare`, both engines side by side: same-answer badge, both timings, both queries.
* **Benchmark:** `GET /sweep`, a two-line chart of the real timings at 2-8 steps, a slider, and the
  100k-order `bench` set when it exists. It draws exactly what comes back.
* **Agents / Memory:** runs, approve/reject (403 = "you can't approve your own request"), recall and
  learned habits. Both say they run on FalkorDB, also when the switch is on PostgreSQL (Rule 3).
* **Play the story:** ~30 s from `/story`: the port closes, the delay spreads by `step`, orders break
  (count up), the camera flies along `persona.path`, the agents run (`POST /runs`, requested by
  "Story") and memory recalls `run.recall[0]`. Skip any time (button or Esc); it always returns to
  the current answer.

The 3D view is a lazy chunk behind an error boundary, so the answer, prompt and tabs work without WebGL.

## Code map

```
src/api/types.ts        contract types (v1 runs/memory + v2 ask/compare/sweep/story)
src/api/client.ts       typed client; v2 calls fall back to src/fixtures/ only on a bare 404 route
src/components/         Stage, Graph3D, Dock, CompareSheet, Drawer (Agents, Memory), Benchmark, Story
src/lib/format.ts       formatting and plain-English wording (no business maths)
```

Fixtures in `src/fixtures/` (sample answer, compare, sweep, story, chips) were made from real data
before the v2 endpoints existed. They are only used if a v2 route returns FastAPI's bare 404.
