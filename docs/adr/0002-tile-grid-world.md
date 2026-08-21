# Tile-grid world representation

The world is a **uniform square tile grid**: default skirmish maps are 120×120 tiles (AoE2 tiny-to-small range), each tile 1 world unit. Terrain lives in per-layer `Uint8Array`s — terrain type, elevation level (integer steps 0–8; cliffs occur where adjacent levels differ), and derived passability — so maps serialize as raw bytes and flow-field/A* code runs on flat typed arrays (measured ~3 ms whole-map field rebuild at comparable size).

Resource nodes (trees, gold/stone mines, berry bushes, farms) are entities that occupy grid cells rather than baked terrain, so depletion/re-seeding is ordinary entity mutation. Entity identity is the bitecs entity id, assigned in stable ascending order to keep iteration deterministic.
