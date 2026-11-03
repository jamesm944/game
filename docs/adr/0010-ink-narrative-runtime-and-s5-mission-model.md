# Ink as the single narrative runtime; S5 data triggers own mission logic

- **ADR:** 0010
- **Date:** 2026-10-30
- **Status:** Accepted
- **Context Issues:** [jamesm944/game#166](https://github.com/jamesm944/game/issues/166) (Wayfinder Map 6: AAA Supremacy), building on #150 (campaign shape), #154 (council dilemmas), #155 (Emperor Favor), [ADR-0008](./0008-rust-native-sim-core-and-renderer-bridge.md) (Rust sim), [ADR-0009](./0009-unity-urp-presentation-engine.md) (Unity)

## Context

The campaign is a single-settlement Chronicle saga of data-only missions on the existing S5 deterministic trigger engine (#150). Branching dialogue and narrative dilemmas (Town Council votes and dilemmas, #154; Imperial decrees, #155) still need an authoring and runtime model. Candidates on record were Ink/inkjs, Godot Dialogue Manager ("direct vendor if Godot wins" — it did not; Unity did, ADR-0009), Widelands-style mission coroutines, and home-grown dialogue data extending S5. Saves and replays are Rust-owned and deterministic (ADR-0008, v2 boundary in #165), so narrative state must serialize inside sim state, and no second canonical runtime may grow beside the first.

## Decision

1. **Ink is the single narrative runtime**, via inkle's official Unity integration (MIT). Stories are authored as `.ink` source in-repo (Inky for writers) and compiled to JSON at build time with a pinned inklecate version. Yarn Spinner and home-grown dialogue data are rejected; Godot Dialogue Manager is moot after ADR-0009.
2. **Story state is sim-owned.** Ink flow position + variables serialize as a versioned opaque blob inside the Rust sim's save/replay state and advance only through sim commands. Unity presents lines and choices and holds no canonical narrative state. No wall-clock or unseeded randomness inside stories; any story randomness draws from seeded sim RNG through the command bridge.
3. **Bridging is an allowlist.** Ink external functions map to the same validated sim commands used by players and AI (objectives, spawns, favour/tax deltas, scenario actions). Stories never mutate state directly, so replays and validation have exactly one command path.
4. **Division of labour, no second mission system.** S5 data triggers own mission logic and sequencing; Ink runs only at dialogue/dilemma moments an S5 action opens and returns its outcome as commands. Widelands-style mission coroutines were considered and rejected to avoid two canonical scripting systems.
5. **Mods ship compiled Ink JSON only**, validated at load (schema/story-state version, external-function allowlist) and rejected cleanly when malformed — never raw mod code execution, never a corrupted match.
6. **Meaning is never keyword-matched.** Any future free-text player input is interpreted by a model judgement recorded in structured fields that Ink conditions then read. No keyword lists, regex or substring triggers over player language inside stories, triggers or dilemma logic — the standing machine-wide rule, recorded here so it binds this subsystem explicitly.

## Trade-offs considered

- **Yarn Spinner**: Unity-first and MIT, but thinner state/programming depth and tooling than Ink for dilemma-heavy political narrative.
- **Extending S5 with dialogue data**: zero new dependency, but branching-dialogue authoring in raw JSON schemas is poor and would grow a worse Ink in-house.
- **Costs accepted:** an Ink compiler/runtime version to pin and migrate, story-state blob versioning discipline inside the save format, and an allowlist that must be extended deliberately as dilemmas need new effects.
