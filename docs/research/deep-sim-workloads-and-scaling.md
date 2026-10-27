# Deep-sim workloads, target populations and measured scaling

Wayfinder: **"Define representative deep-sim workloads and target populations"** (#164), feeding #159 (language and parallel architecture).

## Status

Partly answered. Measured here: the **economy plus deep-Pop** workload, scaling from 300 to 4,900 Pops on the current TypeScript sim. Defined but **not yet measured at scale**: combat/fog, logistics, politics, and input latency. Section 4 lists the gaps.

## 1. Measured: current TS sim, deep-Pop village, scaled

Probe: [`scratch/deep-sim-workloads/scaling.ts`](../../scratch/deep-sim-workloads/scaling.ts). It uses the M3 deep-sim village (identity + body + morale on every Pop, gather orders, houses/school/church/tavern, lifecycle and households live, delegation off), with resource nodes scaled to N/5. The full production system roster runs. There were 150 warmup ticks and 600 measured ticks, seed 20260902, with per-system wall time from wrapping each system. Raw output is in `scratch/deep-sim-workloads/results/*.jsonl`.

Apple M1, Node 22.16, **load average about 5 during the runs** (see Caveats).

| Pops | mean ms | p50 | p95 | p99 | max | mean µs/Pop | mirror copy ms | heap MB |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 305 | 2.50 | 1.50 | 7.6 | 10.8 | 16 | 8.2 | 0.10 | 72 |
| 1,005 | 7.67 | 5.34 | 18.9 | 36.1 | 58 | 7.6 | 0.29 | 40 |
| 2,005 | 17.7 | 11.2 | 71.9 | 106 | 219 | 8.8 | 0.27 | 37 |
| 3,005 | 29.6 | 18.5 | 147 | 177 | 265 | 9.9 | 0.91 | 134 |
| 4,905 | 62.8 | 32.8 | 397 | 469 | 805 | 12.8 | 1.37 | 72 |

Heap values are sampled after GC at arbitrary points and are not a memory-scaling measurement.

Mean cost per Pop by top system (ms per tick):

| System | 305 | 1,005 | 2,005 | 3,005 | 4,905 | growth 305→4,905 (Pops ×16) |
|---|---:|---:|---:|---:|---:|---:|
| movement | 1.60 | 4.56 | 9.62 | 15.6 | 29.8 | ×18.6 (about linear) |
| popbrain | 0.13 | 0.95 | 4.01 | 7.84 | 22.3 | **×171 (about n^1.85)** |
| gather | 0.14 | 0.43 | 0.69 | 1.08 | 1.85 | ×13 |
| mass / schedules / social / aiPlanner | 0.07–0.16 each | 0.19–0.35 | 0.41–0.62 | 0.69–0.90 | 1.1–1.5 | ×9–16 |

### Findings

1. **Single-thread TS holds 30 Hz (33.3 ms) on average to about 3,500 Pops, but not at p95.** Mean crosses 33 ms near 3,500 Pops. p95 crosses it between **1,000 and 2,000**, and p99 is already above it by 1,000. The product contract is 8 ms p95, and this probe's p95 exceeds it even at about 300 Pops under current load. See Caveats.
2. **PopBrain is superlinear (about n^1.85) and is the system the parallel design must fix first.** It is 0.13 ms of a 2.5 ms tick at 300 Pops, and 22.3 ms of 62.8 ms at 4,900. Movement is the largest absolute cost throughout, and scales about linearly.
3. **Tail spikes dominate.** p95 is 2–6× the mean above 2,000 Pops, and max reaches 805 ms at 4,900. The worst ticks matter more than the mean for input latency. The causes (rare-tick systems stacking, path storms) are not yet attributed.
4. **Hard population ceilings exist in the current code, below the 5k target:**
   - `NAME_LIST_SIZE = 2048` in [`pop.ts`](../../src/sim/components/pop.ts): a world throws `given-name list exhausted` once 2,048 named Pops have ever existed. Dead names stay retired, so births plus deaths exhaust it even faster.
   - The syllable generator cannot produce more than about 2,772 unique names for this seed (`given-name syllable space exhausted at 2772/40000`). Raising the constant alone does not fix it.
   - The probe's 3,000 and 4,900 runs used a **temporary, reverted** name-wrap patch to measure past those ceilings. Any 5k–20k plan needs a name scheme that allows repeats, or given name plus family or epithet.
5. **Mirror snapshot copy is not a bottleneck.** It is 1.4 ms at 4,905 Pops in this probe. This figure comes from the best of 5 copies, and the probe counted Pops, not rendered instances.

### Caveats

- Single run per size, apart from 300 and 1,000, which were run twice with matching results (mean 2.485/2.498 ms; 7.666/7.672 ms). The machine was loaded (load average about 5, Chrome and IDE open). The 305-Pop p95 here is 7.6 ms against 2.4–2.6 ms recorded on a quiet machine in `docs/m5-budget.md`, so **absolute p95 values are inflated about 3×, and growth ratios are more trustworthy than absolutes.** This matches the existing finding in `perf-baseline-2026-10.md`.
- Per-system timing adds two `performance.now()` calls per system per tick (about 29 systems). That overhead is small against ms-scale systems but not zero for sub-0.1 ms ones.
- Delegation, companies, combat and fog are off. Real mid-game load will be higher.
- The seed gives a single map. Pops were spawned in rings around the town centre, which flatters locality for movement.

## 2. Target populations (proposal)

ADR-0008 sets 1,000–5,000 Pops as the production ceiling and 5,000–20,000 as the stretch goal at 30 Hz. Measured data supports restating these as tiers:

| Tier | Named Pops | Total entities (incl. units, buildings, nodes) | Map | Purpose |
|---|---:|---:|---|---|
| T0 floor | 300 | about 1,000 | 128² | regression gate, equals the current M3/M4 gates |
| T1 target | 1,000 | about 3,000 | 192² | first parity point: Rust must beat the TS numbers above |
| T2 production ceiling | 5,000 | about 15,000 | 256² | ADR-0008 production target |
| T3 stretch | 20,000 | about 60,000 | 384² | marathon scenarios, parallel-only |

Entity multipliers are about 3× Pops, taken from the probe (which had 1,005 Pops and about 3,000 entities before combat).

## 3. Workload definitions (W1–W6)

Each workload runs at T0/T1/T2/T3 where feasible, under worker counts **1, 2, 4 and 8** (`RAYON_NUM_THREADS`, per ADR-0008), with identical command traces and a required identical final state hash across worker counts.

| ID | Workload | Mix at T2 (5,000 Pops) | Command trace | Primary stress |
|---|---|---|---|---|
| W1 | Economy + deep Pop (**measured above**) | 5,000 Pops: 70% gatherers, 20% household/idle, 10% craft/school; 1,000 nodes | gather orders in 10-unit chunks, 1 re-order wave per game-minute | PopBrain, movement, schedules |
| W2 | Combat + fog | W1 plus 1,500 military in two armies, 4 players, fog enabled | attack-move waves, 30 orders/s peak | combat, visibility, path storms |
| W3 | Logistics | W1 plus 300 haulers, 60 production buildings, 40 stockpiles, 3 trade routes | production queues, hauling reassignments | logistics scheduling, market |
| W4 | Politics + society | W1 plus 20 factions, tax/loyalty/religion ledgers, 12 council votes per game-day | policy changes, edicts | mood-ledger rollups, event ordering |
| W5 | Delegation + companies | W1 plus 5 companies, 20 branches, 40 foremen | charter/share/staffing commands | management and company thinks |
| W6 | Everything | W2+W3+W4+W5 together | scripted 30-minute trace | worst-case tick and tail |

**Metrics, per workload and tier:** mean/p50/p95/p99/max tick ms; per-system ms; peak and steady heap (RSS under native); tick-to-snapshot latency; **input latency** (command issued → effect visible in the next snapshot, measured at p95/p99); mirror/snapshot bytes per tick; final-hash equality across worker counts.

**Pass thresholds:** p95 ≤ 8 ms for T0 (existing contract); p95 ≤ 33 ms at T1 and T2 (frame budget); p99 ≤ 33 ms at T2 for the production claim; T3 is reported, not gated, until T2 passes.

## 4. Not yet done (why #164 is not closed)

- W2–W6 are defined, not run at scale. Only W1 is measured.
- Input latency was not measured.
- Donor architecture costs are cited from the donor inventory, not re-measured. Whether Rust and Rayon reach the ADR's "5k and 20k hot loop in under 8 ms on M2" target is untested. That target is the ADR-0008 Phase-0 spike, which has not been run.
- Quiet-machine re-run of W1 (Chrome and recorder closed, load below 2) to remove the load inflation.
- Attribution of the tail spikes (rare-tick stacking vs path storms vs GC).
- Memory and CPU scaling under 1/2/4/8 workers cannot be measured until a parallel implementation exists, which is the point of #159.

## 5. Consequences for #159 (informational, not a decision)

- The data supports a parallel or native sim for the 5,000-Pop target. The TS sim has already lost its p95 budget by 2,000 Pops, even allowing for load.
- Parallelising only movement would leave the superlinear PopBrain, which must be partitioned or tiered. A faster language alone would not fix an n^1.85 cost.
- Fix the name-pool ceiling before any scale work, in whichever language.
