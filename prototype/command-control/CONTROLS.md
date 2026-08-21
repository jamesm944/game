# CONTROLS.md — prototype/command-control

PROTOTYPE (throwaway) answering issue #8: *what does an AoE2-style command & control layer need to feel right in a browser?* Every interaction implemented in this mock is listed below.

## Selection

| Input | Effect |
|---|---|
| Left-drag on map | Box select own units (falls back to a building if the box contains none) |
| Left-click unit / building | Select it |
| Shift + left-click | Toggle entity in/out of selection |
| Shift + box select | Add box contents to current selection |
| Double-click a unit | Select every unit of the same type on screen |
| Left-click empty ground | Deselect all |
| Esc | Cancel active mode (placement / attack-move), otherwise deselect |

## Orders (right-click contextual)

| Target under cursor | Effect |
|---|---|
| Ground | Move — sunflower formation offsets, expanding green ring marker |
| Enemy raider | Attack — red crosshair marker locks to target; enemies retaliate against their last attacker |
| Tree / gold pile | Villagers gather (yellow pulse marker), non-villagers just move; gather → walk to nearest drop-off → deposit loop increments wood/gold in the topbar |
| Nothing (building selected) | Set rally point for the selected building — flag drops with bounce, dashed line from building while selected |

Every order also appends a line to the **Orders log** panel (top-right).

## Attack-move & stop

| Input | Effect |
|---|---|
| `A`, then left-click | Attack-move: orange ring marker; units engage any enemy within ~130px en route |
| `S` | Stop: selected units go idle |

## Control groups

| Input | Effect |
|---|---|
| `Ctrl`/`⌘` + `1..4` | Store selected units as group N (chip flashes, log entry) |
| `1..4` | Recall group N as selection |
| `1..4` twice within ~350ms | Center camera on group N |
| Dead units | Auto-pruned from groups; chip shows live member count |

Group chips sit bottom-center and are clickable to recall.

## Camera

| Input | Effect |
|---|---|
| Arrow keys (hold) | Pan |
| Click / drag on minimap | Jump camera to that world position |
| `F` | Center camera on selection |

## Building placement

| Input | Effect |
|---|---|
| Click a build-menu tile (bottom-left grid: House / Mill / Barracks / Tower) or press `B` to spotlight the menu | Enter placement mode |
| Mouse move | Ghost preview snapped to a 16px grid; green = valid, red = collides with trees/gold/buildings/map edge |
| Left-click | Place (free — resources mocked) |
| Right-click or Esc | Cancel |

## Info card (bottom-right)

- **Single unit** → individual Pop card: generated name, role, age, origin, trait chips, five skill bars (Farming/Mining/Woodcutting/Combat/Building), health bar with injury status (Wounded = 75% speed, Critical = 50% speed — actually applied to movement), current order, carried resources.
- **Multi-select** → count by type + average health.
- **Building** → HP bar + rally-point status.
- **Minimap** shows trees, gold, buildings, blue/red unit dots, white highlight for selected, and the camera viewport rectangle.
