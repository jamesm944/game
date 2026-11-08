# Implementation contracts: migration order, parity, perf canon, bridge transport

- **ADR:** 0012
- **Date:** 2026-11-07
- **Status:** Accepted
- **Amends:** [ADR-0008](./0008-rust-native-sim-core-and-renderer-bridge.md) migration order and performance claims
- **Context Issues:** [jamesm944/game#189](https://github.com/jamesm944/game/issues/189) (Wayfinder Map 8), conflicts C1–C15 in [`docs/research/map8-build-sequence.md`](../research/map8-build-sequence.md)

## Decision

1. **Migration is core-loop-first on one authoritative Rust store.** ADR-0008's greenfield-first ordering with dual live sims is superseded; #165's hard break and one-authoritative-store rule govern. TS remains the frozen behavioral reference, never a second live authority.
2. **Parity means semantic trace equality** against frozen TS fixtures **plus** Rust-internal digest equality across 1/2/4/8 workers. Float/byte hash equality with the TS sim is explicitly not required and not claimed.
3. **Perf canon is the workload-tier table** (`docs/research/deep-sim-workloads-and-scaling.md` §8: T2 5,000 Pops ≤33.3 ms p99 input-visible on Apple M1; T3 20,000 stretch ungated). ADR-0008's "<8 ms @20k entities on M2" line is retired.
4. **Bridge transport is loopback TCP + FlatBuffers snapshots/intents**, as proven by the hybrid prototype (23 B/unit). Unity spawns and owns the Rust process lifecycle. Shared memory is adopted only if T3 measurements later demand it.
5. **Fixtures, formats, ownership:** golden fixtures live in `tests/golden/v2/`, frozen under the `fixtures/v1-final` tag after the aliased-resolver fog perf gate is fixed; Rust owns the save-format definition; one content schema codegens TS + Rust + C# (no hand-maintained parallel shapes).
6. **Cross-platform honesty:** replay bit-equality is guaranteed per platform (ARM and x86 float paths may diverge); saves must load cross-platform, bit-exact replay need not.

## Consequences

- The parity ticket (#187) proves (2) on one frozen reference scenario before deep systems land.
- The skeleton ticket (#186) builds on (1) and (4) with no Tauri remnant.
- Any future change to these six points amends this ADR, not the tickets that consumed it.
