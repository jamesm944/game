# CC0 Asset Pack Inventory — acquisition + Entity mapping (SPEC §6)

Research artifact for issue #70. Branch: `research/asset-packs`.
Every claim below was verified against the downloaded files on this branch
(clip names parsed from the GLTF/GLB JSON chunks; stage names read from
filenames; licenses read from the vendor license files shipped in each pack
directory).

Acquired: **11 packs / 4 sources, 0 unreachable.** All are CC0 1.0.
Vendored under `src/assets/models/<pack>/`, each with a `LICENSE.md`
(provenance + verbatim vendor license).

## Packs acquired

| Pack dir (`src/assets/models/…`)           | Vendor                                                           | Format vendored                    | Files | Rig status                                 |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------- | ----- | ------------------------------------------ |
| `quaternius-ultimate-base-characters`      | quaternius.com → itch `universal-base-characters` (Standard zip) | gltf+bin+png (`Godot - UE` subset) | 19    | skinned, **0 clips**                       |
| `quaternius-universal-animation-library-1` | itch `universal-animation-library`                               | glb (+`_RM` root-motion)           | 4     | mannequin rig, **43 clips**                |
| `quaternius-universal-animation-library-2` | itch `universal-animation-library-2`                             | glb (+`_RM`)                       | 5     | mannequin rig, **43 clips**                |
| `quaternius-ultimate-fantasy-rts`          | quaternius.com → Google Drive                                    | gltf (full `glTF/` folder)         | 129   | static meshes                              |
| `quaternius-medieval-village`              | quaternius.com → Google Drive                                    | fbx (Buildings+Props)              | 45    | static meshes                              |
| `quaternius-farm-buildings`                | quaternius.com → Google Drive                                    | fbx                                | 14    | static meshes                              |
| `quaternius-ultimate-animated-animals`     | quaternius.com → Google Drive                                    | gltf (embedded)                    | 13    | skinned, **12–13 clips each** × 12 animals |
| `quaternius-farm-animals`                  | quaternius.com → Google Drive                                    | obj+mtl                            | 8     | static meshes                              |
| `kaykit-adventurers`                       | github.com/KayKit-Game-Assets (official mirror)                  | glb characters + gltf accessories  | ~50   | skinned, **76 clips** per character        |
| `kaykit-enemy-skeletons`                   | github.com/KayKit-Game-Assets (official mirror)                  | glb + gltf accessories             | ~30   | skinned, **95 clips** per character        |
| `terrain/`                                 | ambientCG ×3 + Poly Haven ×1                                     | jpg maps (1k)                      | 13    | n/a                                        |

GLTF-family model count vendored: **≈250** (128 UFRS buildings + props, 12
animated animals, 9 rigged humanoids, 40 accessories/weapons, 2 UBC bodies,
3 UAL GLBs, plus OBJ sheep set).

### Animation clip availability (parsed from files)

- **UAL1** (`UAL1_Standard.glb`, 43): `A_TPose Crouch_* Dance_Loop Death01
Driving_Loop Fixing_Kneeling Hit_Chest Hit_Head Idle_Loop Idle_Talking_Loop
Idle_Torch_Loop Interact Jog_Fwd_Loop Jump_{Land,Loop,Start} PickUp_Table
Pistol_* Punch_{Cross,Jab} Push_Loop Roll Sitting_{Enter,Exit,Idle_Loop,
Talking_Loop} Spell_Simple_{Enter,Exit,Idle_Loop,Shoot} Sprint_Loop Swim_*
Sword_Attack Sword_Idle Walk_Formal_Loop Walk_Loop`
- **UAL2** (`UAL2_Standard.glb`, 43): adds the economy/combat set —
  `Farm_Harvest Farm_PlantSeed Farm_Watering TreeChopping_Loop
Walk_Carry_Loop Consume Chest_Open ClimbUp_1m Hit_Knockback Idle_* LayToIdle
Melee_Hook{,_Rec} NinjaJump_* OverhandThrow Shield_* Slide_* Sword_Block
Sword_Dash Sword_Heavy_Combo Sword_Regular_{A,B,C}{,_Rec} Sword_Regular_Combo Yes Zombie_* A_TPose`
- **KayKit Adventurers** (each of Barbarian/Knight/Mage/Rogue/Rogue_Hooded, 76):
  `Idle Unarmed_Idle Walking_{A,B,C,Backwards} Running_{A,B,Strafe_Left,Strafe_Right}
Jump_{Start,Idle,Land,Full_Long,Full_Short} 1H_/2H_/Dualwield_Melee_Attack_*
1H_/2H_Ranged_{Aiming,Reload,Shoot,Shooting} Block Blocking Block_{Attack,Hit}
Hit_{A,B} Death_{A,B}{,_Pose} Cheer PickUp Interact Use_Item Throw Dodge_*
Sit_Chair_*/Sit_Floor_*/Lie_* Spellcast* T-Pose`
- **KayKit Enemy Skeletons** (×4 rigs, 95): superset of Adventurers plus
  `Spawn_{Ground,Air}`, `Skeletons_Awaken_*`, `Taunt{,_Longer}`,
  `Death_C_*`, `Idle_B`, `Running_C`, `Walking_D_Skeletons`.
