# Historical Epochs & Eras Progression Architecture

Comprehensive technical and gameplay design for expanding the 4-tier AoE2 age system into a multi-epoch historical saga spanning Antiquity to the Atomic Age.

## 1. The 6 Historical Epochs

| Epoch | Key Technologies & Concepts | Unit Lines | Architectural & Visual Kit |
| --- | --- | --- | --- |
| **1. Classical Antiquity** | Phalanx, Triremes, Philosophy, Masonry, Coinage | Hoplite, Peltast, Chariot, Trireme | White marble columns, amphitheatres, aqueducts |
| **2. Feudal Middle Ages** | Castles, Heavy Stirrups, Manorialism, Watermills | Man-at-Arms, Knight, Crossbow, Longship | Timber & thatch, stone keeps, fortified gates |
| **3. Colonial Age of Sail** | Compass, Caravel, Matchlocks, Mercantilism | Muskeeter, Pikeman, Galleon, Sloop | Half-timbered merchant houses, stone bastions, brick docks |
| **4. Industrial Revolution** | Steam Engine, Metallurgy, Railways, Factories | Rifleman, Gatling Gun, Ironclad, Steam Train | Brick chimneys, iron bridges, cobbled streets, gas lamps |
| **5. World Wars Era** | Internal Combustion, Trench Warfare, Radio, Armor | Trench Infantry, Tank, Biplane, Dreadnought | Concrete bunkers, barbed wire, asphalt, factory complexes |
| **6. Cold War & Atomic Era** | Radar, Jet Propulsion, Nuclear Fission, Computers | Mechanized Infantry, Main Battle Tank, Jet, Submarine | Concrete brutalism, radar domes, missile silos, highways |

## 2. Technical Sim Migration (from `src/sim/systems/age.ts`)

- Extend `AgeState` rank from `1..4` to `1..6`.
- Add Era-specific transition requirements beyond simple resource escrow (e.g., Industrial requires Coal & Iron infrastructure standing; Atomic requires Uranium / Research Reactor).
- Dynamic definition filtering (`activeTrainableUnitsFor`, `availableBuildingsForAge`) extended cleanly across all 6 epochs.
