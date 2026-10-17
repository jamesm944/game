# Should this game move to Unity?

Research date: 17 October 2026. Context: [Investigate whether Unity or another engine would improve the game](https://github.com/jamesm944/game/issues/156). This is a decision aid; no engine migration or comparable engine benchmark has been performed.

## Recommendation for this project

Keep the tactical overview, close settlement view, and wide coastal view as three supported camera modes of one game. None requires changing engines. Retain switching as a product requirement independent of the renderer decision; default framing and transition behavior remain to be specified.

**Unity is the strongest next candidate to test for the desktop-first version, starting with URP, but the evidence does not yet justify rewriting the game.** Its terrain, lighting, camera, animation and asset workflows could reduce how much engine infrastructure this team maintains. A matched visual slice and a small simulation port should determine whether those gains outweigh migration. Use HDRP as a second visual experiment only if the approved look requires its richer water, atmosphere and lighting features. This is a project-specific engineering judgment, not a measured performance result.

The present prototype is not the visual ceiling of Three.js. Better asset consistency, composition, terrain materials, silhouettes, foliage placement, animation and lighting remain art-direction work in every engine. A Unity version using unchanged assets and poor composition will not automatically look better. Compare equivalent scenes before attributing a visual difference to the engine.

## What Unity supplies

Unity's official Unity 6 feature matrix lists terrain materials, vegetation, GPU-instanced terrain, directional shadows and cascades in both URP and HDRP. HDRP additionally supplies its integrated water system, compute wave simulation, foam and richer atmosphere; that water system is **not included in URP**. URP water therefore needs a shader, package or custom work. URP supports WebGL in that matrix; HDRP does not. The two pipelines are materially different choices, not a free quality toggle. [Unity render-pipeline feature comparison](https://docs.unity3d.com/6000.0/Documentation/Manual/render-pipelines-feature-comparison.html).

Unity has screen-size-driven mesh LOD groups and configurable cross-fading. That helps the same settlement span close detail and distant panoramic views; suitable meshes, transition tuning and GPU budgeting remain necessary. [Unity LOD Group](https://docs.unity3d.com/6000.0/Documentation/Manual/class-LODGroup.html).

Unity's animation tooling supplies clips, state machines, retargeting and blending. Cinemachine supplies camera rigs and composition tools; three camera presets with controlled blends fit its purpose, although custom RTS navigation and selection behavior still need implementation. [Unity animation overview](https://docs.unity3d.com/6000.0/Documentation/Manual/AnimationOverview.html), [Cinemachine documentation](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/index.html).

Existing glTF/GLB art need not be discarded: Unity's first-party glTFast package imports these assets in the Editor or at runtime, including meshes, materials and animation clips. Imported material appearance, scale, axes, rigs and companion textures still need checking in the chosen pipeline. [Unity glTFast](https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Documentation~/index.md), [Editor import workflow](https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/Packages/com.unity.cloud.gltfast/Documentation~/ImportEditor.md).

## Simulation: a potential benefit with a substantial port

The current source separates pure TypeScript simulation from presentation. `src/sim/core/world.ts` advances 30 Hz fixed ticks; `src/sim/mirror.ts` produces typed-array snapshots with IDs, positions, headings and activities. `docs/adr/0004-threading-model.md` keeps simulation mutation ordered and permits pure worker jobs applied at tick boundaries. Those are valuable contracts to preserve. The source currently uses custom component stores; a dependency or older ADR mentioning bitecs does not mean it is already Unity Entities code.

The parent session's audit at `b31b14c` counted 108 simulation TypeScript files, approximately 39,974 lines including comments, plus substantial UI, save/replay and test code. Existing data and assets are reusable inputs; TypeScript source and browser UI are not drop-in Unity scripts. Unity's supported scripting environment is C#/.NET. A normal native Unity implementation entails a C# port and presentation integration. A JS-runtime or subprocess bridge is another architecture to prove, with packaging, IPC, save ownership and debugging costs, rather than an assumed shortcut. [Unity scripting environment](https://docs.unity.com/en-us/engine/6000.6/manual/scripting/get-started/intro-to).

Entities provides a data-oriented ECS; Jobs schedules parallel work; Burst compiles compatible compute code. These are possible tools for large populations, not evidence that this game's tick will become faster without measurement. Burst restricts code to supported .NET constructs and native containers; a direct translation retaining arbitrary managed object graphs is not automatically Burst-compatible. Start with a plain, ordered C# reference simulation; optimize measured hotspots afterward. [Entities overview](https://docs.unity3d.com/Packages/com.unity.entities@1.4/manual/index.html), [Job system](https://docs.unity3d.com/6000.0/Documentation/Manual/job-system.html), [Burst type support](https://docs.unity3d.com/Packages/com.unity.burst@1.8/manual/csharp-type-support.html).

**Do not repeat the older claim that Burst's deterministic float mode is merely reserved.** The current official Burst 1.8 manual and API explicitly document `FloatMode.Deterministic`, restricted to 64-bit architectures. The manual says its guarantee applies to Burst-compiled code, identifies hazards from outside calculations/function pointers and platform intrinsics, and excludes identical NaN payloads. This still does not establish deterministic system order, races, reductions, RNG, command timing, engine physics or equivalence with existing JavaScript fixture digests. Pin the exact package and prove the required behavior on Windows/x64 and macOS/ARM64. [Burst floating-point options](https://docs.unity3d.com/Packages/com.unity.burst@1.8/manual/compilation-burstcompile.html), [FloatMode API](https://docs.unity3d.com/Packages/com.unity.burst@1.8/api/Unity.Burst.FloatMode.html).

Keep engine animation, cinematic waves and cosmetic physics outside authoritative simulation. Unity's Web documentation explicitly warns that physics need not match the Editor or other platforms. It also says C# managed threading is unavailable in Web builds; experimental native C/C++ threading is a different capability. Native desktop and browser therefore need separate performance and compatibility evidence. [Unity Web technical limitations](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-technical-overview.html).

## Alternatives and packaging

| Option | Fit for this game | Main unresolved cost |
| --- | --- | --- |
| Three.js + TypeScript | Preserves tested simulation, UI and browser iteration; all three camera modes can stay. | Team continues owning terrain, materials, animation scaling and desktop runtime validation. |
| Unity URP | Recommended native challenger: integrated authoring/rendering with a scalable visual target. | C# and UI port; custom or package water; replay compatibility and platform evidence. |
| Unity HDRP | Strong candidate if coastal atmosphere and high-fidelity close views dominate the approved look. | Higher feature/platform demands to benchmark; no WebGL route in cited matrix. |
| Godot | Credible open-source desktop alternative with PBR, shadows, animation and multiple camera projections. | Game logic/presentation port and proof that chosen terrain/water workflow reaches the target. |
| Unreal | Worth considering if a high-end cinematic desktop target becomes the overriding goal. | Largest architectural departure from this TypeScript simulation; native-browser export is not a normal built-in route. |

Godot is MIT licensed and allows commercial proprietary games with required notices. Its current stable docs list substantial 3D rendering tools. However, Godot 4 C# projects currently cannot export to the Web, and Web export uses the Compatibility renderer/WebGL 2 rather than Forward+/Mobile or WebGPU. Choosing C# Godot would therefore make a retained browser demo a separate unresolved requirement. [Godot licence](https://godotengine.org/license/), [feature list](https://docs.godotengine.org/en/stable/about/list_of_features.html), [Web export limitations](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html).

Epic announced the migration of HTML5 support to a community extension in its 4.23 release notes. Do not plan a current Unreal browser release as an ordinary official HTML5 export. Epic's Pixel Streaming runs the game on a remote CPU/GPU and streams frames plus input to browsers: hosting, latency and ongoing service requirements are different from running locally in a downloaded browser build. [Epic HTML5 support announcement](https://www2.unrealengine.com/blog/unreal-engine-4-23-released), [Epic Pixel Streaming overview](https://dev.epicgames.com/documentation/unreal-engine/overview-of-pixel-streaming-in-unreal-engine).

**Tauri is packaging, not an automatic renderer upgrade.** Its frontend runs HTML/CSS/JS in system WebViews: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux. It does not replace the frontend with a native game renderer. Runtime versions and feature support differ by OS. Rust backend work can be added explicitly, but neither unlimited useful threads nor uniform WebGPU behavior follows from wrapping the existing app. Test GPU adapter/device creation and full gameplay in actual packaged builds on each intended OS. [Tauri process model](https://v2.tauri.app/concept/process-model/), [WebView versions](https://v2.tauri.app/reference/webview-versions/).

Steam distribution is a separate packaging/store integration question. It does not itself decide the renderer, improve simulation throughput or settle WebView compatibility.

## Licence facts relevant to the decision

Unity's current pricing page confirms cancellation of the Runtime Fee for every engine version. Current Editor terms set Personal eligibility at at most US$200,000 Total Finances in the most recent twelve months, Pro above that and below US$25 million, and Enterprise at US$25 million or above. Total Finances depends on individual/company/service-provider circumstances; this is not simply this game's sales. Determine the actual licensee before assuming free eligibility. Current paid seat pricing can change and is not a total-project budget. [Unity pricing and Runtime Fee cancellation](https://unity.com/products/pricing-updates), [current Unity Editor terms](https://unity.com/legal/editor-terms-of-service/software).

Epic's current game licensing page describes 5% royalties on attributable lifetime gross product revenue above US$1 million, with exclusions including Epic Games Store revenue; game developers on this route do not buy the non-game seat subscription. Actual applicable EULA terms/exclusions must be checked at release. [Unreal licensing](https://www.unrealengine.com/license).

## Proof before a migration decision

These are proposed acceptance gates, not completed tests:

1. **Comparable visuals:** import the same village, coastline, assets, scale and camera poses into a pinned Unity URP project. Include A/B/C switching, terrain transitions, shoreline/water, vegetation, directional shadows and representative walking/working units. Capture matched stills and camera-motion video against the improved Three.js baseline. Have James judge readability and atmosphere. Use HDRP only as a separately measured candidate.
2. **Representative workload:** use the existing SPEC baseline of 300–500 simulated Pops at 30 Hz and 500 visible units at 60 fps; instrument p50/p95 simulation, CPU/GPU frame time, memory, loading and input latency on agreed minimum hardware. Preserve the existing p95 simulation target of 8 ms. A later population target needs an explicit workload; no engine can promise an unspecified scale. Compare release players, not Editor versus browser development mode.
3. **Port correctness:** translate one bounded vertical slice—commands, movement/path results and one economic activity—and run identical seeds/commands. Require milestone digest parity where representation is preserved, or explicit reviewed schema/version changes plus semantic invariants where it is not. Repeat across target CPUs/OSes, saves/reloads and replays. A Unity-only replay passing twice does not establish equivalence to the TypeScript game.
4. **Workflow and migration inventory:** prove repeatable asset import, headless test/build automation, small code-reviewed changes, data validation and crash/replay diagnosis. Inventory the remaining UI, input/selection, fog, audio, navigation, serialization and distribution work before committing. Do not estimate a full rewrite from the visual prototype alone.
5. **Decision rule:** migrate only if the approved look and sustainable content workflow improve materially, the target workload passes, and preservation/port costs are accepted. Otherwise improve the current renderer with the same art-direction findings. The current desktop-platform decision should be revisited if packaged WebView tests fail; Tauri must not be treated as proof that they pass.

## Evidence limits

Official documentation establishes available features and licensing terms, not this game's frame rate or production quality. No Unity, Godot or Unreal player was built for this research; no comparable memory, build size, port duration or maximum-population result exists. The camera preference is independent of those unanswered questions.

## Repository migration audit

Inspected source revision `b31b14c` (counts include comments and blank lines; these are migration-surface indicators, not effort estimates):

| Area | TypeScript files | Lines | Migration implication |
| --- | ---: | ---: | --- |
| `src/sim/` | 108 | 39,974 | Existing economy/combat/Pops/AI/path/save/scenario logic is TypeScript; a C# core is a port, not an engine setting. |
| `src/render/` | 27 | 6,245 | three.js meshes/materials, custom GLSL, sprite atlases, overlays, camera, and effects need renderer-specific replacement. |
| `src/ui/` | 26 | 8,837 | DOM UI/panels require new engine UI or an explicitly supported bridge. |
| `src/game/` | 5 | 1,710 | Session/bootstrap/browser persistence and replay wiring require adapters or replacement. |
| `tests/` | 169 | 56,763 | Existing tests and fixtures are valuable behavioral references; Vitest tests do not automatically become Unity tests. |

- **Current envelope:** `SPEC.md` §2.3 targets 300–500 individually simulated Pops at 30 Hz; §7 targets 500 visible at 60 fps, p95 sim tick ≤8 ms, mirror writes ≤2 ms. These are existing contracts, not fresh measured results and not a demonstrated thousands-of-Pops capability. The expanded roadmap needs a new explicit target.
- **Core implementation:** `src/sim/core/world.ts` stores component rows as `Map<number, number[]>` and advances systems in a registered order. `bitecs` is a dependency/intended seam, not the active world storage implementation shown in source. Switching engines does not turn that simulation into Entities/Burst automatically.
- **Useful seam:** `src/sim/mirror.ts` exposes entity IDs, positions, headings, health fractions, definition/activity codes and owner IDs in typed arrays. A renderer comparison can consume exported snapshots without rewriting the live simulation first. For an initial engine scene, capture these as a fixed trace (with a documented frame/tick schema); this proves presentation, not live cross-runtime integration.
- **Reusable content:** 110 JSON definition files, 195 `.gltf`, 32 `.glb`, 57 `.fbx` assets. File counts include model variants/props. Definitions, scenarios, art direction, commands and fixture intent are portable inputs; importing assets still needs material/animation/scale validation and retained licence notices. Existing JSON schemas/runtime loaders remain TypeScript and require adapters.
- **Save/replay risk:** `src/sim/core/digest.ts` and `SPEC.md` hash exact IEEE-754 f64 values in canonical component/entity order. The current format/version gates in `src/sim/save/serialize.ts` and `src/game/session.ts` cannot be declared compatible with a float32 C# port by visual inspection. Test representative commands/saves and explicitly choose compatibility or an intentional version break. Changing the renderer alone should leave the simulation oracle unchanged.
- **Architecture constraint:** ADR-0001 preserves a render-independent simulation; ADR-0004 keeps authoritative ticks single-threaded with deterministic worker request/result ordering. A proposed parallel authoritative Unity simulation would require a superseding ADR and repeatability evidence. Native Jobs are a capability, not permission to discard these contracts.
- **No migration performed:** no Unity installation, native executable, imported Unity project, matched benchmark, full engine rewrite, or selected pipeline is claimed by this research.

Local primary sources: [`world.ts`](../../src/sim/core/world.ts), [`sim/mirror.ts`](../../src/sim/mirror.ts), [`render/mirror.ts`](../../src/render/mirror.ts), [`session.ts`](../../src/game/session.ts), [`saveManager.ts`](../../src/game/saveManager.ts), [`serialize.ts`](../../src/sim/save/serialize.ts), [`digest.ts`](../../src/sim/core/digest.ts), [`SPEC.md`](../../SPEC.md), [ADR-0001](../adr/0001-deterministic-ecs-core.md), [ADR-0004](../adr/0004-threading-model.md).