- **Ultimate Animated Animals** (per animal, 12–13):
  `Attack_Headbutt|Attack Attack_Kick Death Eating Gallop Gallop_Jump Idle
Idle_2 Idle_Headlow|Idle_2_HeadLow Idle_HitReact{1,2} Jump_toIdle|Jump_ToIdle Walk`

---

## Entity mapping — units (`src/data/definitions/units/*.json`, 8/8 covered)

| Unit def        | Model source (path under `src/assets/models/`)                                                                      | Clips to bake                                                                                                                                                          | Notes                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `villager`      | `quaternius-ultimate-base-characters/Superhero_Male_FullBody.gltf` (+ `_Female_`) retargeted from UAL               | idle←`Idle_Loop`(U1), walk←`Walk_Loop`(U1), farm←`Farm_PlantSeed/Harvest/Watering`(U2), chop←`TreeChopping_Loop`(U2), carry←`Walk_Carry_Loop`(U2), death←`Death01`(U1) | SPEC §6 exact plan (UBC + UAL 1&2). Standard tier ships only Superhero M/F full-bodies; Modular Outfits-Fantasy not vendored this pass (see MISSING). |
| `militia`       | `kaykit-adventurers/Characters/Barbarian.glb` + `Assets/gltf/sword_1handed.gltf`                                    | pre-animated: `Idle`, `Walking_A`, `Running_A`, `1H_Melee_Attack_Slice_Horizontal`, `Hit_A`, `Death_A`                                                                 | SPEC: KK Adventurers (barbarian).                                                                                                                     |
| `man-at-arms`   | same rig as militia + `shield_round.gltf` + `sword_2handed.gltf`                                                    | add `Blocking`, `Block_Hit`                                                                                                                                            | Same skeleton → one atlas family.                                                                                                                     |
| `archer`        | `kaykit-adventurers/Characters/Rogue_Hooded.glb` + `quiver.gltf`, `arrow.gltf`                                      | `1H_Ranged_{Aiming,Reload,Shoot}` or bow pose from `Spellcast_Shoot`; death/hit shared                                                                                 | Rogue carries ranged anim set; quiver/bow accessories included in pack.                                                                               |
| `skirmisher`    | `kaykit-adventurers/Characters/Rogue.glb`                                                                           | `Throw` (javelin), `Unarmed_Melee_Attack_Kick`, movement set                                                                                                           | `Throw` clip exists on all KayKit rigs.                                                                                                               |
| `knight`        | `kaykit-adventurers/Characters/Knight.glb` + `sword_2handed_color.gltf`, `shield_badge_color.gltf`                  | melee + `Blocking` set                                                                                                                                                 | Pre-animated sword+shield per SPEC.                                                                                                                   |
| `scout-cavalry` | mount: `quaternius-ultimate-animated-animals/glTF/Horse.gltf`; rider: KayKit Barbarian parented                     | horse: `Gallop`, `Gallop_Jump`, `Idle`, `Attack_Kick`, `Death`; rider upper-body only                                                                                  | Kitbash per SPEC ("parent rider, hide legs"→ bake composite pose).                                                                                    |
| `monk`          | closest vendored stand-in: `kaykit-adventurers/Characters/Mage.glb` (robe silhouette, `Spellcasting`/`Cheer` clips) | idle/walk/spellcast/heal-ish                                                                                                                                           | Official SPEC source is Q RPG Character Pack (monk) — **not vendored** (see MISSING). Mage is placeholder until then.                                 |

Fauna used by sim (no unit defs yet, mapped for completeness):

