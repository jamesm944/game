# Rust ECS parity on one reference scenario (#187)

Evidence for the Map 8 parity gate. Ticket: #187 (part of #182).
Contract: ADR-0012 §2 — parity means **semantic trace equality against
frozen TS fixtures plus Rust-internal digest equality across 1/2/4/8
workers**; float/byte hash equality with TS is explicitly not required.
This pass achieves the stronger result on the chosen scenario anyway:
bit-exact digest equality. Perf canon: ADR-0012 §3 /
`deep-sim-workloads-and-scaling.md` §8 (T2 5,000 Pops ≤ 33.3 ms p99
input-visible on Apple M1; T3 20,000 stretch ungated).

## Scenario

`tests/golden/m1t2` — the first deterministic-core TS fixture: seed
20260821, 10 entities with `mass` (arity 1) and `position` (arity 2)
float components, ping commands at ticks 5/30/31, 90 ticks, digests
recorded every 30 ticks. The scenario is defined by `case.json` plus
the harness in its `golden.test.ts` (spawn formulas, system order
ping → drift).

## Rust implementation (`sim/src/parity.rs`, CLI `sim/src/bin/parity.rs`)

Ported bit-exactly from TS: sfc32 PRNG seeded via splitmix32 with the
12-round warmup (`src/sim/core/prng.ts`), inbox drain semantics
(commands with `targetTick <= tick`, ordered by targetTick then
submission; `inbox.ts`), step order (tick increment → drain → systems
in registration order; `world.ts`), and the SPEC §7 digest byte layout
(alphabetical components × ascending eids, big-endian f64 bit
patterns, FNV-1a-64; `digest.ts`).

ECS: Shipyard 0.11 `World` with components `Mass`, `Position`,
`TickDraws`; one `"tick"` workload with barriers: ping → draw → apply.
Parallel mode pre-draws each entity's two PRNG values sequentially
(single ordered stream) into `TickDraws`, then applies deltas with
Shipyard `par_iter` inside a rayon pool of the requested size, so
digests are worker-count independent by construction — not by
post-hoc reduction.

Float parity holds because every float op in the scenario is an IEEE
add/mul or a division by 2³² performed in the same order as TS
(`(nextU32()/2^32 − 0.5) × 0.01`); no transcendentals are involved.

## Results (2026-11-07, Apple M1, release builds)

Fixture run (`m1t2-fixture.json` in `unity/evidence/parity-187/`):

| Run | Milestone digests match TS snapshot | Command arrivals |
|---|---|---|
| sequential | yes (30/60/90) | [5, 30, 31] |
| parallel, 1/2/4/8 workers | identical to sequential | [5, 30, 31] |

Expected digests `f831dd442da1ca60` (t30), `06535a22228d7441` (t60),
`f5e7ce65a95fe1e3` (t90) are reproduced exactly. Corroborated from the
TS side: `npx vitest run tests/golden/m1t2/golden.test.ts` passes
(4 tests), so the snapshot is current against the TS sim, not stale.
The Rust side is pinned permanently by cargo tests
(`m1t2_digest_parity_with_ts_snapshot`, `parallel_digest_equals_sequential`),
which read the fixture's `case.json` at test time. Full sim suite:
14 tests passing.

Worker spike (same scenario shape, entity count scaled, 300 ticks;
timings cover drain + workload, exclude milestone digesting):

| Scale | Sequential p50/p99 (ms/tick) | 1w | 2w | 4w | 8w (p50/p99) | Digests equal |
|---|---|---|---|---|---|---|
| T2 5,000 | 0.031 / 0.195 | 0.029/0.178 | 0.031/0.185 | 0.047/0.276 | 0.072/0.258 | yes |
| T3 20,000 | 0.131 / 0.593 | 0.119/0.527 | 0.128/0.585 | 0.154/0.638 | 0.171/0.682 | yes |

Raw reports: `spike-t2-5000.json`, `spike-t3-20000.json` in
`unity/evidence/parity-187/`.

Findings, stated plainly:

1. **Determinism holds across workers at both scales** — the gate's
   main claim. Final digests: T2 `78552521c0080409`,
   T3 `65eed042e5c1bfcb`, identical for sequential and 1/2/4/8 workers.
2. **Parallel apply does not pay at this workload weight.** The drift
   per entity is a handful of float ops; `par_iter` scheduling overhead
   exceeds the win, and the sequential PRNG pre-draw is the floor.
   More workers are measurably *slower* here (T3 p50 0.119 ms @1w →
   0.171 ms @8w). Parallelism will pay when per-entity systems are
   heavier (pathing, deep-sim), which is what the production sim's
   chunked map already exploits.
3. Absolute numbers are far inside canon (T2 p99 0.195 ms vs 33.3 ms
   budget), but this proves **tick machinery and determinism only** —
   two trivial systems, no pathing/economy/deep-sim. It does not
   evidence full-game tick cost.

## Deliberate divergences from TS (characterized, per ticket)

- **No divergence in the digested state, command timing, or arrivals**
  for m1t2. The list is empty for this scenario.
- Out-of-scope TS world machinery is not replicated in the harness:
  map layers, visibility/fog, path scheduler tick-holding, despawn,
  drain/submit observers, late-command errors, save/restore of the
  inbox. None of these affect m1t2 state evolution (verified by
  digest equality), but each needs its own parity treatment when its
  system migrates; the right moment is per-system golden fixtures
  (m2…m5 already exist on the TS side) rather than one mega-scenario.
- Cross-platform: replay bit-equality is per-platform (ADR-0012 §6).
  These runs are arm64 macOS; x86 float paths may diverge in later
  systems that use transcendentals — m1t2 uses none.

## Reproduce

```sh
cargo test --release --manifest-path sim/Cargo.toml parity
sim/target/release/parity tests/golden/m1t2/case.json \
  --snapshot tests/golden/m1t2/__snapshots__/golden.test.ts.snap
sim/target/release/parity tests/golden/m1t2/case.json \
  --entities 20000 --ticks 300
```

## Judgement needed (HITL)

Is this evidence trustworthy enough to build the deep sim on?
Recommendation: yes for the deterministic-core foundations (PRNG,
inbox, system order, digest, worker independence). Per-system parity
fixtures should follow each migrated system; they are not proven here.
