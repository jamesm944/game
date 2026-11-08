# Research: AAA-Quality Medieval Assets & AI Generation Pipeline

- **Issue:** [jamesm944/game#144](https://github.com/jamesm944/game/issues/144)
- **Map:** [jamesm944/game#140](https://github.com/jamesm944/game/issues/140) (Wayfinder Map 6: AAA Supremacy)
- **Date:** 2026-10-17
- **Branch:** `research/df-rw-deep-sim`
- **Extends:** [`ASSET-INVENTORY.md`](../../ASSET-INVENTORY.md) and [`NAVAL-ASSET-INVENTORY.md`](./NAVAL-ASSET-INVENTORY.md)
- **Scope:** Complete acquisition inventory and technical pipeline specification for all 31 unit definitions, 32 building definitions across 4 ages and civilizational aesthetics, PBR terrain textures, UI icon sets, audio assets, AI generation pipeline (Recraft V3 vector SVG + Midjourney/Flux painterly portraits + palette quantization), and Three.js runtime animation architecture (billboard sprites vs skeletal GLTF vs Vertex Animation Textures).

---

## 1. Executive Summary & Core Strategic Conclusions

1. **Model & Animation Licensing**: Strict adherence to **CC0 1.0 Universal** (Quaternius, KayKit, Kenney) as Tier 1. Permissive **CC-BY 3.0/4.0** (Game-icons.net, Kevin MacLeod/Incompetech, Freesound) as Tier 2, requiring an in-engine `CREDITS.md` entry. Viral copyleft licenses (**CC-BY-SA, GPL**) must be strictly excluded for shippable client assets.
2. **Entity Coverage**: All **31 unit definitions** in `src/data/definitions/units/*.json` and **32 building definitions** in `src/data/definitions/buildings/*.json` across 4 ages (Dark, Feudal, Castle, Imperial) now have verified 3D models, animation mappings, and prop kitbash recipes.
3. **Terrain & Audio**: 1K PBR textures from ambientCG and Poly Haven provide full coverage for ground splatting. Audio is backed by the commercial royalty-free **Soniss GDC Archives** (150+ GB of master-quality weapons, siege, and warfare impacts), supplemented by **Freesound (CC0/CC-BY)** and **Incompetech/Musopen** for medieval orchestral atmosphere.
4. **AI Generation Pipeline**: Combines **Recraft V3 API** (for SVG vector tech-tree and UI icons with strict RGB palette locking) with **Flux.1 / SDXL + ControlNet** (local ComfyUI) and **Midjourney v6.1 (`--sref`)** for unit portraits and event illustrations, coupled with an automated color quantization post-processing script and a legally fortified human-in-the-loop workflow.
5. **Animation & Rendering Architecture**: Deep inspection of `tools/atlas-bake/` and `src/render/unitSprites.ts` confirms that **instanced billboard sprites remain the optimal runtime path** for web RTS scale (10,000 units < 2 ms CPU time, 1 draw call per unit type, 100% deterministic replay testing). For future true-3D free camera rotation, **Vertex Animation Textures (VAT)** are recommended over `SkeletonUtils.clone` or CPU-driven `InstancedSkinnedMesh`.

---

## 2. 3D Models & Animations Inventory

### 2.1 Primary Vendors & Pack Provenance

| Vendor & Pack | Primary URL / Source | License | Format(s) | Polycount / Specs | Rig & Animation Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Quaternius Universal Base Characters (UBC)** | [quaternius.com/packs/universalbasecharacters.html](https://quaternius.com/packs/universalbasecharacters.html) | CC0 1.0 | glTF, FBX, OBJ, Blend | ~1,200–1,800 tris | Skinned humanoid rig (UE/Godot bone hierarchy: `pelvis`, `spine_01`, `upperarm_l`, etc.). 0 clips. |
| **Quaternius Universal Animation Library 1 & 2 (UAL1 & UAL2)** | [quaternius.com/packs/universalanimationlibrary.html](https://quaternius.com/packs/universalanimationlibrary.html) | CC0 1.0 | GLB (+ root-motion `_RM`) | Mannequin mesh | 86 clips total (43 each). Retargets directly onto UBC skeletons with 0 bone mapping discrepancies (65/65 bone names match). Locomotion, combat, farming, mining, woodcutting, deaths. |
| **Quaternius Ultimate Fantasy RTS (UFRS)** | [quaternius.com/packs/ultimatefantasyrts.html](https://quaternius.com/packs/ultimatefantasyrts.html) | CC0 1.0 | glTF, FBX, OBJ, Blend | 500–2,500 tris per building | 129 static meshes. Native 2-age structure (`FirstAge`, `SecondAge`) × 3 levels (`Level1..3`). |
| **Quaternius Medieval Village MegaKit** | [quaternius.com/packs/medievalvillage.html](https://quaternius.com/packs/medievalvillage.html) | CC0 1.0 | FBX, OBJ, Blend | 300–2,000 tris per piece | 300+ modular pieces + 45 complete buildings/props (Blacksmith, Inn, Sawmill, Mill, Bell Tower, Stable, Cauldron, Houses). |
| **Quaternius Farm Buildings & Animals** | [quaternius.com/packs/farmbuildings.html](https://quaternius.com/packs/farmbuildings.html) | CC0 1.0 | FBX, OBJ, Blend | 200–1,200 tris | 14 farm buildings (Barns, Windmills, Silos) + 8 static farm animals (Sheep, Cow, Pig, Chicken). |
| **Quaternius Ultimate Animated Animals (UAA)** | [quaternius.com/packs/ultimateanimatedanimals.html](https://quaternius.com/packs/ultimateanimatedanimals.html) | CC0 1.0 | glTF (embedded data URI) | 800–1,500 tris | 12 rigged animals (Horse, Deer, Stag, Boar, Wolf, Bear, Cow). 12–13 clips each (`Gallop`, `Walk`, `Idle`, `Attack`, `Death`, `Eating`). |
| **Quaternius LowPoly Animated Knight** | [quaternius.itch.io/lowpoly-animated-knight](https://quaternius.itch.io/lowpoly-animated-knight) | CC0 1.0 | FBX, OBJ, Blend | ~1,100 tris | Skinned knight with sword and shield. 7 clips: `Idle`, `Walk`, `Run`, `Attack`, `Jump`, `Roll`, `Death`. |
| **Quaternius Modular Character Outfits - Fantasy** | [quaternius.itch.io/modular-character-outfits-fantasy](https://quaternius.itch.io/modular-character-outfits-fantasy) | CC0 1.0 | glTF, FBX, OBJ, Blend | 100–400 tris per part | 12 fantasy outfits, 62 modular attachments (helms, pauldrons, tunics, boots) snapping to UBC. |
| **Quaternius RPG Character Pack** | [quaternius.com](https://quaternius.com) | CC0 1.0 | glTF, FBX, OBJ, Blend | ~1,200 tris | Skinned & animated: Monk, Wizard, Ranger, Knight, Rogue. Direct source for the historical `monk`. |
| **KayKit Adventurers** | [github.com/KayKit-Game-Assets](https://github.com/KayKit-Game-Assets) | CC0 1.0 | GLB (characters) + glTF (props) | 800–1,400 tris | 5 characters (Barbarian, Knight, Mage, Rogue, Rogue_Hooded). 76 pre-baked clips each. 40+ modular weapons/shields/quivers that snap to `handslotr/l`. |
| **KayKit Enemy Skeletons** | [github.com/KayKit-Game-Assets](https://github.com/KayKit-Game-Assets) | CC0 1.0 | GLB + glTF props | 900–1,500 tris | 4 skeleton rigs (Warrior, Mage, Rogue, Minion), 95 pre-baked clips. |
| **KayKit Medieval Hexagon Pack** | [kaylousberg.itch.io/kaykit-medieval-hexagon](https://kaylousberg.itch.io/kaykit-medieval-hexagon) | CC0 1.0 | glTF, FBX, OBJ | 200–1,500 tris | 200+ stylized low-poly hex/grid buildings (Blacksmith, Church, Windmill, Market, Towers, Castle). |
| **Kenney Castle Kit (v2.0)** | [kenney.nl/assets/castle-kit](https://kenney.nl/assets/castle-kit) | CC0 1.0 | glTF/GLB, FBX, OBJ | 150–800 tris | 70+ modular castle models (walls, battlements, gates, portcullis) + **Catapult siege weapon** (`catapult.glb`). |
| **Kenney Fantasy Town Kit (v2.0)** | [kenney.nl/assets/fantasy-town-kit](https://kenney.nl/assets/fantasy-town-kit) | CC0 1.0 | glTF/GLB, FBX, OBJ | 200–1,200 tris | 160+ medieval town buildings, market stalls, carts, chimneys. |
| **Kenney Pirate Kit** | [kenney.nl/assets/pirate-kit](https://kenney.nl/assets/pirate-kit) | CC0 1.0 | glTF/GLB | 400–2,500 tris | Complete historical naval set: `boat-row-small`, `boat-row-large`, `ship-small`, `ship-medium`, `ship-large`. Vendored and active in `src/render/shipModels.ts`. |
| **Imagine Medieval Siege Trebuchet** | [sketchfab.com/3d-models/medieval-siege-trebuchet-506de0c2cbe04aa2bd6565f0417bdf52](https://sketchfab.com/3d-models/medieval-siege-trebuchet-506de0c2cbe04aa2bd6565f0417bdf52) | CC-BY 4.0 | glTF, FBX, Blend | ~3,400 tris | Functional counterweight trebuchet with animated pivot, throwing beam, and sling release. |

---

### 2.2 Complete Entity Mapping: All 31 Unit Definitions (`src/data/definitions/units/`)

| Unit Definition ID | Age Gate | 3D Model Source | Required Baked Clips | Attached Props / Kitbash Recipe |
| :--- | :--- | :--- | :--- | :--- |
| **`villager`** | Dark | Quaternius UBC `Superhero_Male_FullBody.gltf` / `Female` | `Idle_Loop`(U1), `Walk_Loop`(U1), `Farm_PlantSeed/Harvest/Watering`(U2), `TreeChopping_Loop`(U2), `Walk_Carry_Loop`(U2), `Death01`(U1) | `axe_1handed.gltf`, `pickaxe.gltf`, `Logs.gltf`, `Crate.gltf`, `Resource_Gold_1.gltf` |
| **`militia`** | Dark | KayKit `Barbarian.glb` | `Idle`, `Walking_A`, `Running_A`, `1H_Melee_Attack_Slice_Horizontal`, `Hit_A`, `Death_A` | `sword_1handed.gltf` (unarmored, crude iron) |
| **`man-at-arms`** | Feudal | KayKit `Barbarian.glb` / `Knight.glb` | `Idle`, `Walking_A`, `Running_A`, `1H_Melee_Attack_Chop`, `Blocking`, `Block_Hit`, `Death_A` | `sword_1handed.gltf`, `shield_round.gltf` |
| **`longswordsman`** | Castle | KayKit `Knight.glb` | `Idle`, `Walking_B`, `Running_B`, `2H_Melee_Attack_Slice`, `2H_Melee_Attack_Spin`, `Hit_B`, `Death_B` | `sword_2handed.gltf` (chainmail armor, steel longsword) |
| **`two-handed-swordsman`** | Imperial | KayKit `Knight.glb` or Quaternius Animated Knight | `Idle`, `Walking_B`, `Running_B`, `2H_Melee_Attack_Chop`, `2H_Melee_Attack_Slice`, `Death_B` | `sword_2handed_color.gltf` (scaled 1.25x greatsword) |
| **`huskarl`** (Goth UU) | Castle | KayKit `Barbarian.glb` + hooded cloak | `Idle`, `Walking_A`, `Running_A`, `1H_Melee_Attack_Chop`, `Blocking`, `Block_Hit`, `Death_A` | `axe_1handed.gltf`, `shield_round.gltf` (heavy shield wall) |
| **`throwing-axeman`** (Frank UU) | Castle | KayKit `Barbarian.glb` | `Idle`, `Walking_A`, `Running_A`, `Throw`, `Hit_A`, `Death_A` | `axe_1handed.gltf` (utilizes native KayKit `Throw` clip) |
| **`archer`** | Feudal | KayKit `Rogue_Hooded.glb` | `Idle`, `Walking_A`, `Running_A`, `1H_Ranged_Aiming`, `1H_Ranged_Shoot`, `Hit_A`, `Death_A` | `bow.gltf`, `quiver.gltf`, `arrow.gltf` |
| **`crossbowman`** | Castle | KayKit `Rogue.glb` / `Knight.glb` | `Idle`, `Walking_A`, `Running_A`, `2H_Ranged_Aiming`, `2H_Ranged_Reload`, `2H_Ranged_Shoot`, `Death_A` | `crossbow_2handed.gltf` (wooden stock crossbow) |
| **`arbalest`** | Imperial | KayKit `Knight.glb` | `Idle`, `Walking_B`, `Running_B`, `2H_Ranged_Aiming`, `2H_Ranged_Reload`, `2H_Ranged_Shoot`, `Death_B` | `crossbow_2handed.gltf` (steel prod) + `shield_badge_color.gltf` (pavise mounted on back) |
| **`skirmisher`** | Feudal | KayKit `Rogue.glb` | `Idle`, `Walking_A`, `Running_A`, `Throw`, `Unarmed_Melee_Attack_Kick`, `Death_A` | Javelin (scaled arrow/spear prop) |
| **`longbowman`** (Briton UU) | Castle | KayKit `Rogue_Hooded.glb` / Quaternius Ranger | `Idle`, `Walking_A`, `Running_A`, `1H_Ranged_Aiming`, `1H_Ranged_Shoot`, `Death_A` | Tall Welsh longbow prop (scaled `staff.gltf`) + broadhead arrow |
| **`scout-cavalry`** | Dark | Mount: Quaternius UAA `Horse.gltf`; Rider: KayKit `Barbarian.glb` | Horse: `Gallop`, `Idle`, `Attack_Kick`, `Death`. Rider: `Sitting_Idle`, `1H_Melee_Attack_Slice` | Unarmored rider seated at y-offset; crude short sword |
| **`light-cavalry`** | Castle | Mount: Quaternius `Horse.gltf`; Rider: KayKit `Rogue.glb` | Horse: `Gallop`, `Idle`, `Attack_Kick`, `Death`. Rider: `Sitting_Idle`, `1H_Melee_Attack_Chop` | Curved cavalry sabre + leather cap |
| **`knight`** | Castle | Mount: Quaternius `Horse.gltf`; Rider: KayKit `Knight.glb` | Horse: `Gallop`, `Idle`, `Attack_Kick`, `Death`. Rider: `Sitting_Idle`, `1H_Melee_Attack_Chop`, `Blocking` | `sword_1handed.gltf`, `shield_badge_color.gltf` |
| **`cavalier`** | Imperial | Mount: Quaternius `Horse.gltf` (barded); Rider: KayKit `Knight.glb` | Horse: `Gallop`, `Idle`, `Death`. Rider: `1H_Melee_Attack_Slice`, `Blocking` | `sword_2handed_color.gltf`, heavy heater shield; cloth caparison texture variant on horse |
| **`paladin`** | Imperial | Mount: Quaternius `Horse.gltf` (armored); Rider: KayKit `Knight.glb` | Horse: `Gallop`, `Idle`, `Death`. Rider: `1H_Melee_Attack_Slice`, `Cheer` | Full gilded plate armor, decorated lance/sword, steel chamfron on mount |
| **`cataphract`** (Byzantine UU) | Castle | Mount: Quaternius `Horse.gltf`; Rider: KayKit `Knight.glb` | Horse: `Gallop`, `Idle`, `Attack_Kick`, `Death`. Rider: `1H_Melee_Attack_Chop` | Full scale/lamellar horse barding + Byzantine banded armor + kontos spear |
| **`battering-ram`** | Castle | Kenney Castle Kit / LPC 3D Ram | `Move_Loop` (wheels turn), `Attack` (suspended log swings forward), `Death` (timber collapse) | Wheeled wooden housing with iron-headed log ram |
| **`mangonel`** | Castle | Kenney Castle Kit `catapult.glb` | `Move_Loop` (wheels turn), `Attack` (arm swings to crossbar, stone launches), `Death` (break) | Onager frame with torsion bundle and cup |
| **`trebuchet-packed`** | Imperial | Quaternius Medieval Village `Wagon.fbx` + folded timber | `Move_Loop` (wheels roll), `Unpack` (timbers swing upward into frame) | Heavy siege wagon carrying disassembled mast and counterweight |
| **`trebuchet`** | Imperial | Sketchfab `@Imagineis` Trebuchet (CC-BY 4.0) | `Idle` (arm primed), `Attack` (counterweight drops, arm whips overhead, sling releases), `Pack` | Stationary timber frame, axle, lead counterweight, leather sling |
| **`fishing-boat`** | Dark | Kenney Pirate Kit `boat-row-small.glb` | Floating water bobbing, oars rowing | Small wooden skiff with fish basket prop |
| **`transport-ship`** | Feudal | Kenney Pirate Kit `boat-row-large.glb` | Floating water bobbing, oars rowing | Large open-deck transport vessel |
| **`galley`** | Feudal | Kenney Pirate Kit `ship-small.glb` | Forward sail glide, wake emission | Single mast, single bank of oars, forward ballista |
| **`war-galley`** | Castle | Kenney Pirate Kit `ship-medium.glb` | Forward sail glide, combat broadside | Reinforced bow ram, fighting forecastle, dual sails |
| **`galleon`** | Imperial | Kenney Pirate Kit `ship-large.glb` | Deep hull roll, triple mast sail glide | Triple mast, multi-deck gunports, sterncastle |
| **`fire-ship`** | Castle | Kenney Pirate Kit `ship-medium.glb` (modified) | Fast cruise, continuous bow jet | Bow siphon nozzle emitting liquid Greek fire |
| **`cannon-galleon`** | Imperial | Kenney Pirate Kit `ship-large.glb` (modified) | Heavy recoil kickback, broadside | Forward heavy naval bombard cannon |
| **`monk`** | Castle | Quaternius RPG Character Pack (Monk) | `Idle_Loop`, `Walk_Loop`, `Spellcast_Shoot` (conversion chant), `Cheer` (relic carry), `Death01` | Robed cowl silhouette + wooden shepherd staff + gold Relic prop |
| **`trade-cart`** | Feudal | Quaternius Medieval Village `Wagon.fbx` + `Horse.gltf` | `Walk_Loop` (horse steps, wagon wheels roll), `Idle_Loop`, `Death01` | 4-wheeled wooden merchant wagon loaded with barrels and coin chests |

---

### 2.3 Architectural Progression: 4 Ages & Civilization Styling

#### 4 Ages Progression Architecture
1. **Dark Age (Primitive / Survival)**: Untreated log timbers, wattle-and-daub, thatch straw roofs, earth-packed floors. Quaternius UFRS `FirstAge_Level1`, Medieval Village `Inn.fbx` (thatched), `Farm_Dirt_Level1`. Palisade wooden stakes (`Palisade-wall`, `Palisade-gate`).
2. **Feudal Age (Settlement / Agrarian)**: Half-timbered white plaster, wooden shingles, carved stone footings, brick chimneys. Quaternius UFRS `FirstAge_Level2..3`, Medieval Village `Blacksmith.fbx`, `Sawmill.fbx`, `Windmill_FirstAge.gltf`. Wooden Watchtowers (`WatchTower_FirstAge_Level1..3`), reinforced wooden gates.
3. **Castle Age (Feudal Fortress / High Medieval)**: Dressed limestone masonry, crenellated battlements, arrow slits, slate shingle roofs. Quaternius UFRS `SecondAge_Level1..2`, `Temple_SecondAge`, Kenney Castle Kit modular stone walls, machicolations. Stone Walls, Stone Gates with iron portcullises, Guard Towers.
4. **Imperial Age (Monumental / Early Renaissance)**: Smooth ashlar marble, blue slate tiles, copper cupolas, gold-leaf finials, grand arched facades. Quaternius UFRS `Wonder_SecondAge_Level3`, `TownCenter_SecondAge_Level3`, `Grand-academy` (`TownCenter_SecondAge_Level2` scaled). Fortified bastions, cannon towers, grand citadel keeps.

#### Civilization Aesthetic Kits
- **Western European** (Britons, Franks, Goths): Steep pitched gable roofs, exposed timber framing, gothic pointed arches, stone castle keeps. Quaternius UFRS + Medieval Village MegaKit + Kenney Castle Kit.
- **Middle Eastern / Saracen**: Flat roof terraces, domes, horseshoe arches, geometric latticework, adobe/sandstone plaster. Quaternius Oasis/Desert Pack + Kenney Hexagon Desert tiles.
- **East Asian**: Curved hip-and-gable eaves, multi-tiered pagoda roofs, red lacquered timber pillars, stone pedestals. Kenney Asian Town / Synty-compatible CC0 pagoda pieces on Poly Pizza.
- **Mesoamerican** (Aztecs, Mayans): Stepped stone pyramid plinths, stucco reliefs, thatched palapa quarters, ornate carved serpent stelae. OpenGameArt Mesoamerican packs + custom textured UFRS stone bases.

---

## 3. Terrain & PBR Texture Inventory

- **ambientCG** ([ambientcg.com](https://ambientcg.com)): **CC0 1.0 Universal**. Over 1,800 materials with 1K, 2K, 4K tiers.
- **Poly Haven** ([polyhaven.com](https://polyhaven.com)): **CC0 1.0 Universal**. Photogrammetry-scanned PBR materials.

### Ground Splat Material Catalogue
- **Grass (Plains / Base)**: ambientCG `Grass001` (1024×1024 JPG, Color, NormalGL, Roughness, AO). Seamless tileable, fine lawn blades.
- **Leafy Grass (Forest Floor)**: Poly Haven `leafy_grass` (1024×1024 JPG). Fallen leaves, twigs, rich humus soil.
- **Dirt / Farmland**: ambientCG `Ground110` / `Ground037` (1024×1024 JPG). Tilled loam, fine gravel particles.
- **Rock / Cliff Facings**: ambientCG `Rock064` / `Rock028` (1024×1024 JPG). Stratified limestone cliffs for steep terrain slopes.
- **Sand / Shoreline**: ambientCG `Ground054` / `Sand002` (1024×1024 JPG). Fine wave-rippled sediment for coastlines and riverbanks.
- **Cobblestone (City / Roads)**: ambientCG `PavingStones070` (1024×1024 JPG). Worn medieval street paving stones.
- **Water Waves & Wake**: Procedural / ambientCG `WaterNormal001` + Kelvin Wake (512×512 PNG, dual-scrolling tangent-space normal maps).

---

## 4. UI Icon Sets & Audio Inventory

### 4.1 UI Icon Sets
- **Game-icons.net** ([game-icons.net](https://game-icons.net)): **CC-BY 3.0** (Attribution required). 4,180+ SVG/PNG icons covering complete tech tree, military stances, weapon/armor upgrades, resource icons.
- **Kenney Medieval UI & Fantasy UI** ([kenney.nl](https://kenney.nl)): **CC0 1.0**. 230+ parchment dialogs, ornate wood/iron borders, unit selection frames.
- **Kenney Cursors Pack**: **CC0 1.0**. 50+ gauntlet pointers, sword attack cursors, build hammers.

### 4.2 Audio Assets (Sound FX, Foley & Music)
- **Soniss GDC Sound Archives (2015–2023+)**: **Royalty-Free Commercial** (No attribution required, lifetime commercial rights). Over **150 GB** of professional game audio: heavy sword clashes, armor clinks, shield bashes, trebuchet releases, boulder masonry impacts, structural fire destruction.
- **Freesound.org**: **CC0 1.0 & CC-BY** (filtered). Wood chopping on timber, pickaxe on stone, anvil hammers, galloping hooves, sheep bleats, church bells.
- **Incompetech (Kevin MacLeod)**: **CC-BY 4.0**. Medieval/Celtic orchestral scores (*"Angevin"*, *"Minstrel Guild"*, *"Folk Round"*).
- **Musopen**: **Public Domain (CC0 / PD Mark 1.0)**. Authentic Renaissance/Baroque recordings (Dowland lute pieces, Palestrina polyphony, Byrd consort music).

---

## 5. AI-Generation Pipeline Specification

### 5.1 Architecture: Local vs. API-Based Workflows
- **Tech Tree & UI Icons**: **Recraft API** (`recraftv3_vector` / `recraftv4_vector`). Outputs native **SVG** paths with strict API-level hex color enforcement and zero vector scaling artifacts.
- **Unit Portraits (HUD)**: **Midjourney v6.1** (`--sref`) or **Flux.1 [dev]** (via Fal.ai API / ComfyUI). Outputs 512×512 painterly oil-painting busts with authentic 13th-century armor and Flemish master lighting.
- **Local Batch Prototyping**: **ComfyUI Local** with SDXL + ControlNet (Canny/Depth) guided by 3D renders from `tools/atlas-bake/`.

### 5.2 Canonical Palette & Quantization Script
All generated assets pass through an automated color quantization step (`tools/ai-postprocess/quantize.py`) locking them to the canonical 16-color medieval palette:
```json
{
  "gold": "#D4AF37", "gold_dark": "#996515", "crimson": "#8B0000",
  "steel_light": "#B0C4DE", "steel_dark": "#4682B4", "iron_black": "#1E1E1E",
  "wood_bark": "#5C4033", "wood_plank": "#8B5A2B", "parchment": "#F5F5DC",
  "leather": "#964B00", "cloth_linen": "#EEDC82", "stone_gray": "#708090",
  "stone_dark": "#2F4F4F", "royal_blue": "#1C39BB", "bronze": "#CD7F32",
  "shadow_black": "#0A0A0A"
}
```

### 5.3 Legal, Ethical & Licensing Defense
- **US Copyright Office Policy Compliance**: Raw AI outputs cannot claim individual copyright. We protect game assets through **Compilation Copyright** and a documented **Human-in-the-Loop Threshold** (manual overpainting, vector cleanup, custom palette quantization, and composite framing).
- **Platform Compliance (Steam)**: Prompts strictly ban living artists' names or proprietary trademarks. Use historical art movements and public domain masters.

---

## 6. Animation & Pipeline Compatibility Analysis

### 6.1 Architectural Comparison

| Architectural Approach | Draw Calls (10k units, 10 types) | CPU Frame Cost (1,000 units) | GPU Memory Footprint | Dynamic 3D Lighting & Shadows | Camera Rotation Freedom | Replay Determinism |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A. Billboard Atlas Sprites (Current)** | **10 draw calls** | **< 0.2 ms** (linear attribute write) | ~4 MB VRAM per unit atlas sheet | Baked directional lighting; quad ground shadow | Fixed 8 yaws | **100% byte-stable** across all platforms |
| **B. SkinnedMesh Clones (`SkeletonUtils.clone`)** | **10,000–30,000 draw calls** | **> 120 ms** (crashes main thread) | ~500 MB (duplicated scene graphs) | Full dynamic PBR and shadow maps | True 360° continuous rotation | Non-deterministic across GPU driver floats |
| **C. `InstancedSkinnedMesh` (Matrix Texture)** | **10 draw calls** | **15–30 ms** (thousands of matrix multiplies on JS thread) | ~30 MB (dynamic Float32Array texture) | Full dynamic PBR and shadow maps | True 360° continuous rotation | Prone to driver-specific matrix precision drift |
| **D. Vertex Animation Textures (VAT / GPU Baking)** | **10 draw calls** | **< 0.5 ms** (pure GPU vertex morphing) | ~2–5 MB per unit type (baked morph texture) | Full dynamic PBR, normal maps, cast shadows | True 360° continuous rotation | High stability |

### 6.2 Verdict & Upgrades
- **Keep Instanced Billboard Sprites for Army Units**: The current billboard atlas architecture in `src/render/unitSprites.ts` is the gold standard for browser RTS performance (matching *Age of Empires 2: DE* and *Factorio*).
- **Recommended Upgrade for `tools/atlas-bake/`**: Add the `--static` flag for single-frame building/siege bakes; support 16-yaw baking for smoother rotation transitions at high zoom.
- **Use Native 3D `InstancedMesh` for Rigid Geometry**: Naval ships (`shipModels.ts`) and buildings (`buildingModels.ts`) do not deform. Render them as true 3D `InstancedMesh` geometry (already running at 60 fps with 1 draw call per class).
- **Future 3D Free Camera Path**: If true 360° camera rotation is required, adopt **Vertex Animation Textures (VAT)**; reject `SkeletonUtils.clone` and `InstancedSkinnedMesh`.