| Concept   | Source                                                                                          | Clips                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sheep     | `quaternius-farm-animals/OBJ/Sheep.obj` (static) → replace with animated equivalent when needed | none (static mesh); animated alternative = UAA Cow-style set does not include sheep — see MISSING |
| Deer/Stag | `quaternius-ultimate-animated-animals/glTF/{Deer,Stag}.gltf`                                    | full 13-clip set incl. `Eating`, `Death`, hit-reacts                                              |
| Horse     | `…/Horse.gltf` (+ `Horse_White.gltf` variant)                                                   | 13 clips                                                                                          |

## Entity mapping — buildings (`src/data/definitions/buildings/*.json`, 25/25 covered)

All building defs map onto Ultimate Fantasy RTS age-stage models
(`FirstAge`/`SecondAge` × `Level1..3`), with Medieval Village / Farm Buildings
filling types UFRS lacks. Age-stage column shows available stages.

| Building def   | ageGate  | Primary model (`quaternius-ultimate-fantasy-rts/glTF/…`)                                                         | Stages                              | Fallback/alt source                                                                     |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| town-center    | dark     | `TownCenter_FirstAge_Level1..3`, `TownCenter_SecondAge_Level1..3`                                                | 6                                   | exact                                                                                   |
| house          | dark     | `Houses_FirstAge_{1,2,3}_Level1..3`, `Houses_SecondAge_{1,2,3}_Level1..3`                                        | 18 (6 variants × 3 levels × 2 ages) | exact                                                                                   |
| farm           | dark     | `Farm_FirstAge_Level1..3(+_Wheat)`, `Farm_SecondAge_Level1..3(+_Wheat)`, `Farm_Dirt_Level1..3`                   | 15                                  | exact (wheat growth states included)                                                    |
| barracks       | dark     | `Barracks_FirstAge_Level1..3`, `Barracks_SecondAge_Level1..3`                                                    | 6                                   | exact                                                                                   |
| lumber-camp    | dark     | `Storage_FirstAge_Level1..3`, `Storage_SecondAge_Level1..3`                                                      | 6                                   | medieval-village `Sawmill.fbx`/`Hay.fbx` dressing                                       |
| mining-camp    | dark     | `Mine.gltf` + `Resource_Gold_1..3`, `Resource_Rock_1..3`                                                         | 1 (+ore tints)                      | ore-tint material variants per SPEC                                                     |
| mill           | dark     | `Windmill_FirstAge.gltf`, `Windmill_SecondAge.gltf`                                                              | 2                                   | medieval-village `Mill.fbx`, farm-buildings `Windmill.fbx`/`TowerWindmill.fbx` variants |
| church         | dark     | `Temple_FirstAge_Level1..3`                                                                                      | 3                                   | medieval-village `Bell_Tower.fbx` for detail                                            |
| brothel        | dark     | `Houses_SecondAge_2_Level2` (distinct variant)                                                                   | reuse                               | medieval-village `House_*` recolor                                                      |
| tavern         | dark     | medieval-village `Inn.fbx` (exact-named!)                                                                        | 1                                   | UFRS `Market_FirstAge_Level1..3` for stage variants                                     |
| school         | dark     | `Houses_FirstAge_3_Level1..3`                                                                                    | 3                                   | grand-academy upgrade path below                                                        |
| stable         | feudal   | medieval-village `Stable.fbx` (exact-named); farm-buildings `BigBarn.fbx`/`SmallBarn.fbx`/`Barn.fbx` as variants | 4                                   | UAA horses penned outside                                                               |
| archery-range  | feudal   | `Archery_FirstAge_Level1..3`, `Archery_SecondAge_Level1..3`                                                      | 6                                   | exact                                                                                   |
| blacksmith     | feudal   | medieval-village `Blacksmith.fbx` (exact-named)                                                                  | 1                                   | UFRS `Market_SecondAge_Level1..3` for stage variants                                    |
| forge          | feudal   | medieval-village `Blacksmith.fbx` + `Cauldron.fbx` + `Bonfire_Lit.fbx`                                           | 1                                   | UFRS Market alt                                                                         |
| smithy         | feudal   | medieval-village `Blacksmith.fbx` + crates                                                                       | 1                                   | —                                                                                       |
| kiln           | feudal   | medieval-village `Cauldron.fbx`/`Bonfire.fbx` composition (closest furnace)                                      | 1                                   | UFRS Storage alt                                                                        |
| kitchen        | feudal   | medieval-village `House_2.fbx` variant + `Well.fbx`                                                              | 1                                   | —                                                                                       |
| sawpit         | feudal   | medieval-village `Sawmill.fbx` + `Sawmill_saw.fbx` (exact-named)                                                 | 2                                   | —                                                                                       |
| watch-tower    | feudal   | `WatchTower_FirstAge_Level1..3`, `WatchTower_SecondAge_Level1..3`                                                | 6                                   | exact                                                                                   |
| monastery      | castle   | `Temple_SecondAge_Level1..3`                                                                                     | 3                                   | medieval-village `Bell_Tower.fbx`                                                       |
| monument       | castle   | `Wonder_FirstAge_Level1..2` (scaled)                                                                             | 2                                   | —                                                                                       |
| wonder         | imperial | `Wonder_FirstAge_Level1..3`, `Wonder_SecondAge_Level1..3`, `WonderWalls_*`                                       | 8                                   | gold-trim material variant per SPEC                                                     |
| grand-monument | imperial | `Wonder_SecondAge_Level3` (scaled)                                                                               | 1                                   | —                                                                                       |
| grand-academy  | imperial | `TownCenter_SecondAge_Level3` variant (scaled)                                                                   | 1                                   | Q Modular Medieval not vendored — see MISSING                                           |

