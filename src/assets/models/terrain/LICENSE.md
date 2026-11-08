# Terrain textures — provenance

All four textures are CC0 1.0 Universal (Public Domain Dedication).

| Local dir | Asset | Source | License link |
| --- | --- | --- | --- |
| `ambientcg-grass001/` | Grass 001 (1K-JPG zip; Color/AO/NormalGL/Roughness kept) | https://ambientcg.com/view?id=Grass001 | https://creativecommons.org/publicdomain/zero/1.0/ |
| `ambientcg-ground110-dirt/` | Ground 110 — dirt (1K-JPG) | https://ambientcg.com/view?id=Ground110 | same |
| `ambientcg-rock064/` | Rock 064 (1K-JPG) | https://ambientcg.com/view?id=Rock064 | same |
| `polyhaven-leafy-grass/` | leafy_grass diffuse 1k | https://polyhaven.com/a/leafy_grass | https://polyhaven.com/license |
| `ambientcg-ground054-sand/` | Ground 054 — sand/shore 1K-JPG (Color/AO/NormalGL/Roughness) | https://ambientcg.com/view?id=Ground054 | CC0, same as above |
| `ambientcg-ground037-farm/` | Ground 037 — farm/dirt alt 1K-JPG (Color/AO/NormalGL/Roughness) | https://ambientcg.com/view?id=Ground037 | same |
| `ambientcg-pavingstones070-cobble/` | Paving Stones 070 — cobble 1K-JPG (Color/AO/NormalGL/Roughness) | https://ambientcg.com/view?id=PavingStones070 | same |
| `polyhaven-leafy-grass/` (+nor_gl/rough/ao 1k jpg, md5 = API) | leafy_grass PBR companions to the diffuse above | https://polyhaven.com/a/leafy_grass | https://polyhaven.com/license |
| `ambientcg-ground058-road/` | Ground 058 — rocky road dirt 1K-JPG (full PBR set) | https://ambientcg.com/view?id=Ground058 | CC0, same as above |
| `ambientcg-ground059-mud/` | Ground 059 — wet sand / mudflat 1K-JPG (full PBR set) | https://ambientcg.com/view?id=Ground059 | same |
| `ambientcg-wood095-timber/` | Wood 095 — light timber grain 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Wood095 | same |
| `ambientcg-planks001/` | Planks 001 — weathered planks 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Planks001 | same |
| `ambientcg-moss001/` | Moss 001 — forest-floor moss 1K-JPG (full PBR set) | https://ambientcg.com/view?id=Moss001 | same |
| `ambientcg-snow001/` | Snow 001 — snow ground 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Snow001 | same |
| `ambientcg-bricks001/` | Bricks 001 — brick wall 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Bricks001 | same |

Batch 2 (downloaded 2026-11-08, same `/get?file=<id>_1K-JPG.zip` flow; non-map extras and Displacement/NormalDX dropped). Unity copies (Color + NormalGL per set, plus `day_sky.exr` from `DayEnvironmentHDRI114_1K.zip`) live under `unity/Assets/StreamingAssets/Imported/Textures/`.

| Local dir | Asset | Source | License link |
| --- | --- | --- | --- |
| `ambientcg-wood096-timber/` | Wood 096 — alt timber grain, treatment-variant wood 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Wood096 | CC0, same as above |
| `ambientcg-planks002/` | Planks 002 — alt weathered planks 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Planks002 | same |
| `ambientcg-ice001/` | Ice 001 — frozen-water plane 1K-JPG (Color/NormalGL/Roughness; no AO shipped) | https://ambientcg.com/view?id=Ice001 | same |
| `ambientcg-bark016/` | Bark 016 — tree bark 1K-JPG (full PBR set) | https://ambientcg.com/view?id=Bark016 | same |

Downloaded 2026-08-25 via ambientCG `/get?file=<id>_1K-JPG.zip` and Poly Haven API
(`https://api.polyhaven.com/files/leafy_grass` → dl.polyhaven.org URL, md5-verified by host).
Non-map extras inside the zips (.blend/.usdc/.mtlx/.tres, Displacement, NormalDX) were dropped;
map sets are otherwise unmodified.
