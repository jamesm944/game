# Deep-sim workloads, target populations and measured scaling

Wayfinder: **"Define representative deep-sim workloads and target populations"** (#164), feeding #159 (language and parallel architecture, decided in ADR-0008).

## Status

Answered for everything the current TypeScript sim can measure. W1 (economy + deep Pop) and W2 (combat + fog) are measured at scale; the PopBrain and fog scaling laws are measured in isolation; the W1 tail is attributed; input latency, memory and snapshot size are measured. W3–W6 are fully specified in §8; parts of them cannot be measured yet because the systems they stress do not exist in `src/` (§6, §10 prove this rather than assume it). Worker-count scaling cannot be measured until a parallel implementation exists; §9 gives the evaluation protocol and an Amdahl bound from measured system shares.

Every number below cites its source: a probe in `scratch/deep-sim-workloads/`, a committed perf gate under `tests/perf/`, a budget record under `docs/`, or the sim source itself. Raw output for the completion runs: [`scratch/deep-sim-workloads/results/workloads-2026-10-30.md`](../../scratch/deep-sim-workloads/results/workloads-2026-10-30.md).

## Method and machine honesty

- Machine: Apple M1 (8 logical cores), Node v24.22.1 (partial runs: Node 22.16). **The machine was never quiet**: load average 5–15 during the completion runs (another agent plus user applications). `docs/research/perf-baseline-2026-10.md` already established that wall-clock p95 inflates 5–8× under such load and that no clean absolute is obtainable in this state. A quieter rerun was attempted by re-running everything and cross-checking against the recorded quiet numbers in `docs/m5-budget.md`; the load could not be reduced from inside this session.
- Mitigation: the completion probe ([`workloads.ts`](../../scratch/deep-sim-workloads/workloads.ts)) reports **process CPU time** (`process.cpuUsage`) alongside wall time, plus a fixed spin-kernel calibration per run (2M `sqrt`, 3.1–15.5 ms across runs — itself proof that cross-run wall percentiles are not comparable). **CPU means, within-run ratios and scaling exponents are the evidence; absolute wall p95s are upper bounds.** Quiet-machine anchors at 300 Pops exist and are cited where absolutes matter (`docs/m5-budget.md`, 5 runs per workload, 2026-08-25).
- All sim probes use the production roster via `createSkirmishWorld` (`src/game/session.ts` `wireSkirmishSystems`: 29 systems + fog flush), seed 20260902, synchronous path transport, map size 120 (the `size ?? 120` default in `createSkirmishWorld`). Per-system timing wraps each system with two `performance.now()` calls, as the original probe did.
- The sim ticks at 30 Hz (`SPEC.md` §2: fixed-timestep accumulator, 33.3 ms budget); the product perf contract is sim tick p95 ≤ 8 ms and mirror copy ≤ 2 ms @500 instances (`SPEC.md` §7 table; gates in `tests/perf/budget*.test.ts`).

## 1. W1 measured: economy + deep Pop, 300 → 4,900 Pops

Probe: [`scratch/deep-sim-workloads/scaling.ts`](../../scratch/deep-sim-workloads/scaling.ts) — the M3 deep-sim village (`tests/helpers/budget-scenario-m3.ts`: identity/body/morale on every Pop, compressed 600-tick day, houses/school/church/tavern, lifecycle + households live), resource nodes scaled to N/5, 150 warmup + 600 measured ticks. First recorded at load ≈5; re-run 2026-10-30 at load 11–13 with matching ratios (300: mean 3.77 ms; 1,000: 10.78; 2,000: 24.09; 3,000: 32.40 — absolutes worse, ordering identical).

| Pops | mean ms | p50 | p95 | p99 | max | mean µs/Pop | mirror (best-of-5) ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 305 | 2.50 | 1.50 | 7.6 | 10.8 | 16 | 8.2 | 0.10 |
| 1,005 | 7.67 | 5.34 | 18.9 | 36.1 | 58 | 7.6 | 0.29 |
| 2,005 | 17.7 | 11.2 | 71.9 | 106 | 219 | 8.8 | 0.27 |
| 3,005 | 29.6 | 18.5 | 147 | 177 | 265 | 9.9 | 0.91 |
| 4,905 | 62.8 | 32.8 | 397 | 469 | 805 | 12.8 | 1.37 |

Mean cost per top system (ms per tick):

| System | 305 | 1,005 | 2,005 | 3,005 | 4,905 | growth (Pops ×16) |
|---|---:|---:|---:|---:|---:|---:|
| movement | 1.60 | 4.56 | 9.62 | 15.6 | 29.8 | ×18.6 (about linear) |
| popbrain | 0.13 | 0.95 | 4.01 | 7.84 | 22.3 | **×171 (about n^1.85)** |
| gather | 0.14 | 0.43 | 0.69 | 1.08 | 1.85 | ×13 |
| mass / schedules / social / aiPlanner | 0.07–0.16 each | 0.19–0.35 | 0.41–0.62 | 0.69–0.90 | 1.1–1.5 | ×9–16 |

Findings (unchanged from the partial record, now corroborated by CPU-time runs in §2):

1. **Single-thread TS holds 30 Hz on average to about 3,500 Pops, but not at p95.** p95 crosses 33.3 ms between 1,000 and 2,000 Pops; p99 is already above it at 1,000. Against the 8 ms p95 product contract, even 300 Pops only passes on a quiet machine (2.6 ms recorded in `docs/m5-budget.md` vs 7.6–11.4 ms under the loads seen here).
2. **PopBrain is superlinear and movement is the largest absolute cost** — mechanism proven in §3.
3. **The former name-pool ceilings are fixed and verified at scale.** `allocateNameIndex` in `src/sim/components/pop.ts` continues past `NAME_LIST_SIZE = 2048` with overflow indices rendered as list name + roman generation. The 3,000-Pop completion rerun and the earlier 4,900 run pass through the fixed path with no probe-local patch; `tests/pop.test.ts` carries the regression.

## 2. Tail attribution (new)

Probe mode `tail` in `workloads.ts`: per-tick × per-system wall matrix plus per-tick CPU time, 600 measured ticks. Worst-30 ticks ranked by CPU (load-resistant). On the worst ticks CPU ≈ wall, so they are real sim work, not descheduling. The same tick numbers recur at 1,000 and 2,000 Pops, so the spikes are deterministic sim events, not GC.

Three causes, in size order at 2,000 Pops:

1. **Households day-boundary pass (tick 600, tick mod day = 0): 199 ms in one system in one tick** (54 ms at 1,000; 10.6 ms at 300). Source: `src/sim/systems/households.ts` runs only when `tick % dayTicks === 0`; family formation pairs all unassigned adults, and per new couple `pickHome → homesWithRoom` scans every entity while `occupancyOf` scans every household — O(couples × entities × households) on that single tick. Production cadence is once per `DAY_TICKS = 14,400` (`src/sim/systems/lifecycle.ts`), so this is a rare but enormous hitch, invisible to mean/p95 gates at 300 Pops. Any parallel design must phase or shard this pass; it is currently an unsharded global scan.
2. **Evening PopBrain storm (ticks 450–454 of the 600-tick compressed day, the 18:00 release + leisure-planning wave): popbrain 140–179 ms in single ticks at 2,000 Pops** (23–36 ms at 1,000). When schedules release workers, a large fraction of Pops become idle thinkers within a few ticks and each scores the full candidate set (§3). 18 of the worst 30 ticks at 2,000 Pops are popbrain-dominated.
3. **Movement path storms (ticks 187/233/279/325/371, ~46 ticks apart): movement 93–209 ms at 2,000 Pops** (44–96 ms at 1,000). These are repath/replan waves riding the schedule transitions. 17 of the worst 30 at 1,000 Pops are movement-dominated. The production movement system (`src/sim/systems/movement.ts`, integer A* via the path scheduler) is linear on average but stormy; the full-game movement benchmark (`docs/research/movement-architecture-full-game-benchmark.md`) independently measured 46k–91k repaths in 1,000–2,000-unit traces and individual-repath response p95 of 110.9–121.0 ms in browser runs.

Consequence: **the tail is event-shaped, not noise-shaped.** Rare-tick stacking (households), synchronized think waves (popbrain) and repath storms (movement) each need a different fix — sharding, candidate pruning/de-synchronization, and repath budgeting respectively. A worker-count speedup that leaves these synchronized will keep a bad p99.

## 3. Scaling laws, measured in isolation (new)

### PopBrain: cost ∝ thinkers × candidates (≈ quadratic in the village recipe)

Source: `src/sim/ai/popBrain.ts`. Each Pop thinks when `(tick + eid) % THINK_INTERVAL_TICKS (30) === 0`; `bestPickFor` then loops over **all** live resource nodes, all building sites and all production buildings (candidate tables rebuilt by scanning `world.entities`). With nodes scaled as N/5, per-tick scores ≈ (N/30) × (N/5) = N²/150.

Probe mode `brain` (flat 256² world, brain as the only system, the `tests/perf/popbrain-budget.test.ts` pattern scaled):

| Pops | Nodes | thinks/tick | scores/tick | wall mean ms | CPU mean ms |
|---:|---:|---:|---:|---:|---:|
| 300 | 60 | 10 | 600 | 0.10 | 0.21 |
| 1,000 | 200 | 33 | 6,667 | 0.26 | 0.24 |
| 2,000 | 400 | 67 | 26,667 | 0.81 | 0.74 |
| 5,000 | 1,000 | 167 | 166,667 | 4.65 | 4.14 |
| 5,000 | 60 (control) | 167 | 10,000 | 0.69 | 0.68 |

The control row separates the variables: at fixed candidates, 16.7× Pops costs ~7×; at fixed Pops, 16.7× candidates costs ~6×. Cost per score ≈ 28 ns. The village probe reads higher (22.3 ms at 4,905) because sites, production buildings and leisure candidates join the scan and candidate-table construction iterates ~15k entities. **SPEC §2.3's "≈60k mults/tick @300 Pops" estimate assumed ~20 fixed actions per think; the implementation scores every node in the world.** Parallelism alone divides this by worker count but leaves the exponent; the fix is spatial candidate pruning (score nearby nodes only) or an advertised-jobs index, in any language.

### Fog: linear in dirty contributors; the committed perf gate under-measures it ~16–22×

Source: `src/sim/systems/fog.ts`. `flushDirty` (called once per `step()` in `src/sim/core/world.ts`) un-stamps + re-stamps a LUT sight circle per dirty entity whose tile/radius/owner changed, then runs `updateKnowledgePass` over **all** stamped buildings × players every flush. Circle area for radii 5–10 is ~81–317 tiles.

Probe mode `fog` (every contributor moves one tile every tick — the worst case), with a resolver that returns a fresh record per call like production `createRowEntityResolver`:

| Contributors | Map | wall mean ms | CPU mean ms | recomputeAll ms |
|---:|---|---:|---:|---:|
| 300 | 120² | 0.88 | 0.66 | 1.4 |
| 1,000 | 120² | 3.00 | 2.10 | 4.6 |
| 2,000 | 192² | 5.23 | 4.09 | 5.3 |
| 5,000 | 256² | 16.2 | 11.5 | 11.4 |
| 20,000 | 384² | 50.4 | 42.8 | 53.2 |

≈2.1–3.2 µs per moved contributor, linear, essentially independent of map size (planes cache effects aside). **Flaw found:** `tests/perf/fog.test.ts` binds `resolve: (eid) => entities[eid - 1]`, returning the same mutated object that `stampRecord` stored; `sameStamp(previous, current)` then compares the object to itself and every re-stamp is skipped. The gate therefore measures queue dedupe only (control run: wall mean 0.04 ms at 300 vs 0.88 ms honest). The SPEC §2.9 "300 contributors < 1 ms" claim is unproven by that gate; honestly measured it is ~0.7–0.9 ms at 300 — still passing, with far less margin. In-game, the fog flush measured only 0.12–0.40 ms (§4) because most units do not cross a tile boundary every tick and same-tile moves skip. The honest planning number is **µs per tile-crossing mover**, and the per-flush building-knowledge pass is an unmeasured O(buildings × players) tax that W2 at T2/T3 must include.

### Movement

Linear on average in every probe (×18.6 for ×16 Pops, §1; 55–65% of tick CPU in W2, §4), stormy in the tail (§2). It is the system that benefits most from sharding by entity, and the one whose response-side behaviour already breached 33.3 ms in the browser full-game trace (movement benchmark doc, 39.4 ms p95 for eight concurrent leader requests).

## 4. W2 measured: combat + fog at scale (new)

Probe mode `combat` in `workloads.ts` — the M2 recipe (`tests/helpers/budget-scenario-m2.ts`: 300 villagers gathering, two knight armies attack-moving each other's centroid every 45 ticks, real fog, AI planner live) with army and villager counts as parameters. 120 warmup + 300 measured ticks, 120² map.

| Villagers | Knights/side | wall mean/p95 ms | CPU mean/p95 ms | movement | aiPlanner | combat | fog flush | survivors |
|---:|---:|---|---:|---:|---:|---:|---:|---|
| 300 | 100 | 4.5 / 10.7 | 5.5 / 14.1 | 2.58 | 0.76 | 0.48 | 0.12 | 87/85 |
| 300 | 300 | 12.2 / 23.0 | 11.4 / 24.2 | 6.39 | 2.75 | 1.51 | 0.34 | 251/249 |
| 1,000 | 300 | 22.5 / 54.4 | 22.3 / 55.5 | 14.44 | 3.23 | 1.75 | 0.40 | 265/256 |

Quiet anchor: the M2 gate workload (300v + 100/side) records p95 6.998–7.631 ms in `docs/m5-budget.md` — already ~91% of the 8 ms contract at T0 scale, the tightest of the four §7 workloads. Completion-run absolutes are load-inflated; shares and ratios are the signal:

- **Combat itself is cheap (8–13% of tick).** Melee cost arrives as movement (approach, separation, repath churn) — tripling the armies at fixed villagers roughly doubles total CPU, and movement takes most of the increase.
- **The AI planner is the second-largest system under combat** (0.76 → 3.23 ms). It is a single sequential planner per AI player today; in a 4-player game this line multiplies unless planners are sharded or budgeted. #159's phase design must place it explicitly — ADR-0008's phase list does not name it.
- Fog flush in-game is small (see §3 for why, and for the worst-case bound).

## 5. Input latency, memory, snapshot size (new)

**Input latency** (probe mode `latency`): a fresh idle Pop is spawned beside the measured village, ordered to gather with `targetTick = tick + 1` (the only legal form — `src/sim/core/inbox.ts` throws on late commands), and two events are timed: the `AssignedNode` row appearing (command applied) and the unit first moving in a mirror snapshot (effect visible). 19 of 20 probes completed at each of 300/1,000/2,000 Pops; **applied = visible = exactly 1 tick at every percentile and every scale** with the synchronous path transport. The structural floor is therefore:

- 1 tick = 33.3 ms of game time at 30 Hz, plus mirror copy (p50 0.11 ms @310 units, 0.20 ms @1,010, 1.32 ms @2,010 — `tail` probe, medians under load; best-of-7 quiet values are 0.010–0.077 ms in `docs/m5-budget.md`), plus one render frame.
- Production adds two terms this headless probe cannot see: the async path worker (a late response holds the whole tick — `step()` in `src/sim/core/world.ts` returns without draining commands; browser full-game traces measured repath response p95 110.9–121.0 ms), and tick overrun (when tick CPU > 33.3 ms the accumulator falls behind and the SPEC's max-steps cap drops game time, so a 1-tick latency costs p95-tick wall time — ~96 ms CPU at 2,000 Pops per §2).
- **Latency gate recommendation:** report ticks-to-applied and ticks-to-visible (must stay 1/1 under the sync transport at every tier) and wall p95 = p95(tick) + p50(mirror); gate wall p95 ≤ 66 ms (two frames) at T1/T2. Browser round-trip with the real worker remains unmeasured here (§10).

**Memory** (post-GC heap, `--expose-gc`): 22.7 MB @305 Pops, 23.8 MB @1,005, 27.0 MB @2,005 in the village probe; brain-only baseline 18.2 MB @300. Marginal cost ≈ **3–4 KB per deep Pop** in the TS object-row layout — but the baseline dominates and Node RSS (~450–500 MB) is runtime+tsx overhead, not sim state. Extrapolation (labelled as such): 5,000 Pops ≈ +16 MB over baseline; 20,000 ≈ +70 MB. Fog planes are exact: players × size² × 4 B (explored u8 + visible u8 + contributor u16, `createFogState`) = 0.5 MB at 256²/2p, 1.2 MB at 384²/2p, ×2 at 4 players. Native RSS under Rust/shipyard is a Phase-0 spike measurement, not derivable from TS heap.

**Snapshot size** (`captureSimSnapshot`, `src/sim/mirror.ts`): logical payload is exactly 23 B per unit (eid i32 + 2×pos f32 + heading f32 + hp f32 + def/activity/owner u8). Measured: 7,130 B @310 units; 23,230 @1,010; 46,230 @2,010; 35,213 @1,531 (combat). At 30 Hz that is 1.4 MB/s at 2,000 units and 13.8 MB/s at 20,000 before FlatBuffers framing — ADR-0008's "<0.2 ms localhost round-trip" claim should be re-checked against the T3 rate in the spike (§9). Mirror copy is never the bottleneck in TS (≤1.4 ms best-of-5 at 4,905 Pops, §1).

## 6. What W3–W5 can and cannot measure today

Verified against the production roster (`wireSkirmishSystems`, 29 systems) and `src/data/definitions/buildings/*.json`:

- **W3 logistics — partially present.** Gathering/hauling to stockpiles exists (gather system + carry loop); production exists but only **two** building definitions have `workSlots: 1` (kitchen, forge); market exchange + trade carts exist (`src/sim/systems/market.ts`: `marketExchange`, `tradeRoute`, gold = max(5, ⌊distance/2⌋))). There is no dedicated hauler/stockpile-job system (the RimWorld PickUpAndHaul donor named in SPEC §2 is a pattern, not code here). W1 already exercises the gather-haul loop at scale; a production-saturation variant is specifiable (§8) but its ceiling is set by two 1-slot building types, so a TS measurement would mostly re-measure PopBrain's production-candidate scan. It is specified for the Rust spike instead.
- **W4 politics — not present as named systems.** No faction, tax, council-vote or edict system exists in `src/` (the only "tax" hit is a comment clarifying the company tithe is *not* one, `src/sim/systems/companies.ts`). The political-adjacent load that exists — mass, social, morale, culture, households — is already inside W1 and measured: at 2,005 Pops they total ~2.2 ms mean of 17.7 ms (~12%), with households owning the worst single-tick spike (§2). W4 in §8 is therefore a specification against the ADR-0008 Phase-1 systems (mood ledgers, taxation, social class — issues #146/#151/#153), with today's 12% share as the floor, not the target.
- **W5 delegation + companies — present and measured at T0.** The M4 gate (`tests/helpers/budget-scenario-m4.ts`: M3 village + chartered company, 50% tithe, 1 Hz expansion thinks, seated foremen) records quiet p95 2.036–2.114 ms (mean ~1.30 ms) at 305 Pops in `docs/m5-budget.md`; the completion rerun under load read mean 3.05 ms / p95 7.27 ms with liveness intact (1 company, 2 branches, 2 foremen, treasury flowing). Management + companies think at the same staggered 1 Hz cadence as PopBrain (`FOREMAN_THINK_INTERVAL_TICKS = 30`, `src/sim/systems/management.ts`); their per-think scans are over buildings/branches, not Pops, so W5 scales with workplace count — the §8 mix fixes that ratio explicitly. A scaled TS run was not built: the M4 harness has no population parameter, and parameterizing it is build work, not research; §8 specifies it.
- **W6 everything** is by construction unmeasurable until W3/W4 systems exist. Its TS-era proxy (W1 + W2 combined in one world) is bounded in §8 by summing measured shares; the real W6 is a Rust-spike deliverable.

Donor architecture costs (cited, not re-measured — no donor binary was run for this ticket): the tiering pattern the TS sim already follows comes from RimWorld's tickerType (Normal / Rare 250 / Long 2000) and DFHack job-cooldown anti-thrash, surveyed in `docs/research/pop-sim-sources.md` and costed qualitatively (Low/Medium, "must execute on staggered Rare Tick") in `docs/research/df-rimworld-donor-inventory.md`. Those docs contain no measured donor tick times, and none are invented here. The one hard donor-side number in the repo is target-side: ADR-0008's Phase-0 spike goal of "<8 ms wall for the full hot loop at 5k and 20k entities on M2" — still unrun.

## 7. Target populations (recommendation)

ADR-0008 sets 1,000–5,000 Pops as the production ceiling and 5,000–20,000 as stretch at 30 Hz; SPEC's current envelope is 300–500. Measured data supports the ADR's tiers, restated with the mixes §8 needs:

| Tier | Named Pops | Total entities | Map | Players | Purpose |
|---|---:|---:|---|---:|---|
| T0 floor | 300 | ~1,000 | 120² | 2 | regression gate = today's M1–M4 §7 workloads |
| T1 target | 1,000 | ~3,000 | 192² | 2–4 | first parity point: Rust must beat TS CPU means here |
| T2 production ceiling | 5,000 | ~15,000 | 256² | 4 | ADR-0008 production claim |
| T3 stretch | 20,000 | ~60,000 | 384² | 4 | marathon scenarios, parallel-only, reported not gated |

Basis and caveats:

- Entity multiplier ≈3× Pops is measured (village probe: 1,005 Pops → ~3,000 entities including nodes/buildings, before combat units).
- **Only 120² / 2-player is implemented and measured.** `createSkirmishWorld` accepts a `size` option and a 4-player layer generator exists (`generateFourPlayerLayers`), but no budget scenario runs them. Map-size costs that are derivable are small (fog planes §5; fog flush size-independent §3); path length grows with map size and is *not* measured — the T1+ map sizes are spike parameters, not validated settings.
- TS reference points the spike must beat (CPU means, sync transport, loaded machine — conservative): W1 1,000 Pops ≈ 10.9 ms CPU/tick, 2,000 ≈ 29.8 ms; W2 1,000v+600k ≈ 22.3 ms. Quiet-machine TS would read lower; the spike should re-record TS numbers on its own quiet machine before claiming a ratio.

## 8. Workload definitions W1–W6 (complete specification)

Common protocol for every workload: tiers T0–T3 (§7) where feasible; worker counts **1 / 2 / 4 / 8** (`RAYON_NUM_THREADS` per ADR-0008 §5, which already requires replay-identical golden fixtures at all four); identical seed + command trace per (workload, tier); ≥150 warmup ticks; ≥600 measured ticks that **must include** one day boundary and one evening transition (the tail lives there, §2 — a steady-state-only window is invalid); final state digest compared across worker counts (must be identical); machine load, CPU model, Node/cargo versions recorded per run.

Metrics per (workload, tier, workers): tick wall + CPU mean/p50/p95/p99/max; per-system mean ms; worst-30-tick dominant-system histogram; heap/RSS (post-GC / native peak); snapshot logical bytes/tick and copy ms; input latency ticks-to-applied / ticks-to-visible + wall p95 (§5); commands applied/tick; digest equality across worker counts.

Pass thresholds: T0 p95 ≤ 8 ms (existing SPEC §7 contract); T1 and T2 p95 ≤ 33.3 ms with a production claim requiring p99 ≤ 33.3 ms at T2; worst single tick ≤ 100 ms at T2 (kills the households-class hitch); latency wall p95 ≤ 66 ms at T1/T2; T3 reported, not gated.

| ID | Workload | Entity mix (at T2 = 5,000 Pops; scale linearly unless noted) | Command trace | Status |
|---|---|---|---|---|
| W1 | Economy + deep Pop | 5,000 named Pops (identity/body/morale): 70% gatherers, 20% household/idle, 10% school/craft; 1,000 resource nodes (N/5); ~830 houses (N/6) + school/church/tavern per town; lifecycle + households on; compressed clock for TS parity, canonical 14,400-tick day also reported | gather orders in chunks of 10; 1 re-task wave per game-minute; no combat | **Measured** §1–§3 (TS, 300–4,905) |
| W2 | Combat + fog | W1 **replaced** by: 1,000 plain villagers gathering + 750 military/side ×2 (T2 army ratio from §4's 300/side point scaled ×2.5); fog on, 4 players at T2 (2 at T0/T1); ~1.5 sight contributors per military+villager | attack-move waves re-issued every 45 ticks at opposing centroid; peak 30 orders/s; villager gather continuous | **Measured** §4 (TS to 1,000v+300/side; T2 mix is extrapolation) |
| W3 | Logistics + production | W1 plus: production buildings at 1 per 25 Pops (200 at T2, workSlots ≥1), 40 stockpiles/drop-offs, 300 dedicated haulers (6% of Pops), 3 trade routes × 10 carts, market exchange enabled | production queues kept full; hauler reassignments every 60 ticks; 1 market exchange per game-minute; carts on fixed routes | Specified; TS has 2 production building types + carts (§6) — run in spike |
| W4 | Politics + society | W1 plus: households at full formation, mass/social/morale/culture on (already in W1); **new for spike:** 20 factions, per-Pop mood-ledger + tax/loyalty/religion rows (ADR-0008 Phase-1), 12 council votes per game-day | 1 policy/edict change per game-day; votes on schedule; festival command weekly | Specified; political systems do not exist in TS (§6) — floor = W1's ~12% society share |
| W5 | Delegation + companies | W1 plus: companies at 1 per 1,000 Pops (5 at T2), branches 4/company, foremen 8/branch-equivalent workplaces, 50% tithe, expansion thinks at 1 Hz always-ask | charter at t0; share/staffing/expansion commands at the M4 cadence scaled by company count | Measured at T0 only (M4 gate, §6); scale-out specified |
| W6 | Everything | W2 ∪ W3 ∪ W4 ∪ W5 simultaneously on T2 map/players | concatenated traces, 30 game-minutes scripted, including one day boundary + one battle wave + one vote in the same 600-tick window | Specified; TS proxy bound below |

TS-era W6 bound (arithmetic on measured shares, not a run): W1 @2,000 Pops CPU mean 29.8 ms (§2) + combat increment from W2 (300v+300/side minus 300v baseline ≈ +8 ms CPU, §4, movement-heavy and non-additive where movement saturates) ⇒ a combined 2,000-Pop world with 600 military reads roughly **35–40 ms CPU mean and ≥150 ms p99** in TS. Treat as an order-of-magnitude bound for spike planning only.

## 9. Worker-count evaluation: protocol and bound

No parallel sim exists to measure (ADR-0004 single-threaded tick is still the implementation; ADR-0008 supersedes it on paper). Two deliverables instead:

**Protocol for the Phase-0 spike** (extends ADR-0008 §6): implement W1's movement + PopBrain kernels and W2's fog flush in shipyard/Rayon; run §8's protocol at 1/2/4/8 workers on T1/T2/T3 entity counts; report speedup vs worker count per system (not just total), phase-barrier wait time, and digest equality. Include the households day-boundary pass and one evening think-wave in the measured window (§2) — a spike that only measures steady state will over-claim by the size of the tail. Re-check ADR-0008's "<0.2 ms socket round-trip" at T3 snapshot rates (§5: 13.8 MB/s logical at 20k units).

**Amdahl bound from measured TS shares** (W1 @2,005 Pops, §1): movement 54% + popbrain 23% + gather 4% are entity-shardable in ADR-0008's phase model ≈ 81% parallel fraction; the remainder (inbox drain, households global pass, aiPlanner, snapshot, knowledge pass) is serial or global as written. Perfect sharding of the 81% caps total speedup at 1/(0.19 + 0.81/W): **2 workers → 1.7×, 4 → 2.6×, 8 → 3.4×**, before synchronization cost. Combined with a native-language constant factor this is still the right order for T2 — but it says worker count alone never rescues T3, and it makes the serial 19% (especially the unsharded households pass and the single AI planner) first-order design items, not afterthoughts. This is a bound from TS shares, not a Rust prediction: Rust shares will differ.

## 10. Gaps (explicit)

1. **No quiet-machine absolutes.** Load stayed 5–15; CPU-time and quiet anchors from `docs/m5-budget.md` substitute. Spike protocol requires load < 2 and a calibration-kernel reading per run.
2. **No worker-count measurement** — impossible until a parallel implementation exists; bounded in §9.
3. **W3 production saturation, W4 politics, W6 combined**: systems absent or too thin in TS (proven in §6); specified in §8 for the spike.
4. **W5 beyond T0**: M4 harness has no scale parameter; specified in §8.
5. **Maps >120² and >2 players**: accepted by `createSkirmishWorld` options but never budget-run; path-length scaling unmeasured. T1+ map sizes in §7 are parameters to validate.
6. **Browser input latency with the real async path worker**: headless sync transport gives the 1-tick floor (§5); production adds worker queueing already measured at 110.9–121.0 ms repath p95 in the movement benchmark's browser traces. A browser round-trip probe is still owed.
7. **Fog building-knowledge pass** (`updateKnowledgePass` over all stamped buildings × players per flush): unmeasured; W2 at T2 with hundreds of buildings must include it. The committed fog gate's resolver aliasing flaw (§3) should be fixed in the same pass — it currently proves queue overhead, not stamping.
8. **Donor binary costs**: none measured; repo donor docs are qualitative (§6). DF/RimWorld comparisons in #159 must not cite numbers from this file as donor measurements.
9. **GPU/renderer frame cost, save/load and digest cost at scale**: out of scope for #164's sim workloads; mirror/snapshot bytes are covered (§5), rendering is ADR-0009's problem.
10. **Single seed, single map, ring-spawned Pops** in all TS probes (inherited from the budget scenarios): flatters movement locality. §8 requires the spike to add one dispersed-spawn variant before T2 claims.

## 11. Consequences for #159 (informational)

- The measured exponent, not the constant, is the argument: PopBrain's thinkers×candidates scan (§3) and the households global pass (§2) defeat any pure language/port speedup at T2+. Both need algorithmic fixes (spatial candidate pruning; sharded/incremental household formation) in whichever core #159/ADR-0008 builds. Movement is linear but stormy and is the largest shardable win.
- ADR-0008's phase list should gain an explicit home for the AI planner (second-largest system under combat, §4) and for day-boundary/rare global passes; today both are serial by construction.
- The fog gate flaw (§3) means SPEC §2.9's fog budget has never actually been verified as written; honest measurement still passes at 300 contributors but with ~10× less margin than the gate suggests. Fix the gate before porting fog.
- Snapshot bandwidth at T3 (13.8 MB/s logical, §5) and the 1-tick latency floor are the bridge constraints to carry into the FlatBuffers spike; tick compute is not the only scaling axis.

## Sources

- Probes: `scratch/deep-sim-workloads/scaling.ts`, `scratch/deep-sim-workloads/workloads.ts`, results in `scratch/deep-sim-workloads/results/` (incl. `workloads-2026-10-30.md`).
- Gates/harnesses: `tests/perf/budget.test.ts`, `budget-m2/m3/m4.test.ts`, `fog.test.ts`, `popbrain-budget.test.ts`, `mirror.test.ts`; `tests/helpers/budget-scenario{,-m2,-m3,-m4}.ts`; `tools/perf-record.ts`. Completion run: 16/16 perf tests pass at raw local thresholds. Load varied minute-to-minute (5–15): the serial vitest run passed while a `perf-record` run minutes later read M2 p95 at 17.5 ms — exactly the instrument instability `docs/research/perf-baseline-2026-10.md` documents, and why this file leans on CPU means and the recorded quiet anchors.
- Records: `docs/m5-budget.md` (quiet anchors), `docs/research/perf-baseline-2026-10.md` (load methodology), `docs/research/movement-architecture-full-game-benchmark.md` (repaths, browser latency), `docs/research/pop-sim-sources.md`, `docs/research/df-rimworld-donor-inventory.md` (donor patterns, qualitative costs).
- Sim source: `src/game/session.ts` (roster, map default), `src/sim/ai/popBrain.ts` (think scan), `src/sim/systems/households.ts` (day-boundary pass), `src/sim/systems/fog.ts` (flush, resolver, planes), `src/sim/systems/movement.ts`, `src/sim/systems/market.ts`, `src/sim/systems/management.ts` (1 Hz cadence), `src/sim/systems/lifecycle.ts` (`DAY_TICKS`), `src/sim/core/world.ts` (`step`), `src/sim/core/inbox.ts` (late-command rule), `src/sim/mirror.ts` (snapshot layout), `src/sim/components/pop.ts` (name overflow), `src/data/definitions/buildings/*.json` (workSlots).
- Decisions: `SPEC.md` §2/§7, `docs/adr/0008-rust-native-sim-core-and-renderer-bridge.md`, issues #159 and #164.
