# Deterministic ECS core with fixed-timestep sim/render split

An AoE-like needs hundreds of units pathing and fighting at interactive framerates, and agents need reproducible bugs and headless tests. We decided on: **bitecs** for the entity model (SoA typed arrays, ~5 kB, actively maintained; fallback to a hand-rolled component store if its v0.4 API slows agent work), a **fixed-timestep accumulator loop at 30 Hz sim ticks** (250 ms frame clamp + max-steps cap + render interpolation), and a **strict seam**: the `sim/` package is pure TypeScript — zero DOM/Three.js imports, commands in, state out — while `render/` only reads and interpolates.

Determinism rules follow OpenRA/AoE practice: no `Math.random` in sim code (seeded PRNG only), stable entity iteration order, commands consumed on tick boundaries. This buys replays, golden tests, and desync-free future multiplayer essentially for free.

## Considered Options

- miniplex (best DX) rejected: stale since Jul 2023.
- koota rejected: mid-pack perf, React-idiom gravity we won't use.
- Variable-dt monolithic update rejected: kills replay/test determinism and stutters under GC pauses.

## Consequences

- Sim logic may not call `Math.random`, read the clock, or touch rendering state; violations are test-enforceable.
- Renderer must interpolate between previous/current tick state (micro-stutter otherwise).
- 30 Hz was chosen over 60 Hz: halves worst-case sim CPU at hundreds of units; interpolation hides the difference.
