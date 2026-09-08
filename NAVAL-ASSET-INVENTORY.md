# Naval Asset Inventory & Watercraft Specification (SPEC §6 / Map 3)

Research artifact for **Issue #85** (`Research: acquire & inventory CC0 naval and ship 3D models`).  
Branch: `research/naval-assets`  
Author: Antigravity Agent  
Date: September 2026  

Every model and metric listed below was verified against active GLTF/GLB files using `scratch/inspect-naval.ts` with Three.js `GLTFLoader` (vertex and triangle count, bounding dimensions, file sizes, and license files).

---

## 1. CC0 License Verification

All acquired packs are dedicated to the public domain under **CC0 1.0 Universal (Public Domain Dedication)**:
- **Quaternius Ultimate Fantasy RTS**: `src/assets/models/quaternius-ultimate-fantasy-rts/LICENSE.md`
- **Kenney Pirate Kit**: `src/assets/models/kenney-pirate-kit/LICENSE.md` (shipped with original `License.txt`)
- **Kenney Watercraft Kit**: `src/assets/models/kenney-watercraft/LICENSE.md` (shipped with original `License.txt`)

No attribution is legally required, though attribution is retained in `LICENSE.md` for provenance.

---

## 2. Naval Units Inventory

All ship models are low-poly, optimized static meshes suitable for instancing (`InstancedMesh`) or individual rendering with zero skinning overhead.

