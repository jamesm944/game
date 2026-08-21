# Research: CC0 Asset Survey for an AoE2-like Browser RTS

- **Date:** 2026-08-21
- **Issue:** [jamesm944/game#5](https://github.com/jamesm944/game/issues/5)
- **Status:** Complete — recommendations below are ready to be turned into implementation tickets
- **Method:** Every source was verified against its own primary license page or the pack page itself (not blog round-ups). Claims cite the URL that states them. Verified 2026-08-21; re-verify before shipping since sites can change terms.

## Question

Inventory genuinely CC0 3D/audio/UI asset sources covering everything an Age of Empires 2-like needs: animated units, buildings (village through castle tier), environment (trees, ore, animals, terrain), and UI (icons, cursors, fonts, sounds). Flag anything that is CC-BY or otherwise not CC0.

## TL;DR

A full CC0 art pipeline is viable. **Quaternius + KayKit cover almost all 3D needs**, including rigged/animated characters and an RTS building set literally tagged "ageofempires". **Kenney covers UI, fonts, cursor bases, and UI audio.** The genuine gaps are: resource/unit **icons** (no strong pure-CC0 set), **boars**, **cavalry mounts**, the **Wonder**, and medieval **ambience/music** curation effort (sources exist, nobody pre-bundles a "medieval village" loop).

## Source license verification

| Source | License status | Verified at | Notes |
|---|---|---|---|
| Quaternius | **CC0, site-wide** | <https://quaternius.com/faq.html> | "All models are under the CC0 License"; commercial/educational/personal OK, no attribution, modification allowed. Each pack page repeats the CC0 badge (spot-verified on 4 pack pages). Free "Standard" downloads are CC0; paid "Source" kits (with `.blend`, engine integrations) are *also* CC0 — you pay for convenience, not rights. |
| Kenney | **CC0, site-wide** | <https://kenney.nl/support> | "all game assets on the asset pages are public domain licensed (CC0)". |
| KayKit (Kay Lousberg) | **CC0, per pack** | <https://kaylousberg.itch.io/kaykit-adventurers>, LICENSE.txt at <https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0> | itch.io "Asset license: Creative Commons Zero v1.0 Universal" + CC0 LICENSE.txt in GitHub repos. Free tiers are CC0; EXTRA/SOURCE paid tiers add content, same license. |
| Poly Pizza | **Mixed — flag** | <https://poly.pizza/search/cc0> (licence filter), API returns per-model `Licence` field | Aggregator of low-poly models under both CC0 **and CC-BY 4.0**. Must check each model's licence badge; much of the catalogue is re-hosted Quaternius/Kenney (already CC0). |
| Poly Haven | **CC0, site-wide** | <https://polyhaven.com/license> | All HDRIs/textures/models CC0. Photoreal PBR — useful for terrain ground materials, not characters. |
| ambientCG | **CC0, site-wide** | <https://docs.ambientcg.com/license/> | All PBR materials/HDRIs/terrain CC0. |
| Freesound | **Per-sound, CC0 subset** | <https://freesound.org/search/?q=&f=license%3A%22Creative+Commons+0%22> | Filter `license:"Creative Commons 0"` returned ~380k sounds total, of which ~204k are CC0 sound effects and ~53k CC0 music. Non-CC0 sounds (CC-BY, CC-BY-NC) are interleaved — check every sound's badge. Account required to download. |
| Sonniss GDC bundles | **Not CC0 — custom royalty-free EULA, flagged** | <https://gdc.sonniss.com/>, EULA: <https://sonniss.com/gdc-bundle-license>, archive: <https://sonniss.com/gameaudiogdc> | Commercial use OK, no attribution, unlimited projects/lifetime, 10-year archive >200GB. Restrictions: media-production use only, **AI/ML training prohibited**, may not redistribute sounds standalone (only embedded in a shipped game). Compatible with our use, but it is a contract, not CC0. |
| OpenGameArt.org | **Mixed, filterable** | Advanced search license filter includes CC0: <https://opengameart.org/art-search-advanced> | License(s) filter (incl. CC0) × Art Type filter (3D Art, Music, Sound Effect). Quality varies wildly; verify the license line on every item page. |
| itch.io | **Mixed, tag-filterable** | <https://itch.io/game-assets/assets-cc0> | CC0 asset tag exists; individual packs still state their own license. |
| game-icons.net | **NOT CC0 — CC-BY 3.0, flagged** | <https://game-icons.net/about.html> | Great RTS-style SVG icons, but "you can use them freely as long as you credit the original author". Usable only if we accept an attribution/credits requirement — decision point, see Gaps. |

### Traps to avoid

- **Mixamo** (Adobe): free animations but under Adobe's proprietary terms, no redistribution of source data — incompatible with a strict CC0-only pipeline. Skip.
- **Sketchfab**: hosts some CC0 downloads but the majority of downloadable free models are CC-BY; per-model check required.
- **Google Fonts**: SIL OFL 1.1 — open-source and embeddable, but not CC0. Prefer Kenney Fonts if we stay strict.
- **"Royalty-free" ≠ CC0**: Sonniss is the good case (written EULA, no attribution); many marketplaces attach additional restrictions. Only ship assets whose exact license text we have recorded.

## Findings by category

### 1. Units with usable animations

This is the hardest category and it is solved:

- **Quaternius Universal Animation Library 2** (Jan 2026): 130+ animations on a universal humanoid rig, explicitly built for retargeting into Unreal/Unity/Godot; covers melee and armed combat combos, locomotion, death, **farming and fishing** (<https://quaternius.com/packs/universalanimationlibrary2.html>). Combined with the first Universal Animation Library (locomotion/combat/idle/death), this gives us walk/attack/gather/die for any humanoid unit.
- **Quaternius Universal Base Characters** (Aug 2025): 6 rigged humanoid base models (male/female × 3 proportions), 20 mix-and-match hairstyles, animation-friendly topology (~13k tris), Humanoid rig, "Compatible with the Universal Animation Library" (<https://quaternius.com/packs/universalbasecharacters.html>).
- **Quaternius Modular Character Outfits – Fantasy**: rigged, retargetable medieval/fantasy outfits (knight etc.) to dress the base characters into distinct unit types (catalog: <https://quaternius.com/>).
- **Quaternius Ultimate Animated Character Pack** (Nov 2019): 52 ready-animated textured characters (viking, knight-adjacent fighters, wizard, goblin...) — fastest path to placeholder units (<https://quaternius.com/packs/ultimatedanimatedcharacter.html>).
- **Quaternius RPG Character Pack**: animated wizard/knight/monk/ranger/assassin (catalog: <https://quaternius.com/>).
- **KayKit Character Packs**: fully rigged + animated low-poly characters with a shared rig — **Adventurers** (knight, archer/ranged, barbarian, wizard + 25+ weapon accessories, 75 animations per the GitHub README) and **Skeletons** (enemy units), plus the separate free **KayKit Character Animations** library. Single 1024px gradient atlas texture, downsampleable to 128px — ideal for browser draw calls (<https://kaylousberg.itch.io/kaykit-adventurers>, <https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0>).
- **Animals**: Quaternius **Farm Animal Pack** (animated: pig, cow, horse, **sheep**, llama, dog) and **Ultimate Animated Animal Pack** (animated: bull, fox, horse, donkey, wolf, cow, **deer/stag**, llama, alpaca, husky) (catalog: <https://quaternius.com/>).

Practical note for Three.js: Quaternius and KayKit both ship glTF/GLB; glTF animation retargeting between the two rigs will not work directly — pick one rig family per unit class or bake final animations per model in Blender (both provide `.blend` in at least their paid/source tiers, and Quaternius free packs include .blend for older packs).

### 2. Buildings

- **Quaternius Ultimate Fantasy RTS** (Aug 2022) is the anchor: 128 models, "a collection of buildings in different evolution stages, along with nature assets", formats FBX/OBJ/glTF/Blend, CC0 badge on page (<https://quaternius.com/packs/ultimatefantasyrts.html>). Catalog tags read like an AoE2 spec sheet: *ageofempires, tower, temple, mountains, mine, barracks, market, port, resources, farm, plaza, windmill*. This gives us the AoE2-style I→II→III age building upgrades out of one pack.
- **Quaternius Medieval Village Pack**: blacksmith, tower, well, market, house (catalog: <https://quaternius.com/>).
- **Quaternius Modular Medieval Building Pack**: modular castle pieces, towers, archery targets — barracks/archery-range/castle-tier assembly (catalog: <https://quaternius.com/>).
- **Quaternius Farm Buildings Pack**: windmill, stable, well, fences (catalog: <https://quaternius.com/>).
- **KayKit City Builder Bits** (32+ models, pitched at "city planning, simulation, RTS games") and legacy **Medieval Builder Pack**/**Dungeon Pack** as alternates (<https://kaylousberg.itch.io/city-builder-bits>, collection: <https://itch.io/c/4584405/cc0-kaykit>).

### 3. Environment

- Trees/rocks/grass/bushes: Quaternius **Ultimate Nature Pack**, **Stylized Nature MegaKit**, **Ultimate Stylized Nature Pack**, **Stylized Tree Pack**; KayKit **Forest Nature Pack** free tier (100+ tree/bush/rock/grass models, Apr 2025) (<https://quaternius.com/>, <https://www.patreon.com/kaylousberg/posts/forest-nature-126432684>).
- Farms/crops: Quaternius **Ultimate Crops Pack** (wheat, corn, pumpkin, hay...) (catalog: <https://quaternius.com/>).
- Ore deposits (gold/stone): Ultimate Fantasy RTS includes mine/resource props; supplement by placing ore-colored rock meshes from nature packs.
- Animals: see §1 (sheep, deer verified; boar is a gap).
- Terrain materials: **ambientCG** (all CC0 — ground/rock categories, terrain 3D assets) and **Poly Haven** (all CC0 — e.g. farm-furrow and cobblestone photoreal textures) for splat-mapped ground (<https://docs.ambientcg.com/license/>, <https://polyhaven.com/license>).
- Cliffs/mountains: Ultimate Fantasy RTS "mountains" assets; cliff walls kitbashed from rock meshes.
- Water: recommend **procedural** (flat-shaded animated plane in Three.js) — fits the low-poly direction and requires zero licensed assets.

### 4. UI: icons, cursors, fonts, audio

- Fonts: **Kenney Fonts**, 11 fonts, CC0 (<https://kenney.nl/assets/kenney-fonts>).
- Cursor bases: **Kenney Crosshair Pack** + **Input Prompts** (CC0) provide arrow/pointer/crosshair shapes to recolor into default/attack/gather/garrison cursors (<https://kenney.nl/assets>, listing includes Crosshair Pack). No dedicated CC0 *RTS cursor set* was found — see Gaps.
- UI click/hover sounds: **Kenney Interface Sounds**, 100 files, CC0 (<https://kenney.nl/assets/interface-sounds>).
- Combat/ambience SFX: **Freesound CC0 filter** (~204k CC0 sound effects) for swords, arrows, sheep, forest ambience; **Sonniss GDC archive** (>200GB, no-attribution royalty-free EULA, non-CC0) as a quality upgrade where its restrictions are acceptable (<https://freesound.org/search/?q=&f=license%3A%22Creative+Commons+0%22>, <https://sonniss.com/gameaudiogdc>).
- Music: Freesound CC0 Music category (~53k tracks) and OpenGameArt with the CC0 × Music filter; expect manual curation.
- Icons: **weakest area.** game-icons.net is ideal stylistically but CC-BY 3.0 (<https://game-icons.net/about.html>). Pure-CC0 route is thin (scattered OpenGameArt sets of uneven quality). See Gaps.

## ASSET MANIFEST (recommended)

Primary recommendation per game concept. Q = Quaternius, K = Kenney, KK = KayKit. All rows CC0 unless flagged.

| Game concept | Source pack | Concrete asset / approach |
|---|---|---|
| Villager | Q Universal Base Characters + Modular Character Outfits–Fantasy + Universal Animation Library 1&2 | Rigged base humanoid in worker outfit; retarget walk/idle/farming/fishing/death anims |
| Militia / man-at-arms | KK Adventurers (barbarian) or Q Ultimate Animated Character Pack (fighter/viking) | Pre-animated model + weapons accessory |
| Archer | KK Adventurers (archer + bow accessory) or Q RPG Character Pack (ranger) | Bow/crossbow included as attachments |
| Knight (infantry-tier elite) | KK Adventurers (knight) | Pre-animated, sword+shield accessories |
| Mounted knight | **Gap** — Q Ultimate Animated Animal Pack horse + rider kitbash | Mount character onto animated horse; see Gaps |
| Monk | Q RPG Character Pack (monk) | Pre-animated |
| Ram / siege | **Gap** | Kitbash from Q Medieval Weapons + Modular Medieval Building timbers; simple slide animation |
| Skeleton / enemy wave | KK Skeletons (animated) | Drop-in hostile unit |
| Dragon / monster (campaign) | Q Animated Monster Pack / Ultimate Monsters | Pre-animated |
| Sheep | Q Farm Animal Pack (sheep, animated) | Direct |
| Deer / stag | Q Ultimate Animated Animal Pack (deer/stag, animated) | Direct |
| Boar | **Gap** — recolor/modify Q Farm Animal Pack pig + tusk kitbash | See Gaps |
| Town Center (all ages) | Q Ultimate Fantasy RTS | Main-building meshes incl. evolution stages |
| House (all ages) | Q Ultimate Fantasy RTS | Evolution stages included |
| Mill | Q Farm Buildings Pack (windmill) or UFRS windmill | Direct |
| Farm plot | Q Ultimate Crops Pack (wheat rows) + Farm Buildings fences | Compose plot from crops+fence |
| Barracks | Q Ultimate Fantasy RTS (barracks) | Direct |
| Archery Range | Q Modular Medieval Building Pack (archery target + modules) | Assemble |
| Stable | Q Farm Buildings Pack (stable) | Direct |
| Blacksmith | Q Medieval Village Pack (blacksmith) | Direct |
| Market | Q Ultimate Fantasy RTS (market) / Medieval Village Pack (market) | Direct |
| Tower / Keep | Q Ultimate Fantasy RTS (tower) / Modular Medieval Building Pack | Direct |
| Castle | Q Modular Medieval Building Pack (castle modules) | Assemble |
| Wonder | **Gap** — kitbash cathedral-scale from castle modules + village church pieces | See Gaps |
| Dock / Port | Q Ultimate Fantasy RTS (port) + Pirate Kit dock | Direct |
| Trade Cart | **Gap** — Q Fantasy Props MegaKit wagon + horse | See Gaps |
| Fishing Ship / Galley | Q Ships Pack (viking, raft, sailboat) | Direct |
| Trees (variety) | Q Ultimate Nature Pack / Stylized Nature MegaKit; KK Forest Nature Pack free tier | Pick 3–5 variants per biome |
| Berry Bush | Bush mesh from nature packs + red berry kitbash/recolor | See Gaps |
| Gold Mine / Stone Mine | Q Ultimate Fantasy RTS (mine/resources) + ore-tinted rocks | Tint via material |
| Relic | Q RPG Essentials/Pack (chest, gems, crown) kitbash | Small prop on a base |
| Terrain ground | ambientCG Ground/Rock series; Poly Haven grass/dirt/farm-furrow textures | Splat map, downscale to 512px tiles |
| Cliffs | Q Ultimate Fantasy RTS mountains + rock meshes | Kitbash cliff walls |
| Water | Procedural flat-shaded animated plane (Three.js) | Zero assets |
| HUD font | K Kenney Fonts | Pick 1 display + 1 body font |
| Cursor set | K Crosshair Pack + Input Prompts recolors | Default/attack/gather states |
| UI click / hover / error | K Interface Sounds (100 files) | Direct |
| Combat SFX (swords, arrows, impacts) | Freesound CC0 filter | Curate ~30 clips; record license URLs |
| Ambient loops (forest, village, birds) | Freesound CC0 Soundscapes (~41k) | Curate 3–5 loops |
| Music | Freesound CC0 Music / OpenGameArt CC0×Music | Manual curation task |
| Resource & unit icons | **Gap** — options in Gaps section | Decision needed: CC-BY vs in-house SVG |
| Minimap tiles (2D prototype) | K Medieval RTS (120-file 2D tile set) | Also useful for loading screens |

## Gaps and mitigations

1. **Resource/unit/building icons (biggest gap).** No verified pure-CC0 set matches AoE2's icon needs at consistent quality. Options, in order of preference:
   - Draw minimal flat SVG icons in-house (wood = log, food = apple/wheat, gold = coin, stone = block; buildings = simplified silhouettes of our actual 3D models rendered to sprite). Cheap, style-perfect, zero license risk.
   - Accept game-icons.net under **CC-BY 3.0** with a credits screen entry ("Icons by Lorc, Delapouite et al., game-icons.net") — needs a project decision to relax strict-CC0 for UI only.
   - Cherry-pick CC0-tagged sets on OpenGameArt/itch.io, verifying each item page.
2. **Boar.** No verified CC0 animated boar. Mitigation: modify Q Farm Animal Pack pig (CC0 allows modification): darker bristly recolor + tusk geometry; reuse pig animations.
3. **Cavalry / mounted units.** No verified CC0 rigged-rider-on-horse. Mitigation: kitbash — parent Q/KK humanoid (upper-body idle/attack anims) to Q animated horse; hide rider legs. Acceptable at RTS camera distance.
4. **Wonder.** No CC0 cathedral-scale centerpiece. Mitigation: assemble from Q Modular Medieval Building castle modules at 1.5–2× scale + Medieval Village church-like pieces; add gold-trim material variant.
5. **Siege weapons (ram/trebuchet).** No verified animated CC0 set. Mitigation: static kitbash props + code-driven motion (ram swing, trebuchet arm rotate) — mechanical motion suits procedural animation better than skeletal.
6. **Trade cart.** Mitigation: Q Fantasy Props MegaKit wagon + Q animated horse pulling; wheels rotate procedurally.
7. **Berry bush.** Mitigation: nature-pack bush mesh + instanced small red spheres; trivial Blender job.
8. **Cursors.** No dedicated CC0 RTS cursor set found. Mitigation: recolor/rotate Kenney Crosshair/Input-Prompt shapes into the ~6 cursor states AoE2-like needs.
9. **Music.** CC0 sources exist (Freesound ~53k CC0 music, OpenGameArt) but nothing curated for "medieval strategy". Mitigation: time-boxed curation pass, or commission later; start with ambient loops only.
10. **Rig unification.** Two animation ecosystems (Quaternius Universal rig vs KayKit rig) means per-family animation handling in Three.js. Mitigation: standardize military units on one family (recommend KayKit for atlas-texture efficiency) and villagers on the other (recommend Quaternius for the farming/fishing animation library).

## Sources

- Quaternius FAQ (site-wide CC0): https://quaternius.com/faq.html
- Quaternius Ultimate Fantasy RTS: https://quaternius.com/packs/ultimatefantasyrts.html
- Quaternius Universal Animation Library 2: https://quaternius.com/packs/universalanimationlibrary2.html
- Quaternius Universal Base Characters: https://quaternius.com/packs/universalbasecharacters.html
- Quaternius Ultimate Animated Character Pack: https://quaternius.com/packs/ultimatedanimatedcharacter.html
- Quaternius full catalog (pack names/tags): https://quaternius.com/
- Kenney support/licensing FAQ: https://kenney.nl/support
- Kenney Medieval RTS: https://kenney.nl/assets/medieval-rts
- Kenney Interface Sounds: https://kenney.nl/assets/interface-sounds
- Kenney Fonts: https://kenney.nl/assets/kenney-fonts
- KayKit Adventurers (itch): https://kaylousberg.itch.io/kaykit-adventurers
- KayKit Adventurers (GitHub, CC0 LICENSE.txt): https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
- KayKit City Builder Bits: https://kaylousberg.itch.io/city-builder-bits
- KayKit Forest Nature Pack announcement: https://www.patreon.com/kaylousberg/posts/forest-nature-126432684
- KayKit CC0 collection: https://itch.io/c/4584405/cc0-kaykit
- Poly Pizza licence filtering: https://poly.pizza/search/cc0
- Poly Haven license: https://polyhaven.com/license
- ambientCG license: https://docs.ambientcg.com/license/
- Freesound CC0 search: https://freesound.org/search/?q=&f=license%3A%22Creative+Commons+0%22
- Sonniss GDC bundle: https://gdc.sonniss.com/ ; EULA: https://sonniss.com/gdc-bundle-license ; archive: https://sonniss.com/gameaudiogdc
- OpenGameArt advanced search (license + type filters): https://opengameart.org/art-search-advanced
- itch.io CC0 asset tag: https://itch.io/game-assets/assets-cc0
- game-icons.net license (CC-BY 3.0): https://game-icons.net/about.html
