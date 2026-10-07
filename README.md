# Ageofwind — an AoE2-better browser RTS

Single-player browser real-time-strategy that uses Age of Empires 2 as its base
model and deliberately exceeds it: data-driven entities seeded with documented
AoE2 numbers, Dwarf-Fortress-style individually simulated people (skills,
traits, injuries, needs, families, schooling), delegated management (Foremen →
Managers → Companies absorb the micro), and six Civ-style victory paths.
Deterministic 30 Hz simulation, golden-fixture tested. TypeScript + Three.js +
Vite, no backend ever.

Personal-use project: never distributed to real users; single-player only.

## Quickstart

Prerequisite: Node 22.

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`). A skirmish boots
against the scripted AI on a fresh 120×120 map.

### Your first villager

1. **Box-select** the starting settlers (left-drag) and **right-click** a
   forest tile — they chop wood, haul it back to the Town Center, and repeat.
2. **Click the Town Center**, then hit **Train Villager (50 food)** in its
   panel; the queue countdown shows underneath.
3. Open the **build menu** (bottom-left grid), pick House, and place the green
   ghost near your TC before you hit the pop cap. Barracks, farms, camps and
   more unlock as you advance ages.
4. Select villagers and right-click berries/gold/stone/iron/coal/clay to grow
   the economy — or just appoint Foremen and Managers (building panels) and
   let delegation run the town while you plan the war.

Victory is decided by the evaluator in the top-right HUD: Conquest, Wonder,
Relic, Knowledge, Culture, or Economic — all six are winnable against the AI.

## Controls

| Input                         | Action                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| Left-drag                     | Box select                                                 |
| Click / Shift-click           | Select / add-toggle                                        |
| Double-click                  | Select all of same type on screen                          |
| Right-click                   | Contextual order: move, gather, deposit, attack            |
| Shift + Right-click           | Queue waypoint / chain orders (heterogeneous cascading)    |
| `A` then left-click           | Attack-move (auto-acquires targets en route)               |
| `S`                           | Stop immediately                                           |
| `P` then left-click           | Patrol route                                               |
| `G` then left-click           | Guard unit or perimeter                                    |
| `Z`                           | Cycle combat stance (Aggressive / Defensive / Stand / Off) |
| `F` / `X` / `C` / `V`         | AoE2 Formations: Line, Box, Staggered, Flank               |
| `B` / `N` / `M` / `K`         | Bannerlord Formations: Shield Wall, Square, Circle, Wedge  |
| `.` / `>` / `I`               | Idle workers: cycle / select all                           |
| `R` / `Alt+.`                 | Smart redistribution of idle workers across camps          |
| `Esc`                         | Cancel armed cursor / toggle pause menu (saves + replays)  |
| `Ctrl`/`⌘`+`1..4`             | Store selection as control group                           |
| `1..4`                        | Recall group · double-tap centers camera                   |
| `WASD` / arrows / screen edge | Pan camera                                                 |
| Mouse wheel                   | Zoom toward cursor                                         |
| Minimap click / drag          | Jump camera                                                |

## Formations & Speed Harmonization

Groups moving in tactical formations automatically harmonize their cruise speed to the slowest member in the squad, preserving cohesive rank-and-file geometry during marches:

- **Shield Wall (`B`)**: Tight 0.65-tile spacing, +2 pierce armor bonus against ranged fire, with -20% cruise speed.
- **Staggered (`C`)**: Dispersed 2-tile spacing to minimize splash damage from mangonels and catapults.
- **Flank (`V`)**: Splits the force into twin envelopment wings.
- **Wedge (`K`)**: Arrowhead spearhead designed for cavalry penetrations.

## Saves, replays & settings

- **Saves** live in the pause menu (`Esc`): three rolling autosaves (every 2
  sim-minutes) plus named manual slots, each with Load / Export / Delete.
  Slots persist in IndexedDB; Export downloads a portable `.ageof` file and
  Import re-validates it loudly (magic → version → map hash).
- **Replays**: the same menu exports this match's `.ageofreplay` artifact or
  imports one for headless re-simulation. Attach a replay to a bug report and
  turn it into a permanent golden fixture with `npm run replay:to-fixture`.
- **Settings** (button left of the minimap): per-bus audio volume (master /
  music / sfx / ui / ambient), AI difficulty for the next match (easy /
  normal / hard — knobs disclosed, hard adds an income cheat), and the
  autosave cadence readout.

## Development

```bash
npm run lint        # eslint + prettier
npm run typecheck   # tsc --noEmit
npm test            # full suite: golden fixtures, properties, perf gates (<60 s)
npm run build       # tsc --noEmit && vite build → dist/
npm run preview     # serve the built bundle
```

Performance budgets (SPEC §7) are asserted in CI and recorded per milestone in
`docs/m{1,2,3,4,5}-budget.md`; manual-only checks live beside them in
`docs/*-manual.md`. Architecture and domain glossary: `CONTEXT.md`,
`docs/adr/`, `SPEC.md`.

## Release

Pushing a `v*` tag runs `.github/workflows/release.yml`: lint → typecheck →
full suite → build → deploy `dist/` to GitHub Pages, plus a zip of `dist/`
attached to the GitHub release for manual itch.io upload (the build uses a
relative asset base, so both hosts work from the same artifact). Nightly
soak/perf telemetry runs separately from CI gates.
