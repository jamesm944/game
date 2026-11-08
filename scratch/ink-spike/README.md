# Ink spike (issue #188) — throwaway

Findings: `docs/research/ink-unity-spike.md`. Reproduction commands are in §9 there.

Layout:
- `council-dilemma.ink` / `council-dilemma.json` — spike story + inklecate v1.2.1 output
- `unity-project/` — minimal Unity 6000.6.6f1 project, embedded Ink integration 2.0.0;
  evidence in `unity-project/spike-evidence.txt`, blob in `unity-project/mid-state.json`
- `inkjs-check/` — inkjs 2.3.2 cross-runtime blob check (`node cross-check.mjs`)
- `ink-src/`, `ink-unity-2.0.0/`, `inklecate/` — pinned upstream sources/binary (re-fetchable, see findings §9)
