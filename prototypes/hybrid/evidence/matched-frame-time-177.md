# Matched frame-time measurement — ticket #177 (2026-10-30)

Declared rig: Apple M1, 16 GiB, macOS, 1600×1000, 500 Pops.
Native captures render the frozen reference frame (tick 12636, digest
`68c9dc948474e127`) after 3 s warm-up; frame intervals over ~1000 frames.
Unity runs the denser `f51aba9` scene; Godot/WebGPU run the `33621e4`
baseline scene, so cross-engine numbers are indicative, not a ranking.
Instancing still differs (Unity pooled MeshRenderer + SRP Batcher —
`RenderMeshInstanced` drew nothing in the player; Godot MultiMesh;
WebGPU InstancedMesh).

| Client | Mode | View | p50 ms | p95 ms |
|---|---|---|---|---|
| Unity URP (Metal) | shipped cap 120 fps | A | 8.33 | 8.72 |
| Unity URP (Metal) | shipped cap 120 fps | B | 8.33 | 8.72 |
| Unity URP (Metal) | shipped cap 120 fps | C | 8.34 | 8.72 |
| Unity URP (Metal) | uncapped (target 1000) | A | 7.00 | 11.04 |
| Unity URP (Metal) | uncapped | B | 7.01 / 7.89 | 10.08 / 10.07 |
| Unity URP (Metal) | uncapped | C | 6.98 | 9.71 |
| Godot 4.7.2 Forward+ (Metal) | vsync on | B | 16.70 | 19.30 |
| Godot 4.7.2 Forward+ (Metal) | `--disable-vsync --max-fps 0` | A | 8.37 | 9.74 |
| Godot 4.7.2 Forward+ (Metal) | vsync off | B | 8.39 / 8.37 | 10.11 / 10.03 |
| Godot 4.7.2 Forward+ (Metal) | vsync off | C | 8.45 | 10.13 |
| three.js WebGPU (Chrome headless) | rAF 60 Hz, live sim | A | 16.70 | 17.40 |
| three.js WebGPU | rAF | B | 16.70 | 17.50 (×2) |
| three.js WebGPU | rAF | C | 16.70 | 17.50 |

Findings:
- Both native clients sit in the same uncapped band (p95 ≈ 9.7–11.0 ms)
  at 500 Pops; nothing approaches the 16.7 ms 60 fps budget.
- Godot's vsync-off p50 pinned at ~8.37 ms suggests residual ~120 Hz
  pacing (driver/display), so its true median may be lower.
- Web numbers are display-bound (rAF), not GPU cost; browser frame cost
  is ≤16.7 ms but not separable with this harness.
- Not measured: CPU/GPU split, memory, stretch populations, or the
  sparse-baseline Unity scene uncapped. Frame pacing policy differs per
  client, so treat p95 as the comparable column, loosely.
