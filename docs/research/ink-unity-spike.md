# Ink in Unity Spike: Story-State Round-Trip Through the Sim Save

Wayfinder: **"Spike Ink in Unity: story-state round-trip through the sim save"** ([#188](https://github.com/jamesm944/game/issues/188)), part of [#182](https://github.com/jamesm944/game/issues/182)
Date: 2026-11-07
Status: **Spike complete — round-trip proven headlessly in Unity 6000.6.6f1; ADR-0010 mechanics hold with the caveats in §6–§8**

Primary sources only: inkle source at pinned tags (cloned into `scratch/ink-spike/`) and this spike's own runs. Every claim cites its source. Spike artifacts live in `scratch/ink-spike/` (throwaway; reproduction in §9).

---

## 1. Verdict

ADR-0010's mechanics work as designed. A minimal council-dilemma story was compiled with pinned `inklecate`, driven headlessly inside the real Unity editor via inkle's official Unity integration, serialized mid-flow to a JSON blob, restored into a **fresh** `Story` runtime, and continued to the correct ending. One allowlisted external function (`sim_adjust_favour`) fired exactly once with the expected argument, and did **not** re-fire after restore. The same Unity-produced blob was then loaded by inkjs (inkle's official JS port) and reached the identical ending — the blob is a portable, runtime-agnostic artifact, which is what the Rust-owned save format needs.

Two conditions are load-bearing and not optional:

1. **Stories must be seeded by the sim.** An unseeded `Story` derives its random seed from the wall clock (`DateTime.UtcNow.Millisecond`, only 100 distinct values) — proven in §6. ADR-0010 §2 already mandates sim-seeded randomness; the spike shows the exact failure mode if a story forgets.
2. **Side-effecting bridge functions must bind with `lookaheadSafe: false`** and be called into a temp, never inline in text/choices (§6). Otherwise one command can fire twice (once during lookahead generation, once for real) — a replay-divergence bug, not a cosmetic one.

## 2. Pinned versions (exact)

| Component | Pinned version | Source |
|---|---|---|
| Ink language + C# runtime + `inklecate` | **v1.2.1** (tag `v1.2.1`, commit `35c63e5 "Version 1.2.1"`) | `gh release list --repo inkle/ink` (Latest, 2026-05-05); local clone `git describe --tags` → `v1.2.1` |
| Ink Unity integration (UPM package `com.inkle.ink-unity-integration`) | **2.0.0** (tag `2.0.0`) | `gh release list --repo inkle/ink-unity-integration` (Latest, 2026-07-07); `package.json` in the tag declares `"version": "2.0.0"`, `"unity": "2022.3"` |
| Unity editor | **6000.6.6f1** | `Unity -version` → `6000.6.6f1` |
| Compiled-story format (`inkVersion` in story JSON) | **21** (runtime accepts ≥ 18) | `Story.cs:19` `inkVersionCurrent = 21`; `Story.cs:36` minimum compatible 18; spike-compiled JSON carries `"inkVersion": 21` |
| Save-state format (`inkSaveVersion` in state blob) | **10** (loader accepts ≥ 8) | `StoryState.cs:25-26` `kInkSaveStateVersion = 10`, `kMinCompatibleLoadVersion = 8`; spike blob carries `"inkSaveVersion": 10` |
| inkjs (cross-check only, not a production dependency) | **2.3.2** | `npm ls inkjs` in `scratch/ink-spike/inkjs-check/` |

Version alignment: integration 1.3.0's changelog records "Updated Ink to 1.2.1", and 2.0.0 builds on it — the runtime source vendored inside the 2.0.0 package (`InkLibs/InkRuntime/Story.cs:19`) is format 21, matching `inklecate` v1.2.1 output. Pin compiler and integration together; the pair above is mutually consistent.

**Pinning routes for production** (upstream `README.md`, "Installation"): UPM git URL `https://github.com/inkle/ink-unity-integration.git#upm` (floats with the `upm` branch — currently 2.0.0 per the branch's `package.json`), OpenUPM scoped registry, `.unitypackage`, or embedding `Packages/com.inkle.ink-unity-integration` into the project (README: "move the `Packages/com.inkle.ink-unity-integration` folder into your own project's `Packages` folder"). Upstream also maintains per-release branches (`upm@refs/tags/2.0.0` verified present via the GitHub API). The spike used the embedded-copy route from the `2.0.0` tag: it is a hard pin, works offline in batchmode/CI, and makes the vendored version reviewable in-repo. Recommended for production for the same reasons.

## 3. Licence (from source)

Both components are MIT, verified from the shipped texts, not from repo badges:

- Ink core: `LICENSE.txt` at tag `v1.2.1` — "MIT License, Copyright (c) 2025 inkle Ltd."
- Unity integration: `LICENCE.md` at tag `2.0.0` (also inside the package at `Packages/com.inkle.ink-unity-integration/LICENCE.md`) — "ink and this package is released under the MIT license", Copyright (c) 2016 inkle Ltd. The file adds "Although we don't require attribution…" as a courtesy note; the MIT text below it still requires the copyright/permission notice in copies — keep the notice, treat the courtesy line as non-binding flavour.

No other licence obligations surfaced: the package is self-contained C# source (runtime + compiler + editor tooling) with no third-party binaries in the embedded folder (3.4 MB on disk, of which `InkLibs/` is 1.3 MB of source).

## 4. What the spike built and ran

- **Story** (`scratch/ink-spike/council-dilemma.ink`, ~50 lines): a two-motion council dilemma in the shape of #154/#155. Host-set `VAR simSeed`, `~ SEED_RANDOM(simSeed)` as the first executed line, one `EXTERNAL sim_adjust_favour(delta)`, story variables `favour`/`grain`, a shuffle (`{~sails|smoke|songs}`) and a `RANDOM(1, 6)` so seeded determinism is actually exercised, and an ending that branches on restored state (`favour >= 50`).
- **Compile**: `./inklecate/inklecate -o council-dilemma.json council-dilemma.ink` → exit 0, no warnings, 2,909-byte JSON, `"inkVersion": 21`. The macOS `inklecate` from the v1.2.1 release is a universal (x86_64+arm64) self-contained binary (~137 MB) and ran natively on this arm64 machine — no .NET SDK needed (none is installed here).
- **Unity project** (`scratch/ink-spike/unity-project/`): hand-scaffolded minimal project (`ProjectVersion.txt` = 6000.6.6f1, empty-dependencies `Packages/manifest.json`, embedded Ink package). Unity generated the rest on first open. The `.ink` file was also placed in `Assets/Spike/` and imported through the package's ScriptedImporter (run log: `Importing … council-dilemma.ink … (ScriptedImporter : InkEditor:Ink.UnityIntegration:InkImporter)`) — the 2.0.0 in-editor compile path works, though the spike's runtime path deliberately consumed the `inklecate` JSON, since ADR-0010 §1 compiles at build time with pinned `inklecate` and §5 ships mods as compiled JSON.
- **Driver** (`Assets/Editor/InkSpikeRunner.cs`, run via `-executeMethod`): binds the mock sim command, sets `simSeed = 4242` through `story.variablesState`, drives `Continue()`/`ChooseChoiceIndex()`, saves, restores, and asserts. Full output: `scratch/ink-spike/unity-project/spike-evidence.txt`; editor log: `scratch/ink-spike/unity-run2.log`.

## 5. Evidence: the round-trip works

Run A (fresh `Story`, seed 4242) → choice "Raise the grain levy" → external fired once → saved at the second choice point. Run B (brand-new `Story`, `state.LoadJson(blob)`) → continued to the ending. All 15 checks passed (`failures: 0`), including:

- `PASS A: allowlisted external fired exactly once with -8 (saw: sim_adjust_favour(-8))`
- `PASS B: favour restored to 42 (50-8)` and `PASS B: grain restored to 150 (120+30)` — variables survive the round-trip.
- `PASS B: no duplicate external fired after restore` — the save point sits after the external call; restore does not replay it. This is the single-command-path property ADR-0010 §3 needs.
- Ending line after restore: *"The council adjourns under a cloud. Imperial favour stands at 42."* — the branch taken proves restored variables drive later flow.
- `PASS Determinism: same seed -> identical transcripts` — two fresh full playthroughs at seed 4242 produced byte-identical transcripts (shuffle picked "sails", die rolled 5, both times); seed 777 differed.
- Negative paths fail loudly, never silently: garbage blob → `Exception: Expected " at offset 1`; blob with `inkSaveVersion: 7` → `Ink save format isn't compatible … (saw '7', but minimum is 8)`; unbound external → `StoryException: ERROR: Missing function binding for external: 'sim_adjust_favour' (ink fallbacks disabled)`. This matches ADR-0010 §5's "rejected cleanly when malformed" requirement — the sim loader can catch and refuse, no partial state.

**Cross-runtime corroboration (independent second route):** inkjs 2.3.2 under Node loaded the *Unity-produced* `mid-state.json` untouched and printed the same choices, `favour: 42 grain: 150`, and the same two ending lines with zero external calls (`scratch/ink-spike/inkjs-check/cross-check.mjs`). The blob is therefore exactly what ADR-0010 §2 wants: an opaque, portable JSON payload the Rust save can carry without any Unity coupling.

**Blob size/shape:** mid-flow blob = **1,254 bytes** for this two-choice story (vs 2,909-byte compiled story). Top-level keys, from `StoryState.WriteJson` (`StoryState.cs:659-702`) and confirmed byte-for-byte in the artifact: `flows` (per-flow callstack, output stream, choice threads, `currentChoices` with target paths), `currentFlowName`, `variablesState` (`{simSeed, favour, grain}` as plain JSON values), `evalStack`, `visitCounts`, `turnIndices`, `turnIdx`, `storySeed`, `previousRandom`, `inkSaveVersion`, `inkFormatVersion`. Two properties matter for save design: (a) the RNG state (`storySeed` + `previousRandom`) is **inside** the blob, so a restored story continues the exact random sequence; (b) flow position is stored as content paths (e.g. `"second_motion.0.27"`), so the blob is only valid against the **same compiled story JSON** — a story content edit invalidates in-flight blobs by construction (paths may not resolve). The save format must therefore stamp the blob with the compiled-story hash/id alongside `inkSaveVersion` (see §8).

## 6. Determinism hazards found (source + observed)

1. **Wall-clock seed on construction — the big one.** `StoryState` constructor (`StoryState.cs:481-484` at v1.2.1): `int timeSeed = DateTime.UtcNow.Millisecond; storySeed = (new Random(timeSeed)).Next() % 100;`. Every fresh story starts from one of only 100 seeds chosen by wall-clock millisecond. Observed in the spike: repeatedly constructing unseeded stories yielded `storySeed` values {48, 30, 12} within one run (`PASS Hazard confirmed`). Because shuffles derive from `storySeed` (`Story.cs:2804`: `randomSeed = sequenceHash + loopIndex + state.storySeed`) and `RANDOM()` chains off it (`Story.cs:1505-1513`: `resultSeed = state.storySeed + state.previousRandom`), an unseeded story diverges across replays. **Mitigation (already ADR-0010 §2 policy, now with a mechanism):** the sim sets a seed variable before first `Continue()` and the story's first line executes `~ SEED_RANDOM(simSeed)`; after that, `storySeed`/`previousRandom` ride inside the save blob and restore exactly. Production should also reject/lint stories that call `RANDOM`/shuffles before a `SEED_RANDOM` — a compile-pipeline check, since the runtime cannot know.
2. **Lookahead double-fire for externals.** Ink generates choice/inline text by running content ahead. `Story.CallExternalFunction` (`Story.cs:1974`) errors if a non-lookahead-safe external is hit during string generation, and the `BindExternalFunction` overloads default `lookaheadSafe = false` while `BindExternalFunctionGeneral` defaults it **true** (`Story.cs:2054`) — an easy foot-gun. The official guidance embedded in that error message: capture into a temp first (`~ temp x = func()`). Spike story follows this (`~ temp favourDelta = -8` then the external on its own line). Bridge rule: sim-command externals are side-effecting → bind with `lookaheadSafe: false`, call only from statement position, never inline. Pure query externals (read-only) are the only safe `true` candidates.
3. **`System.Random` algorithm dependence.** Both `RANDOM()` and shuffles instantiate `new System.Random(seed)` per call. Sequences are deterministic for a given .NET runtime, but the algorithm is a runtime implementation detail — the same seed need not produce the same sequence across Mono/IL2CPP/CoreCLR or future .NET versions. Consequence: replay digests that include story outcomes are pinned not just to Ink version but to the C# runtime flavour. This is acceptable if replays are validated on the shipped runtime (ADR-0008's model), but golden fixtures must record the runtime alongside the Ink pin. (inkjs reimplements the same seeded algorithm and matched the Unity blob's continuation here, but that parity is inkjs's deliberate compatibility work, not a spec guarantee to lean on.)
4. **No other time/random APIs in the runtime.** A source sweep of `ink-engine-runtime/*.cs` for `DateTime`/`Random` finds only the sites above (constructor seed, `RANDOM`, shuffle). There is no hidden clock, GUID, or hash-randomization input to flow. `TURNS()`/`TURNS_SINCE` count story turns (serialized as `turnIdx`/`turnIndices`), not wall time.

## 7. Bridge shape vs the S5 engine (what the allowlist maps onto)

The S5 trigger engine the bridge must respect (`src/sim/scenario/types.ts`, `engine.ts`) is data-only and already shaped for this: `TriggerAction` is a closed union (`displayObjective`, `updateObjective`, `spawnUnits`, `spawnEnemyArmy`, `spawnBuilding`, `diplomacyShift`, `audioCue`, `triggerVictory/Defeat`, `setFlag`, `setTriggerEnabled`, `broadcastMessage`), runtime state serializes via `ScenarioSaveState` (objectives, trigger states, flags, counters — all JSON), and the engine header states the same invariants ADR-0010 wants ("Deterministic trigger condition evaluation inside the simulation tick loop", "Zero-desync save/restore serialization").

The bridge therefore needs no new mutation path:

- An S5 action opens a dilemma (new action kind, e.g. `openDilemma { storyId, knot }` — the only S5 schema addition this design implies).
- Ink externals map **onto existing action/command kinds** — e.g. `sim_adjust_favour(delta)` (Emperor Favor, #155), plus future `sim_set_flag`, `sim_update_objective`, `sim_spawn_units` mirroring the existing union members one-for-one. Each external is validated exactly like a player/AI command before it touches state (ADR-0010 §3).
- The story-state blob becomes one new optional field beside `ScenarioSaveState` in the save (stamped per §8); the sim treats it as opaque bytes. Advancing the story (choice selection) is itself a sim command, so replays reproduce narrative branching from the command stream alone.

## 8. Friction log and what production still needs

Friction actually hit during the spike:

1. **`Ink.Runtime.Path` collides with `System.IO.Path`** (CS0104) the moment a file has both `using Ink.Runtime;` and `using System.IO;`. First build failed on exactly this. House style: alias or fully-qualify in bridge code.
2. **No .NET SDK on this machine** — irrelevant: `inklecate` ships self-contained and Unity carries its own toolchain. Recorded because a CI runner needs neither either — it needs the release zip + Unity.
3. **Batchmode licensing noise**: the run log shows `[Licensing::Module] Error: Access token is unavailable` yet the run completed and exited 0. Non-fatal here; CI will need its normal Unity licence handling regardless.
4. **First-open cost**: hand-scaffolded project import + package compile took the bulk of the first batchmode run (minutes, dominated by Library generation). One-time per workspace; incremental runs are fast.
5. **The hybrid-prototype reference pattern was not present to copy**: `/tmp/wt-hybrid` currently has no `prototypes/hybrid/tools/run.py`, no `Assets/Editor/PrototypeBuild.cs`, and its `unity/Packages|ProjectSettings` are empty of manifest/version files (only `Library/` build residue and a built `.app` remain). The spike therefore scaffolded its own minimal project (§4) rather than cloning that pattern. Whoever owns the hybrid worktree may want to note its source files are gone.
6. **2.0.0 is a breaking release by design** (package `CHANGELOG.md`): `.ink` files now import as `InkFile` assets via ScriptedImporter and **no `.json` is generated in-project**; code reads `inkFile.storyJson`. For this project that is fine — ADR-0010's canonical path is external `inklecate` → JSON artifact (also what mods ship, §5 of the ADR) — but nobody should expect the 1.x "JSON appears next to the .ink" workflow. Minimum Unity is now 2022.3 LTS (satisfied by 6000.6.6f1). Note the compiler ships inside player builds as part of `Ink-Libraries` (package README, "Compiling at runtime"); if build size matters, their WebGL trimming guidance applies — but since stories arrive pre-compiled, production may prefer to strip the compiler assembly rather than ship it.

Still needed before production integration (none of it contradicts the ADR; all of it is engineering, not research risk):

- **Save-format stamp**: store `{ inkSaveVersion (from blob), compiledStoryHash, inkRuntimePin }` next to the blob in the `.ageof` v2 payload, and refuse load on mismatch (blob paths are only valid against the identical compiled story, §5). Decide the migration story when `kInkSaveStateVersion` moves (runtime currently loads ≥ 8, writes 10 — a two-version grace window, not a promise).
- **Rust↔Unity carrying shape**: the blob is a UTF-8 JSON string; the Rust sim should store it as opaque bytes + the stamp above, never parse it. Size is ~1.25 KB for a toy story and grows with choice threads/visit counts — budget per-dilemma caps and measure with a real council dilemma before committing save-size guarantees.
- **Command-bridge implementation**: the allowlist table (external name → validated sim command), `lookaheadSafe: false` everywhere side-effecting, temp-capture authoring rule, and story lint (seeded-first-line + no inline externals + externals ⊆ allowlist) in the build pipeline. The runtime already throws on unbound externals (observed), so the allowlist fails closed at runtime too; the load-time check ADR-0010 §5 wants for mods can extract `EXTERNAL` declarations from compiled JSON… (not spiked — compiled JSON does not obviously enumerate externals in the toy artifact; verify the extraction route, possibly from `.ink` source at mod-pack time or by attempting a bind-coverage probe run).
- **Where the canonical Story lives**: ADR-0010 says Unity holds no canonical narrative state and the blob advances only through sim commands. The spike ran the runtime in Unity's editor (the only C# host here). Production must decide the execution host that the Rust sim drives (e.g. the C# runtime hosted wherever sim commands are applied, with Unity as pure presenter) — the blob's proven portability (§5) means this choice is not blocked by format lock-in, but it is an architecture task this spike deliberately did not settle.
- **Inky/writer workflow and version-bump drill**: not exercised (no GUI in scope). Bumping Ink later means re-running this spike's checks against the new pin pair and re-baselining any golden transcripts (hazard §6.3).

## 9. Reproduction

From `scratch/ink-spike/` (all artifacts already present; network steps only needed on a clean machine):

```sh
# Sources (pinned)
git clone --depth 1 https://github.com/inkle/ink.git ink-src                       # v1.2.1
git clone --depth 1 --branch 2.0.0 https://github.com/inkle/ink-unity-integration.git ink-unity-2.0.0
gh release download v1.2.1 --repo inkle/ink --pattern "inklecate_mac.zip" --dir .
unzip -o inklecate_mac.zip -d inklecate

# Compile the dilemma
./inklecate/inklecate -o council-dilemma.json council-dilemma.ink

# Headless Unity round-trip (project scaffold described in §4)
"/Applications/Unity/Hub/Editor/6000.6.6f1/Unity.app/Contents/MacOS/Unity" \
  -batchmode -nographics -projectPath "$PWD/unity-project" \
  -executeMethod InkSpikeRunner.Run -logFile "$PWD/unity-run.log" -quit
cat unity-project/spike-evidence.txt   # expect: failures: 0

# Cross-runtime blob check
cd inkjs-check && npm install inkjs@2.3.2 && node cross-check.mjs   # expect: PASS
```

## Sources

- inkle/ink @ `v1.2.1`: `LICENSE.txt`; `ink-engine-runtime/Story.cs` (format version, `RANDOM`, shuffle, external binding + lookahead), `ink-engine-runtime/StoryState.cs` (save format, wall-clock seed); `Documentation/RunningYourInk.md` (save/load API), `Documentation/WritingWithInk.md` (`SEED_RANDOM`, `RANDOM`).
- inkle/ink-unity-integration @ `2.0.0`: `README.md` (install routes, runtime compilation), `LICENCE.md`, `Packages/com.inkle.ink-unity-integration/package.json`, `CHANGELOG.md` (2.0.0/1.3.0 entries).
- GitHub release listings for both repos (versions/dates/assets) and the branches API (UPM pinning branches), queried 2026-11-07.
- This repo: `docs/adr/0010-ink-narrative-runtime-and-s5-mission-model.md`; `src/sim/scenario/types.ts`, `src/sim/scenario/engine.ts`; issue #188.
- Spike evidence: `scratch/ink-spike/unity-project/spike-evidence.txt`, `scratch/ink-spike/unity-project/mid-state.json`, `scratch/ink-spike/unity-run2.log`, `scratch/ink-spike/inkjs-check/cross-check.mjs` output.
