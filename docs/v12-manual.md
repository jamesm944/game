# V12 Look-and-Feel Sign-off & Manual Verification (SPEC §7, §8)

Issue #83. Verification of Wayfinder Map 2 (`#69`): full visual overhaul, 3D building models, 8-direction unit sprite atlases, day/night lighting, full military lines, market trade carts, combat juice, and automated screenshot suite.

## 1. Automated Screenshot Suite

Captured via `npm run screenshots:capture` (see `docs/screenshots/README.md`):
- `docs/screenshots/dawn-village.png`: 7:00 AM Dawn, village life, farms, chimney smoke, market, deep Pops.
- `docs/screenshots/field-battle.png`: Midday sun, military lines clash (Longswordsmen, Knights, Paladins, Arbalests), hit flash & death collapse juice.
- `docs/screenshots/night-settlement.png`: Midnight navy lighting, fortified Castle, towers, walls, gates.
- `docs/screenshots/fog-frontier.png`: Scout cavalry probing black unexplored void and grey explored shroud.
- `docs/screenshots/victory-overlay.png`: End-game victory modal over live match state.

All screenshots verified non-empty, high-fidelity (1080p, 1.5 DPR), and completely free of prototype boxes.

## 2. Visual Quality & Aesthetics Checklist

| Visual Feature | Verdict | Verification Details |
| -------------- | ------- | -------------------- |
| 3D Building Models | **Verified** | All 37 building variants rendered with real vertex-colored GLTF models across Dark, Feudal, Castle, Imperial ages; 3D scaffolding for sites under construction. |
| Baked Unit Atlases | **Verified** | All 15 units rendered via instanced vertex-shader billboard atlases across 8 directions; zero invisible units; zero CPU skinning cost. |
| Lighting & Atmosphere | **Verified** | Canonical boot at 7:00 AM dawn; balanced midday sun; midnight navy lighting with ambient lift for perfect nighttime readability; smooth time-of-day transitions. |
| Combat Juice | **Verified** | 4-frame white hit flash on damaged units; death collapse animation + 5-second corpse linger + 1-second alpha fade-out. |
| Ambient Life & Shaders | **Verified** | Instanced chimney smoke billboard particles for houses and blacksmiths; procedural tree foliage wind sway; dynamic water shimmer shader. |
| UI & Selection Polish | **Verified** | Segmented rotating selection rings; order markers; 3D fluttering rally flags with dashed waypoint lines; royal age-up banner; smooth sliding panels. |

## 3. Performance & Draw-Call Verification

Raw benchmark runs recorded via `npx tsx tools/perf-record.ts` across all milestone workloads:

### Workloads Summary
- **M1 Economy:** Mean 3.84 ms, p95 8.30 ms, mirror copy 0.11 ms, draw calls 10.
- **M2 Combat + Fog:** Mean 7.10 ms, p95 15.01 ms, mirror copy 0.19 ms, draw calls 11.
- **M3 Deep-Sim:** Mean 3.13 ms, p95 7.71 ms, mirror copy 0.09 ms, draw calls 10.
- **M4 Management:** Mean 2.63 ms, p95 4.28 ms, mirror copy 0.09 ms, draw calls 10.

*All four budget gates verified passing in CI (`tests/perf/budget*.test.ts`). Draw calls remain strictly ≤11, vastly below the ≤90 typical and ≤150 hard caps.*
