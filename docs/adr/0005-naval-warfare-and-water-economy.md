# Naval Warfare, Water Economy & Initial Map 3 Build Roadmap

## Context

To surpass Age of Empires 2, Wayfinder Map 3 (#84) incorporates full naval warfare and water economy, asymmetric civilizations with 4-player skirmish, and modern RTS quality-of-life improvements. Following CC0 asset acquisition in #85 and 4-player skirmish simulation research in #86, Issue #87 grilled the architectural priority, unit scope, economy, and milestone release sequence.

## Decision

1. **Lead Pillar Frontier**: Naval Warfare & Water Economy leads the immediate implementation sprint (Milestones N1–N6).
2. **Naval Unit Scope**: The full 7-unit fleet is implemented in the initial release batch:
   - **Dock**: Coastal 3×3 hybrid structure (requires adjacent land for builders and open water for ship berths). Cost: 150 Wood.
   - **Fishing Boat**: Dark Age civilian vessel for water food harvesting. Cost: 75 Wood.
   - **Transport Ship**: Feudal Age amphibious vessel with base 5-unit garrison capacity (upgrades to 10 with Careening). Cost: 125 Wood.
   - **Galley**: Feudal Age arrow warship firing ranged volleys. Cost: 90 Wood, 30 Gold.
   - **War Galley**: Castle Age technology upgrade from Galley with improved HP, damage, and arrow count.
   - **Galleon**: Imperial Age technology upgrade from War Galley with maximum range and volley strength.
   - **Fire Ship**: Castle Age close-range anti-galley vessel firing a continuous high-frequency stream of flame projectiles. Cost: 75 Wood, 45 Gold.
   - **Cannon Galleon**: Imperial Age long-range coastal bombardment warship with +building siege bonus and minimum range. Cost: 200 Wood, 150 Gold.
3. **Water Economy**: AoE2 parity using discrete `Fish` resource nodes (Shore Fish: 200 food, Deep-Sea: 350 food) with physical cargo gathering (~0.43 food/sec) and pathfinding drop-off to coastal Docks.
4. **Pathfinding & Navigability**: Unified bitmask grid (`FLAG_WALKABLE_LAND = 1`, `FLAG_NAVIGABLE_WATER = 2`, `FLAG_SHORELINE = 4`) sharing the existing spatial grid and deterministic A* path scheduler without duplicate memory.
5. **Visuals & Juice**: Full procedural Kelvin wake ribbons, shoreline foam mesh, and tilting/sinking hull death animations.
6. **Milestone Roadmap (N1–N6)**:
   - **N1**: Water Grid & Hybrid Dock Placement (terrain bitmasks, shoreline detection, 3×3 hybrid placement validator).
   - **N2**: Coastal Dock & Fishing Economy (Dock construction, Fishing Boat unit, fish nodes, gather/drop-off loops).
   - **N3**: Amphibious Transport Ship (Garrisoning land units on water, coastal drop-off, island hopping).
   - **N4**: Galley Line Combat & Visual Juice (Galley/War Galley/Galleon, arrow volleys, Kelvin wakes, sinking VFX).
   - **N5**: Advanced Fleet: Fire Ship & Cannon Galleon (continuous flame streams, long-range coastal bombardment).
   - **N6**: Skirmish AI Water Coordination & Island Mapgen (AI dock building, fishing expansion, landing raids).

## Consequences

- Sim remains 100% deterministic at 30 Hz with zero Three.js imports in `sim/`.
- Existing `Garrison` component is extended to mobile entities (`Transport Ship`) with shoreline disembarkation raycasting.
- Land-only maps retain backwards compatibility with existing golden fixtures.
