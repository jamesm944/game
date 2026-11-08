# Renderer-paced batch-only 32 versus FIFO

Wayfinder: **"Does batch-only 32 survive renderer-paced production workloads?"** (#172)

## Decision

**Do not adopt batch-only 32. Versioned FIFO stays the production control; current integer A\* stays the pathfinder.**

Batch 32 cut request messages by about 95% in both workloads, and it kept replay exactness. But repath-response p50 got worse in **10 of 10** paired Chrome comparisons. Wall-time and tail-latency gains were small and inconsistent. The clean snapshot-handle/provider seam is unaffected and stays advanced.

## Evidence

Real headless Chrome 156 (Apple M1, SwiftShader WebGL), real rAF pacing at 60 Hz driving 30 Hz fixed steps, production rendering modules, 1,000 units, 3,600 ticks. Five AB/BA paired iterations per policy, per workload.

| Workload | Repath p50 FIFO → B32 | Repath p95 FIFO → B32 | Wall mean FIFO → B32 | Blocked frames FIFO → B32 |
|---|---:|---:|---:|---:|
| Narrow + mutation | 4.1 → 5.8 ms (+41%) | 42.6 → 49.7 ms | 120.801 → 120.709 s | 117 → 103 |
| Dense | 4.4 → 5.9 ms (+34%) | 41.9 → 42.1 ms | 121.345 → 121.156 s | 163 → 135 |

- Repath p50 delta, batch minus FIFO, per iteration: narrow +0.8/+1.5/+3.6/+1.4/+2.2 ms; dense +1.9/+1.6/+1.1/+1.5/+1.5 ms. Never negative.
- Dense repath p95 delta per iteration: −10.2/+12.4/−0.1/+10.5/−2.2 ms. This is a wash.
- Dense leader response p95 got worse pooled: 10.9 → 13.7 ms. Narrow pooled leader p95 is 9.3 → 158 ms, but it comes from one outlier among n=20, so ignore it.
- Wall time moved by about 0.08–0.16%. This is within run variance, and one narrow pair reversed by +427 ms.
- Batching gave real worker-queue relief (dense repath queue p95 36.7 → 22.0 ms). The cost was added microtask-flush/delivery latency on the median request. Net benefit to the player is nil.
- Replay: 20/20 Chrome runs match the Node A\* oracle on final state hash, outcomes and the exact two-tick issue→apply contract. Narrow adds 10/10 logical-projection equality. Only the raw `ok` flag on one pending request differs, which is response-arrival telemetry, not simulation state.

## Why this earlier result reversed

The #171 trace showed batch-32 winning p95 and blocked frames in 4/4 iterations against FIFO. Under renderer-paced load the tail advantage shrinks to noise, while the median penalty stays. Earlier p95 wins were partly an artefact of an unpaced harness.

## Limits

- Narrow workload recorded **zero combat-damage events**, so combat-heavy behaviour is not covered.
- Dense used an adapted production-components session, not the unmodified `src/main.ts`. UI, audio, post-processing and fog culling are omitted, and render capacity is 1,200 instead of 512.
- One host. Headless Chrome arm64 only. No hardware GPU, Firefox, WebKit or x64.
- Request deduplication was not tested. Repath group keys are unique, so coalescing was 0 eligible.

## Consequences

- Stop optimising worker transport. Queueing was the only real target, and the remaining win is below what players can perceive.
- Ship the snapshot-handle/provider design with plain FIFO, if the A\* worker path is ever productionised.
- Move on to #173 (does corrected Recast beat A\* at full scale?), then to the non-navigation roadmap items (#163, #164, #165). The navigation research thread has reached diminishing returns.

## Raw evidence

- [Dense report](../../scratch/navigation-renderer-paced/dense/report.md). It is stale and predates the 5-sample matrix; use the figures above and `results/analysis.json`.
- [Dense analysis](../../scratch/navigation-renderer-paced/dense/results/analysis.json)
- [Narrow report](../../scratch/navigation-renderer-paced/narrow/report.md)
- [Narrow distribution](../../scratch/navigation-renderer-paced/narrow/results/distribution.json)
