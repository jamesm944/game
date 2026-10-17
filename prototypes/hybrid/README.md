# Hybrid engine prototype — throwaway, not a game migration

This experiment keeps presentation separate from an independent Rust simulation. It compares the existing three.js/WebGPU terrain study, Unity URP, and Godot Forward+ on Metal. Each client keeps **A tactical / B settlement / C panorama**.

## Run on this Mac

```sh
python3 /tmp/game-hybrid-engine-prototype/prototypes/hybrid/tools/run.py unity --view B
python3 /tmp/game-hybrid-engine-prototype/prototypes/hybrid/tools/run.py godot --view B
python3 /tmp/game-hybrid-engine-prototype/prototypes/hybrid/tools/run.py web
```

The web client is `http://127.0.0.1:5188/?prototype=terrain&backend=rust&variant=B`. Add `&benchmark=1` for a fixed 1600×1000 internal target and on-page measurements. The original game still boots at `/`; the previous 32-stand-in scene remains available without `backend=rust`.

The runner prepares five existing CC0 model assets, compiles Rust release mode, starts the local simulation if needed, and launches the chosen client. It terminates only the simulation process it started when that client exits. It never terminates another running server. Existing servers must use the documented hybrid-v1 schema and 500-Pop scene. Ports: Rust TCP 4188 and HTTP 4189; Vite 5188. No cloud backend is required.

Tool overrides: `UNITY_EDITOR` (pinned editor executable), `GODOT_BIN`, `NODE_BIN`. This machine's engines are outside Git; Unity 6000.3.11f1 is activated through the user's Unity Hub licence; Godot 4.7.2 is the official signed macOS build. For another machine install those tools from their official sites and use the overrides as needed. The Python runner requires Cargo and the repository's normal npm dependencies. `build-unity` builds the native player explicitly. Unity's generated player and caches are excluded from Git.

## What actually runs

- **Rust:** a fixed-step integer simulation slice with Pop movement, needs, morale, wealth and resource deliveries. Rayon computes disjoint batches from a phase input; indexed results and integer deposits are committed in entity order. Worker count is configurable and actual worker participation is reported. Native clients receive NDJSON snapshots over localhost TCP and send protocol commands back. Browser uses the same server through HTTP polling.
- **Visuals:** the same continuous analytic coastal geometry, existing Quaternius town/house/farm/mill/tree models, ambientCG grass, procedural shoreline material, 500 capsule stand-ins, and three camera poses. Unity flips the Z basis for its coordinate conventions. Materials/tonemapping are engine-specific approximations, not pixel-identical grading. Unity currently uses ordinary MeshRenderers for the 500 stand-ins; Godot uses MultiMesh and the WebGPU baseline uses InstancedMesh. These implementation differences also prevent treating frame intervals as an engine ranking. Imported characters are not fully animated crowds.
- **Matched stills:** save a Rust reference frame and render it read-only in capture mode, then capture each view at 1600×1000 so entity positions and state digest can be compared. All three views remain interactive camera presets in both native clients.
- **Control probe:** live TCP group-move, return-to-work, acknowledgment and paused-tick stability. Client commands use monotonic request numbers. This is a local, single-user throwaway protocol, not hardened production networking.

## Correctness and performance evidence

`rust-sim ... bench` runs 360 ticks with a group move at tick 40 and work reset at tick 90. It compares direct serial execution with 1/2/4/8 Rayon workers for 500, 2,000 and 10,000 Pops. The equivalent TypeScript slice in `tools/ts-reference.mjs` produces the same final 64-bit digest for all populations and recorded worker configurations. These prototype digests use a new documented integer state encoding; **they are not the existing game's golden digests**.

Raw results live under `evidence/`. Tick timings exclude snapshot serialization, digesting, transport and rendering. Initial results show Rust serial faster than the equivalent TypeScript slice, but parallel scheduling frequently costs more than it saves for this light workload. The initial cold 10,000-Pop single-tick trace did not show simultaneous spans. A separate warmed-up instrumented tick with 100,000 simplified Pops in `parallel-trace.json` recorded four simultaneous compute spans on different workers and identical serial state. An independent interval check verifies cross-worker overlap; this stress probe is not a claim about full-game population capacity. This is separate from the timing benchmark. Worker participation/overlap proves parallel execution; it does not prove useful multicore speedup. No extra artificial work was added to make parallelism look better.

Frame measurements are observed frame intervals in this shared desktop session, with differing presentation/vsync policies, warm-up, browser/native scheduling and background compiler load. A fixed internal target removes resolution mismatch; it does not make these a controlled GPU benchmark. No FPS winner, linear CPU scaling or full-game population capacity is established. Native GPU/CPU timestamp profiles and controlled repeat runs remain required for a production performance decision.

## Important limits

This is **not** a Rust port of the full existing RTS. Existing pathfinding/collision, combat, deep household/social/political systems, company economy, fog-of-war, full HUD, saves/replays, scenario/campaign tooling and victory paths remain in TypeScript and are not reimplemented here. Prototype walkers can overlap buildings and one another. The Rust state is a bounded behavior slice, not a source-compatible replacement for current saves. Lifecycle recovery, buffering/backpressure, schema migrations and production packaging are not finished.

No new architecture was silently applied to the existing sim or ADR-0004. Parallel authority is confined to this prototype. The full game and its tests remain the behavioral reference for any later migration.

## Assets and reuse

`tools/prepare_assets.py` copies only five already-vendored Quaternius CC0 models and a grass texture into generated engine asset folders, preserving licence notices. No paid or entitlement-restricted store assets are included. Unity uses first-party glTFast (Apache-2.0), URP (Unity terms), and native C# presentation code. Rust uses Rayon, serde, serde_json and tiny_http under their package licences in Cargo.lock; Godot is MIT. No third-party RTS/framework code was copied without a licence.

See [free-engine-ecosystem.md](../../docs/research/free-engine-ecosystem.md) for concrete reusable terrain, camera, RTS-shell, water and animation code, licences and version caveats. Godot is the strongest *free-code reuse* alternative researched; this does not make it the proven visual/performance winner.

## Current full-game baseline

The existing WebGL2 game was started through its normal title/setup UI in a fresh local skirmish and captured in `evidence/current-game.png`. That game has much greater functional scope than the new native clients. The matched comparison is specifically against the previous WebGPU coastal terrain study, now also consuming Rust snapshots; it is not a full-game feature or performance equivalence claim.

## Measurement host

Apple M1, eight CPU cores, 16 GiB RAM, macOS 14.6.1. Rust 1.98.1/Cargo 1.98.1 release mode; Unity 6000.3.11f1 with URP 17.3.0 and glTFast 6.20.0; Godot 4.7.2 Forward+ / Metal; three.js 0.185.1 on WebGPU. Source scripts and package lockfiles pin dependencies. Background Unity editor/compiler and other desktop applications were active during portions of measurement. The first compiler error and render fix were resolved before the final nine captures.