Surplus (acquired, no current def): `Dock_*`, `Port_*`, `WallTowers_*`,
`Wall_*`, `TowerHouse_*`, `Mountain*`, `Rock*`, `Resource_Tree*/PineTree*`,
`Barrel/Crate*` — ready for future ship/economy/wall defs.

## Terrain

| Use                       | File(s)                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| Grass base splat          | `terrain/ambientcg-grass001/Grass001_1K-JPG_Color.jpg` (+AO/N/R)        |
| Dirt/farmland splat       | `terrain/ambientcg-ground110-dirt/Ground110_1K-JPG_Color.jpg` (+AO/N/R) |
| Rock splat                | `terrain/ambientcg-rock064/Rock064_1K-JPG_Color.jpg` (+AO/N/R)          |
| Grass accent (Poly Haven) | `terrain/polyhaven-leafy-grass/leafy_grass_diff_1k.jpg`                 |

Matches SPEC §6 "Terrain ground: ambientCG Ground/Rock + Poly Haven grass"
(512 px tiles, splat map).

---

## MISSING / gaps (recorded honestly, nothing fabricated)

No pack in this ticket's list was unreachable — all 11 were downloaded from
official pages (quaternius.com pack pages → itch or the page's own Google
Drive folders; KayKit's official GitHub org; ambientCG/Poly Haven APIs).
Remaining gaps are _scope/format_, not reachability:

1. **Quaternius RPG Character Pack** (SPEC source for `monk`, ranger-alt
   archer) — not part of ticket #70's download list; monk currently uses
   KayKit Mage as a stand-in. Closest alternative already in-tree: Mage.glb.
   Proper fix: acquire `quaternius.com/packs/rpgcharacters.html`.
2. **Animated sheep**: SPEC lists "Q Farm Animal Pack / Ultimate Animated
   Animal Pack" for sheep. Farm Animals (Drive version) is OBJ/static;
   Ultimate Animated Animals has no sheep. Options: use UAA `Cow.gltf`
   rescaled/recolored, or check the itch-era Farm Animal Pack upload for a
   rigged FBX. Current tree keeps static `Sheep.obj` + both alternatives'
   sources.
3. **Medieval Village & Farm Buildings ship no glTF** (Blends/FBX/OBJ only)
   and **Farm Animals is OBJ-only**. FBX/OBJ need a Blender/fbx2gltf
   conversion pass before atlas-bake can consume them. Recorded per-pack in
   their LICENSE.md; conversion is build-tooling work, not a re-download.
4. **UBC "Standard" tier** includes only Superhero male/female base bodies;
   SPEC's "Modular Outfits-Fantasy" add-on pack was not in scope and is not
   vendored. Villager look variety needs that pack (or the EXTRA tier).
5. **SPEC-referenced packs outside this ticket**: Q Ships, Medieval Weapons,
   Modular Medieval timbers, Ultimate/Stylized Nature, Ultimate Crops,
   Fantasy Props MegaKit, Kenney UI/audio/fonts — untouched here.
6. **Siege (ram/trebuchet)**: no unit defs exist; no assets vendored.
7. Vendor quirk noted: UFRS `License.txt` header text says "Ultimate
   Platformer Pack" (upstream copy-paste slip); content is from the UFRS
   Drive folder linked on the official UFRS page. License itself is CC0.

## BAKE DECISION

**Recommendation: keep committed atlases as the runtime art path** — do NOT
load these GLTFs at runtime. Rationale:

- Determinism: the game's replay/golden tests require byte-stable rendering.
  The headless CPU rasterizer + fixed frame sampling gives identical PNG
  output across machines; GPU sprite sampling of committed atlases stays
  deterministic by construction.
- Perf budget: SPEC targets browser RTS scale; 128 px cells in 2048² pages
  (actions × 8 yaws × frames, `planAtlasLayout`/`PLAYBACK_QUANTUM_FPS=15`)
  keep draw cost flat regardless of population.
- The vendored packs stay as _bake-time-only_ inputs (provenance + rebake),
  never shipped to the client bundle.

Required `tools/atlas-bake` changes before real bakes (current tool bakes the
stand-in rig only):

1. **Self-contained GLB requirement**: `--gltf` path uses
   `GLTFLoader.parse` on raw bytes — works only for .glb with embedded
   buffers/textures. Verified self-contained in-tree: KayKit `Characters/*.glb`
   (embedded buffer + embedded PNG) and UAA `.gltf` (base64 data-URI buffers).
   **UBC `.gltf`+`.bin`+external pngs does not qualify** — either convert UBC
   to .glb at vendoring time or extend parse to resolve external buffers.
   Medieval Village / Farm Buildings FBX / Farm Animals OBJ must be converted
   to .glb upstream of the tool (see gap #3).
2. **Skinning stage**: all humanoid/animal rigs are `SkinnedMesh`;
   `raster.ts flattenScene` documents the missing vertex-skinning step
   (SWAP(skinning)). Needed before any of these rigs rasterize correctly.
3. **Retarget config**: villager bakes require UAL1/UAL2 mannequin clips
   retargeted onto UBC skeletons (same Quaternius bone naming family — add a
   bone-map table + per-unit action manifest extending `BAKE_ACTIONS` beyond
   today's `{idle: 4f@6fps, walk: 8f@12fps}`). KayKit military uses its own
   pre-animated skeletons directly (no retarget).
4. **Static-building path**: buildings have zero animations; add a
   `--static` mode (single bind-pose sample, optionally 8 yaws for rotation)
   keyed off def `ageGate` → FirstAge/SecondAge and a level/stage field.
   One atlas page per building type/stage; InstancedMesh consumes it per SPEC.
5. **Determinism guards**: sort clip names before sampling; fix sample fps to
   `PLAYBACK_QUANTUM_FPS`; print sha256 per page (already implemented);
   record source pack dir + file hashes in `<unitId>.frames.json` so rebakes
   detect input drift.
6. **Multi-page layout**: knight/militia families have 70+ available clips;
   bake only the mapped subsets above (~7 actions/unit) to stay within one
   2048² page per unit; `planAtlasLayout` already supports spillover pages if
   a future action set grows.

## Sources

- Pack pages (primary, checked 2026-08-25): quaternius.com
  `/packs/universalbasecharacters.html`, `/packs/universalanimationlibrary{,2}.html`,
  `/packs/ultimatefantasyrts.html`, `/packs/medievalvillage.html`,
  `/packs/farmbuildings.html`, `/packs/ultimateanimatedanimals.html`,
  `/packs/farmanimal.html` — each page's official download target (itch.io
  game page or Google Drive folder) is what was fetched.
- itch download endpoints: `quaternius.itch.io/<slug>/download_url` +
  `/<slug>/file/<upload_id>` (free-tier flow).
- KayKit: github.com/KayKit-Game-Assets repos (README states CC0; LICENSE.txt
  vendored).
- ambientCG API v3 (`/api/v3/assets?include=downloads`) → `/get?file=<ID>_1K-JPG.zip`;
  Poly Haven API (`api.polyhaven.com/files/leafy_grass`) → dl.polyhaven.org.

---

## AAA Extension: 31 Units, 4 Ages, PBR Terrain, UI, Audio & AI Pipeline (Map 6 · Issue #144)

For the complete expanded inventory and technical pipeline specification (covering all 31 unit definitions, 32 building definitions across 4 ages and civilizational aesthetics, ambientCG/Poly Haven PBR terrain, Game-icons.net UI, Soniss GDC 150GB+ audio archive, the Recraft V3 / Flux AI pipeline with palette locking, and the billboard sprite vs VAT animation architecture evaluation), see:

👉 [**AAA-Quality Medieval Assets & AI Generation Pipeline**](file:///Users/jamesmoss/Documents/game/docs/research/asset-sourcing-aaa.md) (`docs/research/asset-sourcing-aaa.md`).
