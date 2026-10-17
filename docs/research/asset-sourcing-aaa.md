# AAA-quality asset sourcing: units, buildings, animation, icons, audio (map 6 · #144)

Extends [`ASSET-INVENTORY.md`](../../ASSET-INVENTORY.md) (11 CC0 packs vendored, ~250 glTF models) and
[`NAVAL-ASSET-INVENTORY.md`](./NAVAL-ASSET-INVENTORY.md).

## 1. What we already own (from the inventory)

- Humanoid rigs with large clip sets: Quaternius UAL1/UAL2 (43 + 43 clips incl. `Farm_Harvest`, `TreeChopping_Loop`,
  `Walk_Carry_Loop`, `Sword_*`, `Shield_*`), KayKit Adventurers (76 clips ×5 characters), KayKit Skeletons (95 ×4).
- Static buildings/props: Quaternius Ultimate Fantasy RTS (128 glTF), Medieval Village (45 FBX), Farm Buildings.
- Animals: 12 animated animals (12–13 clips each). Terrain PBR: ambientCG ×3 + Poly Haven ×1 (1k).
- Pipeline: `tools/atlas-bake` bakes rigged models into **sprite atlases** (`npm run bake:villager`, `bake:units`).

**Gap vs AAA:** only ~2 distinct humanoid silhouettes beyond villagers, no age/civ-specific building variants, no
siege/naval-animated sets beyond static ships, no UI icon set, no portraits, no voice, no music/SFX beyond the
current audio manifest, and 1k terrain textures.

## 2. Additional free/cheap sources (verified catalogue)

KayKit (kaylousberg.itch.io, verified page): **Medieval Hexagon Pack** ("200+ stylised low-poly medieval hexagonal
tiles, buildings, and props"), **Medieval Builder Pack**, **Forest Nature Pack** (trees/rocks/grass),
**Resource Bits** ("resources and materials, great for crafting games"), RPG Tools, Furniture ("building interiors and
rooms" — useful for the rooms/beauty system), City Builder Bits, Dungeon Pack (relevant if z-levels/digging land),
Character Animations pack.
**Important:** several KayKit packs are sold (page shows "$19.95/$19.99 or more" and a $150 "Complete KayKit");
vendored packs so far are the **free** CC0 tiers. Check the licence file of each pack before vendoring — paid
packs have their own licence.

Kenney (kenney.nl) is the other standard CC0 source (3D kits, UI packs, audio, input prompts); its category page is
JavaScript-rendered so the fetcher could not enumerate packs. **To do:** list Kenney's Castle/Fantasy-town kits, UI
packs, and Impact/RPG audio via a real browser session and add them with LICENSE copies.

Not yet surveyed (needs a browsing pass): OpenGameArt CC0 collections, Sketchfab CC0 downloads, Poly Haven
(models/HDRIs/textures), freesound.org CC0 SFX, incompetech/Kevin MacLeod-style music (usually CC-BY, attribution
required), Mixamo (royalty-free but **not CC0** and its terms must be read before shipping).

## 3. AI-generated assets: licensing reality

Primary source: US Copyright Office, _Copyright and Artificial Intelligence, Part 2: Copyrightability_ (Jan 2025).
The report's relevant position, which I downloaded but only partially re-read (text search for the quoted phrases
returned nothing from the extracted PDF, so **treat the next two bullets as my understanding, not verified quotes**):
purely AI-generated material without sufficient human creative control is not copyrightable; human selection,
arrangement and modification can be. Practical consequences for us:

- AI icons/UI/textures **can be shipped**, but we may be unable to enforce copyright on unmodified outputs.
  Fine for a game; matters if assets are resold. Keep human-edited layers (compositing, painting-over).
- Tool terms matter independently of copyright (commercial-use grants, indemnity). **Not researched** per tool
  — needs a tool-by-tool pass before picking the pipeline.
- Style consistency, not licensing, is the practical problem: use a fixed style reference + seed/LoRA-style
  conditioning and a review gate; generate **icons (units, techs, resources, buildings), portraits, panel chrome,
  terrain albedo/normal tiles, loading art/concept art**; do **not** try to generate rigged 3D models.

## 4. Animation pipeline decision inputs

| Path                         | Pros                                                        | Cons                                                                  |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Keep atlas-bake sprites      | Cheap, proven, 60 FPS crowds, already tooled                | Fixed view angles, low-res close-ups, hard to vary equipment/injuries |
| Skeletal glTF + GPU instancing | Real close-ups, equipment/wound/age variation, fits Pop sim (individual bodies) | Needs GPU-skinning path (best on WebGPU compute), heavier per-unit cost |
| Hybrid LOD                   | Skeletal near the camera, sprite impostors far              | Two pipelines to maintain                                             |

The deep-Pop sim (individual injuries, equipment, age) argues for **hybrid LOD** in the long run.

## 5. Audio

Current state: audio bus (master/music/sfx/ui/ambient), music defaults **OFF** on the title screen. Need:
orchestral/medieval music set, ambient beds per biome/time of day, unit acknowledgement barks per civ,
building/combat foley, weather. Sources: Kenney audio (CC0), freesound CC0 filtered, commissioned/AI-assisted
music (same copyright caveats as §3). No selection made here.

## 6. Recommended next steps (inputs to #148 art bible)

1. Add a CC0 pack pass for **civ/age-specific buildings** (Medieval Hexagon / Builder, Kenney Castle) with licence
   files in `src/assets/models/<pack>/`.
2. Decide stylised-vs-realistic **before** buying/vendoring more (the vendored sets are stylised low-poly;
   "AAA realistic" would need a different source class and budget — flag for the art-bible grilling).
3. Stand up an **icon/portrait generation prototype** (one batch of ~40 icons) and judge consistency.
4. Choose the animation path with #143/#145 (WebGPU compute changes the skeletal option).

## 7. Unverified

Kenney pack list; OpenGameArt/Sketchfab/freesound/Mixamo terms; per-AI-tool licence terms; exact wording of the
Copyright Office conclusions.
