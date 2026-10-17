# Free reusable assets and engine code for a Rust simulation frontend

Date: 17 October 2026. Scope: primary-source research for the hybrid-engine prototype. This note does not report an engine benchmark, a completed migration, or feature parity with the existing game.

## Recommendation

**Keep Unity as the requested visual prototype, and use Godot as the strongest alternative to compare.** For this project, Godot's principal advantage is reusable, modifiable engine and presentation code with permissive licences; Unity's advantage is its established authoring workflow and integrated presentation packages. The free art advantage is largely shared: our existing CC0 medieval buildings, characters, boats and terrain textures can be used in either engine. We should not choose Unity merely because its store has many free listings, or Godot merely because its engine is open source.

This is an engineering assessment, not a measured winner. Test the same Rust executable, scene manifest, art, camera framing, entity count and presentation settings in each frontend. Keep simulation authority outside the renderer so the frontend remains replaceable. Use the three required views as presets of the same world: tactical overview, settlement close view, coastal panorama.

## Engine comparison

| Option | Concrete free reuse | Fit for an independent Rust simulation | Main qualification |
| --- | --- | --- | --- |
| **Unity** | Terrain/Terrain Tools; Cinemachine cameras; glTFast import; Animator/UI; DOTS presentation examples | C ABI native plugin or local sidecar; Rust retains authoritative state | Engine and several sample/package licences are Unity-dependent. URP/HDRP and package-version compatibility must be pinned. |
| **Godot** | Terrain3D, Phantom Camera, Open RTS interaction shell, ocean shader donors, built-in glTF animation/UI, MultiMesh examples | Same local sidecar; native GDExtension is another option | Community addons require compatibility checks. Terrain3D's Metal support has an explicit qualification; test it on this Mac. |
| **Unreal** | Top Down Strategy template, Landscape/Water, Lyra UI/examples, City Sample crowd rendering/LOD examples | C++ C ABI wrapper or sidecar | Free examples remain under Epic's terms; high-fidelity sample content is not automatically portable or suitable for RTS scale. |
| **Bevy** | Rust ECS, glTF/animation/rendering and instancing/UI examples | Directly share a Rust library; independent headless simulation remains possible | Main README warns of missing features and regular breaking API changes. More presentation/tool integration work is likely for this project. |

