# Converted GLB (Blender 5.2 LTS, headless)

FBX/OBJ → GLB conversions (64 files, 0 failures) of the FBX-only Quaternius
packs, so the stranded packs become runtime-loadable in Three.js and glTFast:

| Source (FBX/OBJ, CC0) | Converted |
| --- | --- |
| `quaternius-medieval-village/` (45 FBX) | `converted-glb/quaternius-medieval-village/` |
| `quaternius-farm-buildings/` (14 FBX) | `converted-glb/quaternius-farm-buildings/` |
| `quaternius-farm-animals/` (7 OBJ) | `converted-glb/quaternius-farm-animals/` |

Conversion (deterministic, re-runnable): `blender -b --python <convert script>`
imports each `.fbx`/`.obj` into an empty scene and exports `GLB` with
`export_apply=True`, cameras/lights off. All outputs JSON-chunk-validated.
Key buildings (Inn, Sawmill, Stable, Well, Blacksmith, BigBarn…) are also
copied to `unity/Assets/StreamingAssets/Imported/` for the Unity runtime.
