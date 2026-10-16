# Task board

Updated Oct 16 (day 2), evening. Full state and gotchas: [`HANDOFF.md`](../HANDOFF.md). Deadline: **Oct 18, 23:59 IST; submit by the evening, not at 23:50.**

## Done

* Day 1: data model, synthetic world, Q1-Q5, fair Postgres baseline, parity checks, benchmark, API.
* pgRouting baseline for clusters (Postgres + pgRouting wins Q3; README says so honestly).
* Day 2 backend: scenario 2 fixed (LA/Long Beach, Nov 20-24), second tenant (Lumen Home Co),
  agent memory in the graph, seeded history, the six agents with graph handoffs and a human approval
  gate, Gemini wording with a number guard, subgraph / path / evidence views, all contract endpoints,
  13 integration tests, a concurrency + tenant-isolation check.
* Frontend: 2D/3D stage, prompt box, engine switch, Compare, Agents, Memory, Benchmark, the story.
* pgRouting race for Q4 chokepoints and Q5 reroutes, with parity.
* Oct 16 evening: demo rehearsal passed twice in a row (API) and once fully in the UI; fixed lowercased
  shipment names, hub codes in agent/memory text and the top bar overflowing on narrow windows;
  FalkorDB bugs reduced to a minimal repro (`python -m scripts.repro_falkordb`) with the issue text in
  `docs/falkordb-bug-report.md`.

## Day 3 (Oct 17): put a name on each line at standup

| Owner | Task | Done when |
|---|---|---|
| done | ~~**Demo rehearsal on the real UI**~~ (Oct 16; run `python -m scripts.reset_demo` before recording) | Whole story runs twice in a row without a reload |
| ? | **Deploy**: FalkorDB Cloud or a small VM with Docker; API on Render or similar; frontend static. Check the FAQ: is a live deployment required? | Public URL, or written local-setup fallback |
| ? | **README final pass**: architecture diagram, screenshots, the honest benchmark table, rules checklist | A judge can run it from the README alone |
| ? | **FalkorDB bug report**: repro and text ready (`docs/falkordb-bug-report.md`), **post it** | Posted on FalkorDB GitHub/Discord, link in README |
| ? | **Blog post** (AirPods side prize): "what we learned racing FalkorDB against Postgres honestly" | Draft in docs/ |
| ? | Optional: speed up Q3 by tagging only backbone shipments (estimate: ~360 ms -> ~240 ms at 100k; would only draw level with pgRouting) | Only if everything above is done |

## Day 4 (Oct 18)
Record the video (shot list in [`HANDOFF.md`](../HANDOFF.md)), final README, submit by the evening.

## Before submitting
* Everyone joins team code BBJWAC (the page showed 1 of 4).
* Check the judging criteria and FAQ (existing-project rule, deployment, AI disclosure format).
* Rotate the Gemini key that was pasted into chat; never commit `backend/.env`.
* Every teammate can explain Q1 (cascade), Q3 (clusters), the agent handoffs and the memory model (Rule 12).