| Naval Role | Target Entity | Source Pack | Exact File (`src/assets/models/…`) | Tris | Verts | Bounding Size (W × H × D) | Footprint |
|---|---|---|---|---|---|---|---|
| **Fishing Boat** | `fishing-boat` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/boat-row-small.glb` | 130 | 186 | $1.34 \times 0.44 \times 1.80 \text{ m}$ | 1×1 (Water) |
| **Transport Ship (Early)** | `transport-ship` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/boat-row-large.glb` | 174 | 258 | $2.75 \times 0.85 \times 2.85 \text{ m}$ | 1×1 (Water) |
| **Heavy Transport Ship** | `heavy-transport` | Kenney Watercraft | `kenney-watercraft/glTF/ship-cargo-a.glb` | 1,060 | 1,796 | $3.92 \times 3.38 \times 10.55 \text{ m}$ | 2×2 (Water) |
| **Galley / Warship** | `galley` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/ship-small.glb` | 1,370 | 2,158 | $4.80 \times 9.96 \times 8.80 \text{ m}$ | 2×2 (Water) |
| **War Galley / Fire Ship** | `fire-ship` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/ship-medium.glb` | 1,723 | 2,671 | $4.80 \times 9.96 \times 10.60 \text{ m}$ | 2×2 (Water) |
| **Galleon / Cannon Galleon** | `cannon-galleon` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/ship-large.glb` | 1,849 | 2,881 | $4.80 \times 9.96 \times 13.10 \text{ m}$ | 2×2 (Water) |
| **Merchant Cog / Trade Ship** | `trade-cog` | Kenney Watercraft | `kenney-watercraft/glTF/boat-sail-a.glb` | 386 | 624 | $1.78 \times 4.74 \times 3.77 \text{ m}$ | 1×1 (Water) |
| **Pirate Galley (Neutral/Hostile)** | `pirate-galley` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/ship-pirate-small.glb` | 1,461 | 2,447 | $4.80 \times 9.96 \times 8.80 \text{ m}$ | 2×2 (Water) |
| **Pirate Warship** | `pirate-warship` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/ship-pirate-medium.glb` | 1,812 | 3,082 | $4.80 \times 9.96 \times 10.60 \text{ m}$ | 2×2 (Water) |
| **Pirate Frigate** | `pirate-frigate` | Kenney Pirate Kit | `kenney-pirate-kit/glTF/ship-pirate-large.glb` | 1,938 | 3,292 | $4.80 \times 9.96 \times 13.10 \text{ m}$ | 2×2 (Water) |

### Poly Count & Performance Budget Evaluation
- The budget cap for 3D meshes (§7 SPEC) is $\le 150\text{k}$ triangles across the entire active scene.
- Even in a massive 50-ship naval battle ($50 \times 1,500 \text{ tris} = 75,000\text{ tris}$), the geometry consumes only half the GPU triangle budget.
- Combined with `InstancedMesh` draw call batching, all active ships of the same class render in **1 single draw call**.

---

## 3. Shoreline Naval Buildings (Docks & Ports)

Docks span the shoreline boundary, requiring direct land-to-water placement.

| Building Role | Age / Stage | Source Pack | Exact File (`src/assets/models/…`) | Tris | Verts | Bounding Size (W × H × D) | Footprint |
|---|---|---|---|---|---|---|---|
| **Dock (Dark Age)** | Dark Age (Rank 1) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Dock_FirstAge.gltf` | 388 | 560 | $0.52 \times 0.47 \times 1.22 \text{ m}$ | 2×2 Shoreline |
| **Port (Feudal Age)** | Feudal (Level 1) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Port_FirstAge_Level1.gltf` | 3,364 | 6,050 | $1.31 \times 0.97 \times 0.72 \text{ m}$ | 3×3 Shoreline |
| **Port (Castle Age)** | Castle (Level 2) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Port_FirstAge_Level2.gltf` | 4,676 | 8,324 | $1.84 \times 0.97 \times 1.98 \text{ m}$ | 3×3 Shoreline |
| **Port (Imperial Age)** | Imperial (Level 3) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Port_FirstAge_Level3.gltf` | 3,352 | 6,028 | $1.84 \times 0.99 \times 1.98 \text{ m}$ | 3×3 Shoreline |
| **Civ Variant Port L1** | Civ Stage 2 (L1) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Port_SecondAge_Level1.gltf` | 6,672 | 11,362 | $1.75 \times 1.43 \times 2.88 \text{ m}$ | 3×3 Shoreline |
| **Civ Variant Port L2** | Civ Stage 2 (L2) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Port_SecondAge_Level2.gltf` | 7,438 | 13,028 | $2.30 \times 1.25 \times 2.88 \text{ m}$ | 3×3 Shoreline |
| **Civ Variant Port L3** | Civ Stage 2 (L3) | Quaternius Fantasy RTS | `quaternius-ultimate-fantasy-rts/glTF/Port_SecondAge_Level3.gltf` | 8,562 | 14,806 | $2.66 \times 1.63 \times 2.88 \text{ m}$ | 4×4 Shoreline |
| **Pier Platform (Large)** | Modular Pier | Kenney Pirate Kit | `kenney-pirate-kit/glTF/structure-platform-dock.glb` | 324 | 616 | $2.50 \times 1.31 \times 2.51 \text{ m}$ | 2×2 Shoreline |
| **Pier Platform (Small)** | Modular Pier | Kenney Pirate Kit | `kenney-pirate-kit/glTF/structure-platform-dock-small.glb` | 312 | 592 | $1.90 \times 1.31 \times 2.51 \text{ m}$ | 2×2 Shoreline |

---

## 4. Technical Architecture: Shoreline Dock Placement & Berthing

### 4.1 Hybrid Shoreline Footprint Validation
Standard buildings require 100% passable ground tiles (`passable[y * size + x] === 1`). Ships require 100% water tiles (`isWaterTerrain(terrain[y * size + x])`). Docks require a **hybrid shoreline constraint**:
1. For a $3 \times 3$ Dock footprint:
   - At least 2 tiles must be **Land** (Shore, Grass, or Dirt) so villagers can walk up and construct or deposit fish.
   - At least 3 tiles must be **Water** (Water or Deep Water) so ships can navigate and berth.
   - None of the tiles may be impassable cliffs or occupied by existing buildings.
2. Formally in `validatePlacement`:
   ```ts
   if (def.placement === "shoreline") {
     let landTiles = 0;
     let waterTiles = 0;
     for (let dy = 0; dy < h; dy++) {
       for (let dx = 0; dx < w; dx++) {
         const tid = layers.terrainType[(tileY + dy) * layers.size + (tileX + dx)];
         if (isWaterTerrain(tid)) waterTiles++;
         else landTiles++;
       }
     }
     if (landTiles < 2 || waterTiles < 3) {
       return { ok: false, reason: "Dock must be placed on a coastline straddling land and water" };
     }
   }
   ```

### 4.2 Naval Berthing Point
- The dock designates a designated `berthTile` on the water perimeter where constructed ships spawn and fishing boats unload food.
- The rally flag system developed in Map 2 integrates directly to set ship rally destinations into open water.

---

## 5. Technical Architecture: Dynamic Water Wake & Buoyancy

### 5.1 Procedural Water Wake Decal
To create authentic Age of Empires 2 water visual parity without adding separate particle physics:
- **Wake Mesh**: A V-shaped trapezoidal planar quad trailing directly behind each moving ship (`InstancedMesh` with capacity 128).
- **Wake Shader**:
  - UV $x$ coordinate maps across the wake width; $y$ coordinate maps along the trailing distance.
  - Procedural caustic foam pattern:
    $$\text{alpha} = (1.0 - y) \times \sin(x \times 12.0 + \text{time} \times 4.0) \times \text{smoothstep}(1.0, 0.0, |x - 0.5| \times 2.0)$$
  - Renders with `depthWrite: false` and `transparent: true` on the water surface ($Y = \text{waterLevel} + 0.01$).
  - When the ship is stationary (`speed === 0`), the wake smoothly fades to gentle circular ripple rings.

### 5.2 Gentle Buoyancy Sway (Vertex Shader)
- Ships bob slightly with ocean waves using a sinusoidal roll and pitch in the instanced vertex shader:
  $$\Delta Y = \sin(\text{time} \times 2.0 + \text{posX} \times 0.5) \times 0.06\text{ m}$$
  $$\Delta \text{Roll} = \cos(\text{time} \times 1.5 + \text{posZ} \times 0.5) \times 0.03\text{ rad}$$
- Zero CPU overhead: computed entirely in the vertex shader.

---

## 6. Implementation Checklist for Naval Warfare (Map 3 Frontier)

- [x] CC0 naval models acquired and verified (Kenney Pirate Kit + Kenney Watercraft + Quaternius Fantasy RTS).
- [x] Poly counts, bounding boxes, and footprints inventoried in `NAVAL-ASSET-INVENTORY.md`.
- [ ] Define naval unit definitions in `src/data/definitions/units/` (`fishing-boat.json`, `transport-ship.json`, `galley.json`, `fire-ship.json`, `cannon-galleon.json`).
- [ ] Define dock building definitions in `src/data/definitions/buildings/dock.json`.
- [ ] Implement shoreline footprint rule in `src/sim/systems/placement.ts`.
- [ ] Implement water pathfinding grid mask (water tiles passable for ships, impassable for land units).
- [ ] Implement transport ship boarding/unboarding activity in `src/sim/systems/transport.ts`.
- [ ] Create instanced ship renderer layer and dynamic wake shader in `src/render/navalModels.ts`.
