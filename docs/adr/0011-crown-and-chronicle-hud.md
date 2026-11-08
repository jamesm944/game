# Crown & Chronicle: one shell, one panel, one adaptive deck

- **ADR:** 0011
- **Date:** 2026-11-06
- **Status:** Accepted
- **Context Issues:** [jamesm944/game#149](https://github.com/jamesm944/game/issues/149) (AAA HUD prototype), [jamesm944/game#140](https://github.com/jamesm944/game/issues/140) (Wayfinder Map 6: AAA Supremacy), building on [#148](https://github.com/jamesm944/game/issues/148) (art bible), [#151](https://github.com/jamesm944/game/issues/151) (taxation and unrest), [#154](https://github.com/jamesm944/game/issues/154) (council), [#155](https://github.com/jamesm944/game/issues/155) (Emperor Favor)

## Context

#149 asked which HUD structure the AAA build should adopt. The prototype compared five shells — A Royal Command, B Chronicle, C War Table, D Crown & Chronicle, and E Imperium & Chronicle — against 13 game references and 39 screenshots, then narrowed to D and E.

E exposed the most macro state at once (favor, approval, unrest, tax, social strata), but its top bar overflowed at 1600px, its minimap rendered black, its civic drawer opened over the map by default, and its council drawer was transparent and low-contrast. D kept the map open and the hierarchy legible, but hid too much of the sim state behind the Realm tab.

The user reviewed D and E side by side and chose **“Mix D shell + E capacities”**: keep D's layout, add selected E macro readouts.

## Decision

1. **D's shell is the production HUD.** One 60px top bar, one four-tab info panel (Commission · Victory · People · Realm), one adaptive bottom deck (minimap · commands · queue · inspector), and an open map. No permanent left lens rail and no right outliner.
2. **E's macro capacities are folded in, not its shell.** A compact crown-favor chip sits in the top bar. The Realm tab opens with a four-cell crown pulse — favor, approval, unrest, tax — above Tax / Council / Market. The tax slider drives the pulse, footer, income and market tax together.
3. **The map stays the primary surface.** Panels are on-demand and edge-hugging; the settlement footer always shows mood, health, unrest and tax and opens People.
4. **The deck is contextual, not modal.** Keep / squad / workplace / Pop selection swaps the selection strip, command tabs, command grid and queue or inspector without changing the shell.
5. **Responsive rules are part of the decision.** At ≤1440 resource labels and the queue column drop and the inspector compacts; at ≤1320 only five primary resources remain; at ≤1100 the favor chip, speed control, queue chip and command hint drop. The HUD was verified at 1600×900, 1280×800 and 1024×800 with no clipping or panel/inspector scrolling.

The layout and information architecture are renderer-agnostic. The prototype is HTML/CSS (`prototype/aaa-hud.html`); the production binding follows the chosen presentation layer (ADR-0009) and must not reintroduce a second navigation rail or a dashboard of always-open panels.

## Trade-offs considered

- **E's shell**: maximum macro visibility, but overflow, overlay and contrast defects; rejected.
- **D without E capacities**: cleaner, but the player could not see favor or approval without leaving the map context; rejected.
- **A, B and C**: kept as historical references; their structures (classic ribbon, full-height sidebar, parchment radial) were not selected.
- **Costs accepted**: Realm is a second click for full macro detail; mitigated by the always-visible favor chip and the settlement footer. A future production pass may promote one more capacity if playtesting shows it is needed, but not by adding a permanent rail.

## Evidence

- Prototype: `prototype/aaa-hud.html` (D default), `prototype/README.md`.
- Final captures: `prototype/_final-sheet-{1,2,3}.jpg`, `prototype/_compare-D-vs-E-{1,2}.jpg`.
- Commit: `49c2924`.
- User sign-off: 2026-11-06.

## Consequences

- The production HUD needs bindings for favor, approval, unrest and tax; the prototype's static values are placeholders, not data contracts.
- The prototype directory remains evidence until the production HUD is folded in, then it is deleted (per its README).
- Any future HUD proposal that adds a permanent lens rail, right outliner or always-open macro drawer must supersede this ADR rather than grow beside it.