Sources: [Unity Terrain Tools](https://docs.unity3d.com/6000.0/Documentation/Manual/com.unity.terrain-tools.html), [Godot MIT licence](https://github.com/godotengine/godot/blob/master/LICENSE.txt), [Unreal current Top Down template](https://dev.epicgames.com/documentation/en-us/unreal-engine/top-down-template-in-unreal-engine), [Bevy README and licences](https://github.com/bevyengine/bevy). The comparative fit and integration costs are inferences from these capabilities, not vendor performance claims.

## Code donors: inspect and pin before integrating

### Godot: the strongest open-source presentation candidate

| Donor | Useful reuse | Verified licence / constraints |
| --- | --- | --- |
| [Terrain3D](https://github.com/TokisanGames/Terrain3D) | Editable heightmap terrain, texture painting, terrain/foliage LOD, instancing | [MIT](https://github.com/TokisanGames/Terrain3D/blob/main/LICENSE.txt). [Latest stable release API](https://api.github.com/repos/TokisanGames/Terrain3D/releases/latest) returned **v1.0.2-stable**, published 19 May 2026; main is newer. Use a compatible release, not unpinned main. |
| [Phantom Camera](https://github.com/ramokz/phantom-camera) | Camera transitions, look-at, framing, damping; convenient switching between all three views | [MIT](https://github.com/ramokz/phantom-camera/blob/main/LICENSE). Main README declares Godot **4.4+**. [Release API](https://api.github.com/repos/ramokz/phantom-camera/releases/latest) returned **v0.11.0.3**, 19 July 2026. |
| [Open RTS](https://github.com/lampe-games/godot-open-rts) | RTS camera, minimap, selection, fog-of-war and interaction reference | [MIT](https://github.com/lampe-games/godot-open-rts/blob/main/LICENSE), Godot **4.3** according to main README. [Repository API](https://api.github.com/repos/lampe-games/godot-open-rts) reports last push 7 January 2025. Treat as a donor to port/test, not a maintained drop-in 4.7 framework. Its sci-fi art is not our game's look. |
| [Godot 4 Ocean FFT](https://github.com/tessarakkt/godot4-oceanfft) | Compute-shader ocean displacement, water LOD, basic buoyancy and shading | [MIT](https://github.com/tessarakkt/godot4-oceanfft/blob/devel/LICENSE). README requires **4.3+**, calls it early work in progress and lists beach/rock interactions and wakes as unfinished. Do not promise finished shoreline foam from this addon. |
| [WaterShader](https://github.com/Brandt-J/WaterShader) | Smaller water material reference with foam, caustics, transparency | Repository declares MIT and Godot 4; integration/target-renderer compatibility remains untested. Prefer a small shoreline implementation for the prototype over an unneeded ocean simulation. |
| [Official demo projects](https://github.com/godotengine/godot-demo-projects) | UI, animation and rendering examples | MIT repository; check individual asset notices and the branch matching the editor. |

[Terrain3D's platform documentation](https://github.com/TokisanGames/Terrain3D/blob/main/doc/docs/platforms.md) says Vulkan support is established, Compatibility works since Terrain3D 1.0/Godot 4.4, and full Metal support is not clear. This is a material test for an Apple Silicon desktop; it is not evidence that Godot terrain fails here.

For crowds, [Godot's MultiMesh documentation](https://docs.godotengine.org/en/stable/tutorials/performance/using_multimesh.html) explains instancing and batched buffer updates, including building arrays on worker threads. Individual instances are not frustum-culled; split batches spatially. Its page also carries a 4.7 freshness notice. Rendering many simple instances is not proof that many individually animated Pops will meet the frame budget.

Rust can be linked through [godot-rust/gdext](https://github.com/godot-rust/gdext), whose [Cargo manifest](https://github.com/godot-rust/gdext/blob/master/godot/Cargo.toml) specifies **MPL-2.0** and currently version 0.5.5. This is file-level copyleft, not MIT, and does not require choosing it: a sidecar protocol avoids this dependency and gives both frontends the same transport. Keep engine object access on the engine's permitted threads; simulation worker threads produce plain data.

### Unity: strong built-in tooling, with package-specific terms

| Donor | Useful reuse | Verified licence / constraints |
| --- | --- | --- |
| [Cinemachine](https://github.com/Unity-Technologies/com.unity.cinemachine) | Camera rigs, blending and camera examples | Current [licence](https://github.com/Unity-Technologies/com.unity.cinemachine/blob/main/com.unity.cinemachine/license.txt) is **Unity Companion Cinemachine Code License 1.0**, with Unity-dependent use. Main package is 3.1.8-pre.2, minimum Unity 2022.3. Select an editor-compatible released version. |
| [Unity glTFast](https://github.com/Unity-Technologies/com.unity.cloud.gltfast) | Import the same existing glTF/GLB art at edit time/runtime | [Apache-2.0](https://github.com/Unity-Technologies/com.unity.cloud.gltfast/blob/main/LICENSE.md). Main package 6.20.1-pre.1 declares minimum Unity **6000.0**, with Burst/Collections dependencies. Keep import/decoding outside the simulation benchmark. |
| [Terrain Tools](https://docs.unity3d.com/6000.0/Documentation/Manual/com.unity.terrain-tools.html) | Sculpting brushes, terrain utilities and externally generated texture-data workflow | Official manual lists 5.3.1 for Unity 6000.0. Unity-provided tooling; no portable permissive source licence was independently established here. |
| [Boat Attack Water](https://github.com/Unity-Technologies/boat-attack-water) | URP water/rendering reference | [Unity Companion](https://github.com/Unity-Technologies/boat-attack-water/blob/master/LICENSE.md). Master package is 2.0.0-preview.5, minimum Unity 2021.3 and URP 12.1.10 dependency. This does **not** establish compatibility with Unity 6 URP/RenderGraph; porting may be necessary. |
| [Entity Component System Samples](https://github.com/Unity-Technologies/EntityComponentSystemSamples) | Instanced crowd presentation, jobs and rendering examples | [Unity Companion](https://github.com/Unity-Technologies/EntityComponentSystemSamples/blob/master/LICENSE.md). Current README specifies Unity **6.2** and Entities/Physics/Netcode/Graphics **1.4**. Reuse rendering patterns without adding a second authoritative simulation. |

The discoverable [nefrob Unity RTS project](https://github.com/nefrob/unity-rts) contains camera, selection and fog-of-war examples but uses Unity 2020.1.3f1, last pushed March 2021, and GitHub reports no licence. **Do not copy its code without an explicit licence.** Public source visibility is not reuse permission. The official examples above are the clearer starting point.

### Unreal and Bevy: useful alternatives, no need for another simulation

Unreal's [Top Down template Strategy variant](https://dev.epicgames.com/documentation/en-us/unreal-engine/top-down-template-in-unreal-engine) provides group selection, movement, an orthographic camera and selection UI. [Lyra and other official samples](https://dev.epicgames.com/documentation/unreal-engine/sample-game-projects-for-unreal-engine) allow reuse of systems/elements in games under the applicable Epic terms. [City Sample](https://dev.epicgames.com/documentation/unreal-engine/city-sample-project-unreal-engine-demonstration) demonstrates crowd LOD/visualization and Mass AI; copy the rendering approach if useful, not its authoritative crowd logic over our Rust simulation. The old [Strategy Game sample](https://dev.epicgames.com/documentation/en-us/unreal-engine/strategy-game?application_version=4.27) is explicitly unsupported after UE 4.24 and is not a modern ready-made RTS foundation.

Bevy's [official examples](https://github.com/bevyengine/bevy/tree/latest/examples) cover instancing, animation, glTF and UI, with MIT/Apache-2.0 options documented by the engine. [Release API](https://api.github.com/repos/bevyengine/bevy/releases/latest) returned **v0.20.0**, published 8 October 2026. Its regular breaking changes and incomplete toolset make it a useful Rust-native architecture candidate rather than the best immediate shortcut to a polished, art-heavy frontend. That ranking is an inference, not a benchmark.

## Shared free art: we already have much of it

The local `src/assets/models/*/LICENSE.md` inventory includes Quaternius Ultimate Fantasy RTS, Medieval Village, farm buildings/animals, animated animals, base characters and two animation libraries; KayKit Adventurers and Enemy Skeletons; Kenney Pirate Kit and Watercraft; and terrain PBR maps. Existing `package.json` uses Three.js 0.185.x and bitecs 0.4.x. Do not interpret this inventory as proof every model is production-ready or every animation is retargeted.

| Source | Concrete reusable material | Terms and practical reuse |
| --- | --- | --- |
| [Quaternius Ultimate Fantasy RTS](https://quaternius.com/packs/ultimatefantasyrts.html) | 128 medieval RTS buildings/resources; glTF, FBX, OBJ, Blend | CC0 on the pack page. Already vendored locally; ideal matched settlement assets. |
| [Kenney Fantasy Town Kit](https://kenney.nl/assets/fantasy-town-kit) | Town buildings, walls and props | CC0; free individual download. Supplement where existing Quaternius set lacks a prop. |
| [Kenney Pirate Kit](https://kenney.nl/assets/pirate-kit) | Boats, ships and dock props | Local provenance records CC0 and embedded glTF materials. Already vendored. |
| [Poly Haven](https://polyhaven.com/license) | Terrain PBR surfaces, HDRIs and models | Assets are CC0, including commercial reuse and redistribution. Website/API access terms are separate from asset copyright permission. |
| [ambientCG](https://docs.ambientcg.com/license/) | Terrain PBR surfaces | CC0. Existing local Grass001, Ground110 and Rock064 sets can be reused. |

The existing research `docs/research/asset-sourcing-aaa.md` is a discovery inventory, not a substitute for pack-level provenance. Prefer actual local licence files and the provider's source page. CC0 donors are portable; Unity materials, shaders, prefab logic and Unreal materials/Blueprints still require conversion or replacement even when their source meshes can be reused.

### Free-of-price is not the same as portable open source

[Unity Asset Store terms](https://unity.com/legal/as-terms) govern store assets, including restrictions and asset-specific terms. Record the exact licence and acquisition proof per pack; a $0 price does not make a pack CC0 or its source redistributable. Unity-dependent Companion code should not be copied into Godot.

[Fab Standard terms](https://www.fab.com/eula) explicitly allow compatible tools beyond Unreal, while prohibiting standalone redistribution. [Epic's Content EULA](https://www.unrealengine.com/eula/content) also defines UE-Only content. Therefore **do not describe all Fab/Megascans content as UE-only, or assume all historical Megascans acquisitions are unrestricted**: the entitlement and licence under which that asset was acquired matter. We have not verified this user's Fab entitlements or downloaded any restricted marketplace assets.

## Installation and evidence boundary

Official [Unity 6000.3.11f1 release page](https://unity.com/releases/editor/whats-new/6000.3.11f1) exposes an Apple Silicon installer at [the Unity CDN](https://download.unity3d.com/download_unity/3000ef702840/MacEditorInstallerArm64/Unity-6000.3.11f1.pkg). This is a known pinned patch from 11 March 2026, not a claim that it is the newest available editor.

The official Hub Apple Silicon CDN download [UnityHubSetup-arm64.dmg](https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-arm64.dmg) returned HTTP 200 with Content-Length 165,497,866 bytes during this research. The historical unsuffixed `UnityHubSetup.dmg` returned 404. [Unity's official forum topic](https://discussions.unity.com/t/can-we-get-unity-hub-apple-silicone-based-instead-intel-one/1593011/6) provides the arm64 URL. Verify installer signatures before running.

[Unity's licensing manual](https://docs.unity.com/en-us/engine/6000.5/manual/get-started/install-and-upgrade/licenses-and-activation/managing-your-unity-license) states Unity needs an activated licence and Personal activation requires login to Hub; the serial-based command-line activation procedure is not for Personal. Installing an editor does not establish an activated licence. User sign-in/entitlement acceptance is the remaining human step where required; do not invent licence files or bypass activation.

No frontend was run by this research task. Visual quality, Metal terrain compatibility, animation cost, packaged startup time, IPC overhead and comparative frame timings remain measurements for the actual prototypes. A synthetic parallel Rust movement workload must be labelled as such; it cannot establish the speedup of the existing economy, combat, politics or Pop simulation.
