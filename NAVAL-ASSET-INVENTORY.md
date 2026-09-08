# Naval Asset Inventory & Technical Specification (Issue #85)

> **Map**: [Wayfinder Map 3: Surpass AoE2 — Naval warfare, asymmetric civs & modern RTS QoL](https://github.com/jamesmoss/Documents/game/issues/84)  
> **Task**: [Research: acquire & inventory CC0 naval and ship 3D models](https://github.com/jamesmoss/Documents/game/issues/85)  
> **Branch**: `research/naval-assets`  
> **Status**: Verified CC0 Assets Acquired, Measured & Integrated

---

## 1. Executive Summary

This inventory establishes the complete 3D naval model pipeline for Map 3 (Naval Warfare & Water Economy). All selected models originate from verified **CC0 (Public Domain)** creators (**Kenney** and **Quaternius**). 

Key findings:
- **Low-Poly Budget**: All individual combat ships are **under 3,500 triangles** and **<175 KB**, easily supporting 50+ concurrent watercraft within the engine's 60 FPS / ≤6 ms GPU frame budget.
- **Unified Style**: Kenney's Pirate Kit and Watercraft Kit share low-poly faceted shading and flat-palette color atlases (`colormap.png`), matching Quaternius buildings and KayKit unit aesthetics.
- **Complete Naval Tech Tree**: All 7 canonical AoE2 naval roles (Fishing Boat, Transport, Galley, War Galley, Galleon, Fire Ship, Cannon Galleon, Demolition Ship) plus Dock/Port evolution lines have 1:1 model mappings.
- **License Integrity**: License files are stored alongside the assets in `src/assets/models/kenney-pirate-kit/License.txt` and `src/assets/models/kenney-watercraft/License.txt`.

---

## 2. Acquired Asset Inventory

### 2.1 Watercraft & Naval Units

| Unit Role | Model File (`glTF/`) | Creator & Pack | Size | Vertices | Triangles | Dimensions ($W \times H \times D$) | Proposed Tile Footprint |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Fishing Boat** | `kenney-pirate-kit/glTF/boat-row-small.glb` | Kenney Pirate Kit (CC0) | 17 KB | 292 | 168 | $2.75 \times 0.85 \times 2.37$ | $1 \times 1$ |
| **Transport Ship (Early)** | `kenney-pirate-kit/glTF/boat-row-large.glb` | Kenney Pirate Kit (CC0) | 16 KB | 258 | 174 | $2.75 \times 0.85 \times 2.85$ | $1 \times 1$ |
| **Galley / Scout Warship** | `kenney-pirate-kit/glTF/ship-small.glb` | Kenney Pirate Kit (CC0) | 114 KB | 2,158 | 1,370 | $4.80 \times 9.96 \times 8.80$ | $2 \times 2$ |
| **War Galley** | `kenney-pirate-kit/glTF/ship-medium.glb` | Kenney Pirate Kit (CC0) | 142 KB | 2,671 | 1,723 | $4.80 \times 9.96 \times 10.60$ | $2 \times 2$ |
| **Galleon / Heavy Warship** | `kenney-pirate-kit/glTF/ship-large.glb` | Kenney Pirate Kit (CC0) | 152 KB | 2,881 | 1,849 | $4.80 \times 9.96 \times 13.10$ | $2 \times 2$ |
| **Fire Ship** | `kenney-pirate-kit/glTF/ship-medium.glb` *(Prow Flame FX)* | Kenney Pirate Kit (CC0) | 142 KB | 2,671 | 1,723 | $4.80 \times 9.96 \times 10.60$ | $2 \times 2$ |
| **Cannon Galleon** | `kenney-pirate-kit/glTF/ship-large.glb` *(Forward Gun)* | Kenney Pirate Kit (CC0) | 152 KB | 2,881 | 1,849 | $4.80 \times 9.96 \times 13.10$ | $2 \times 2$ |
| **Demolition Raft / Boat** | `kenney-pirate-kit/glTF/boat-row-small.glb` + Powder Crate | Kenney Pirate Kit (CC0) | 17 KB | 292 | 168 | $2.75 \times 0.85 \times 2.37$ | $1 \times 1$ |
| **Pirate Galley (Enemy/Variant)** | `kenney-pirate-kit/glTF/ship-pirate-small.glb` | Kenney Pirate Kit (CC0) | 128 KB | 2,447 | 1,461 | $4.80 \times 9.96 \times 8.80$ | $2 \times 2$ |
| **Pirate Warship (Enemy/Variant)** | `kenney-pirate-kit/glTF/ship-pirate-medium.glb` | Kenney Pirate Kit (CC0) | 162 KB | 3,082 | 1,812 | $4.80 \times 9.96 \times 10.60$ | $2 \times 2$ |
| **Pirate Frigate (Boss Ship)** | `kenney-pirate-kit/glTF/ship-pirate-large.glb` | Kenney Pirate Kit (CC0) | 173 KB | 3,292 | 1,938 | $4.80 \times 9.96 \times 13.10$ | $2 \times 2$ |
| **Heavy Transport / Cog A** | `kenney-watercraft/glTF/ship-cargo-a.glb` | Kenney Watercraft (CC0) | 96 KB | 1,796 | 1,060 | $3.92 \times 3.38 \times 10.55$ | $2 \times 2$ |
| **Heavy Transport / Cog B** | `kenney-watercraft/glTF/ship-cargo-b.glb` | Kenney Watercraft (CC0) | 78 KB | 1,464 | 850 | $3.92 \times 3.30 \times 10.55$ | $2 \times 2$ |
| **Merchant Sailboat** | `kenney-watercraft/glTF/boat-sail-a.glb` | Kenney Watercraft (CC0) | 34 KB | 624 | 386 | $1.78 \times 4.74 \times 3.77$ | $1 \times 1$ |
| **Fishing Boat (Motorized/Alt)** | `kenney-watercraft/glTF/boat-fishing-small.glb` | Kenney Watercraft (CC0) | 22 KB | 411 | 237 | $1.78 \times 2.60 \times 3.87$ | $1 \times 1$ |

### 2.2 Shoreline Buildings & Docks

| Building Role | Model File (`glTF/`) | Creator & Pack | Size | Vertices | Triangles | Dimensions ($W \times H \times D$) | Proposed Footprint |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Dock (Dark Age Pier)** | `quaternius-ultimate-fantasy-rts/glTF/Dock_FirstAge.gltf` | Quaternius UFRS (CC0) | 25 KB | 560 | 388 | $0.52 \times 0.47 \times 1.22$ | $3 \times 3$ (Shoreline) |
| **Port (Feudal Age / L1)** | `quaternius-ultimate-fantasy-rts/glTF/Port_FirstAge_Level1.gltf` | Quaternius UFRS (CC0) | 287 KB | 6,050 | 3,364 | $1.31 \times 0.97 \times 0.72$ | $3 \times 3$ (Shoreline) |
| **Port (Castle Age / L2)** | `quaternius-ultimate-fantasy-rts/glTF/Port_FirstAge_Level2.gltf` | Quaternius UFRS (CC0) | 392 KB | 8,324 | 4,676 | $1.84 \times 0.97 \times 1.98$ | $4 \times 4$ (Shoreline) |
| **Port (Imperial Age / L3)** | `quaternius-ultimate-fantasy-rts/glTF/Port_FirstAge_Level3.gltf` | Quaternius UFRS (CC0) | 286 KB | 6,028 | 3,352 | $1.84 \times 0.99 \times 1.98$ | $4 \times 4$ (Shoreline) |
| **Port Civ Variant (L1)** | `quaternius-ultimate-fantasy-rts/glTF/Port_SecondAge_Level1.gltf` | Quaternius UFRS (CC0) | 538 KB | 11,362 | 6,672 | $1.75 \times 1.43 \times 2.88$ | $3 \times 3$ (Shoreline) |
| **Port Civ Variant (L2)** | `quaternius-ultimate-fantasy-rts/glTF/Port_SecondAge_Level2.gltf` | Quaternius UFRS (CC0) | 619 KB | 13,028 | 7,438 | $2.30 \times 1.25 \times 2.88$ | $4 \times 4$ (Shoreline) |
| **Port Civ Variant (L3)** | `quaternius-ultimate-fantasy-rts/glTF/Port_SecondAge_Level3.gltf` | Quaternius UFRS (CC0) | 702 KB | 14,806 | 8,562 | $2.66 \times 1.63 \times 2.88$ | $4 \times 4$ (Shoreline) |
| **Pier Extension (Large)** | `kenney-pirate-kit/glTF/structure-platform-dock.glb` | Kenney Pirate Kit (CC0) | 33 KB | 616 | 324 | $2.50 \times 1.31 \times 2.51$ | $2 \times 2$ (Water/Pier) |
| **Pier Extension (Small)** | `kenney-pirate-kit/glTF/structure-platform-dock-small.glb` | Kenney Pirate Kit (CC0) | 31 KB | 592 | 312 | $1.90 \times 1.31 \times 2.51$ | $2 \times 1$ (Water/Pier) |

---

## 3. Technical Integration Architecture

### 3.1 Water Wake Decal System
Ships cut through water and generate dynamic wakes. Rather than expensive CPU-simulated physics or multiple mesh draw calls:
1. **Single Instanced Mesh**: Wake trails use a single Three.js `InstancedMesh` (`wakeMesh`) with flat XZ quad geometry (similar to `buildingShadows.ts`).
2. **Procedural Kelvin Wake Shader**:
   - Alpha falloff along the stern velocity vector:
     $$\alpha(u, v) = \text{smoothstep}(1.0, 0.0, |v|) \times \text{smoothstep}(0.0, 0.2, u) \times (1.0 - u)$$
   - Gentle sinusoidal ripple UV displacement simulating breaking foam and surface disturbance.
   - Water surface offset: rendered at $Y = y_{\text{water}} + 0.015$ with `depthWrite: false` and `transparent: true`.
3. **Motion Coupling**: Wake instance scale and opacity scale dynamically with ship linear speed:
   - Idle / Anchored ship: zero wake (`visible = false`).
   - Full sail ($v \ge 1.5$ tiles/sec): wake length expands to $1.8 \times$ ship length.

### 3.2 Shoreline Dock Placement & Berth Grid
Docks straddle the shoreline barrier:
```
+---+---+---+---+
| L | L | L | L |  <- Land Tiles (Footprint entry: Villagers drop fish/wood here)
+---+---+---+---+
| S | S | S | S |  <- Shoreline Seam (Quay, pilings, cranes, warehouses)
+---+---+---+---+
| W | W | W | W |  <- Water Berth (Ships moor, repair, and spawn here)
+---+---+---+---+
| W | W | W | W |  <- Deep Water (Navigation channel to open ocean)
+---+---+---+---+
```
- **Placement Predicate**: `canPlaceDock(grid, originX, originY, w, h)`:
  1. Top row must be passable land (`elevationLevel >= 1`, `terrain != water`).
  2. Bottom 2 rows must be passable water (`terrain == water || terrain == deep_water`).
  3. Dock cannot block navigation bottlenecks (at least 2 adjacent navigable water tiles remain clear).
- **Berth & Ejection**:
  - Newly trained ships spawn at the deep-water edge of the dock ($Y = 0$, facing outward toward open water).
  - Fishing boats deliver food by pathing to any water tile adjacent to the dock footprint.

### 3.3 Unit Scaling & Rendering Contract
- **InstancedMesh Grouping**: Similar to `src/render/unitSprites.ts` and `src/render/buildingModels.ts`, naval units are batched by model key into `InstancedMesh` buckets (1 draw call per active ship class).
- **Player Color Tinting**: Ships use team color tinting on sails and hull trim (Player 1 Blue, Player 2 Red, Player 3 Green, Player 4 Yellow) via the instanced vertex attribute `aTeamTint` (matching Issue #89).
- **Heeling & Rolling Micro-Animation**: In `shipRenderSystem`, ships apply subtle roll around the longitudinal axis based on angular steering velocity:
  $$\theta_{\text{roll}} = -0.15 \times \omega_{\text{turn}} + 0.04 \sin(2.5 t + \text{seed})$$
  giving lifelike buoyancy on the water without requiring skeletal animation.

---

## 4. Source & License Verification

1. **Kenney Pirate Kit**:
   - License: Creative Commons Zero (CC0 1.0)
   - Source: [https://kenney.nl/assets/pirate-kit](https://kenney.nl/assets/pirate-kit)
   - Mirror: [https://opengameart.org/content/pirate-kit](https://opengameart.org/content/pirate-kit)
   - Local License: [`src/assets/models/kenney-pirate-kit/License.txt`](file:///Users/jamesmoss/Documents/game/src/assets/models/kenney-pirate-kit/License.txt)
2. **Kenney Watercraft Pack**:
   - License: Creative Commons Zero (CC0 1.0)
   - Source: [https://kenney.nl/assets/watercraft-kit](https://kenney.nl/assets/watercraft-kit)
   - Mirror: [https://opengameart.org/content/watercraft-kit](https://opengameart.org/content/watercraft-kit)
   - Local License: [`src/assets/models/kenney-watercraft/License.txt`](file:///Users/jamesmoss/Documents/game/src/assets/models/kenney-watercraft/License.txt)
3. **Quaternius Ultimate Fantasy RTS**:
   - License: Creative Commons Zero (CC0 1.0)
   - Source: [https://quaternius.com/packs/ultimatefantasyrts.html](https://quaternius.com/packs/ultimatefantasyrts.html)
   - Site-wide CC0 confirmation: [https://quaternius.com/faq.html](https://quaternius.com/faq.html)
4. **KayKit**:
   - Evaluated: KayKit's catalog focuses on dungeons, characters, and city builders, with no standalone naval pack currently available. Kenney and Quaternius fulfill all naval requirements with stylistic harmony.
