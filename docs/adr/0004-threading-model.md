# Single-threaded deterministic simulation with contract-bound Web Workers

The game is multi-threaded everywhere it pays — but never inside the simulation tick. We decided: the 30 Hz `step()` stays **single-threaded on the main thread**, and every heavy pure computation (pathfinding today; mapgen and save compression as they earn it) is offloaded to Web Workers bound by one contract — a worker is a **pure function of its request contents plus an explicit seed**: same bytes in, same bytes out, no shared mutable state, no clock reads, results applied at tick boundaries in ascending-id order.

Why: golden fixtures and replays are the project's machine-verifiable "done" (SPEC §7), and both die if floating-point reduction order varies between runs. JavaScript gives us no deterministic parallel scheduler — `SharedArrayBuffer` + `Atomics` would buy true shared-memory threading at the cost of hand-rolled synchronization whose iteration order we cannot pin cross-platform. A single-threaded tick makes determinism structural instead of disciplined.

## Considered Options

- Parallel ECS scheduling (Bevy-style systems-in-parallel): rejected — JS has no cross-platform-deterministic way to order conflicting system writes; gains are marginal at our entity counts given tick tiering.
- Lockstep-partitioned sim shards over `SharedArrayBuffer`: rejected — enormous complexity for a single-player game; revisit only if multiplayer ever returns.

## Consequences

- Workers receive snapshots/inputs as copy or transferred `ArrayBuffer`s; they never hold references into live sim state.
- Worker latency is hidden by bounded contracts (`dueTick` blocking, frame clamp), never by letting results land mid-tick.
- Adding a new offload target requires proving purity via a double-run digest test before it ships.
