# M2 Manual Browser Checks — SPEC §8 sign-off (M2-T11)

The M2 demo's sim half is proven headlessly (`tests/e2e/m2-full-game.test.ts`,
recorded in `docs/m2-budget.md`). Everything below needs a browser + GPU and
cannot execute in the headless harness. Run `npm run dev`, play one skirmish
vs the AI (restart button re-seeds), and work down the list. Any failure gets
filed against an M2 follow-up issue.

## 1. Visual frame rate under M2 load (fog + overlays active)

- [ ] With ~100+ units on screen and fog revealed, DevTools performance meter
      (or three.js stats) holds ≈60 fps — frame time < 16 ms (GPU rows of the
      §7 table: draw calls via `renderer.info.render.calls`, triangles, frame
      time; fill them into `docs/m2-budget.md`).
- [ ] Zoom out >60%: far-band throttle kicks in (animation slows visibly,
      fps does not drop).

## 2. Fog of war rendering

- [ ] Unexplored map renders black; explored-not-visible terrain is dimmed
      (~0.55 brightness); visible terrain full-bright.
- [ ] Enemy units vanish when they leave your units' sight radius; enemy
      BUILDINGS leave greyed "memory ghosts" at their last-known tile that
      clear when re-sighted or observed destroyed.
- [ ] No fog flicker while units march (temporal smoothing across ticks).
- [ ] Minimap: unexplored black / explored dimmed / visible bright with live
      dots; own Pops always dotted, enemy dots only in vision — readable at a
      glance during a fight (readability check).

## 3. Combat feel & overlays

- [ ] Attack-move (A + right-click): units engage enemies en route and RESUME
      the march after kills.
- [ ] Counter table visible in outcomes (e.g., knights shred villagers-line
      defenses; buildings fall slowly to melee).
- [ ] Health bars/selection rings overlay cleanly (≤ 2 extra draw calls worth
      of geometry); damage shows before death; rubble appears where buildings
      die and passability re-opens (units path through).
- [ ] Victory/defeat overlay fires on conquest (raze the AI's barracks +
      stable) and Restart boots a fresh world on a new seed.

## 4. Economy & production UI

- [ ] New gatherables (iron/coal/clay) show in the topbar when gathered;
      Sawpit/Kiln/Smithy/Forge/Kitchen recipes produce their commodities.
- [ ] Age-up: Feudal/Castle research runs at the TC, jingle hook fires
      (audio lands in M5; no error today), gated buttons unlock
      (stable → scout/knight line).
- [ ] Drop-off filters respected (a mill that takes only food never accepts
      wood).

## 5. AI opponent sanity

- [ ] The AI visibly booms: trains villagers, builds its barracks/stable,
      advances ages — then attacks once it has an army (fast-castle-knights).
- [ ] No AI wallhacking: scouting first always reveals its forces before they
      move out.

## Sign-off

When every box above ticks, M2 closes fully (the headless gates stay green in
CI regardless). Record GPU numbers into `docs/m2-budget.md` §table while
checking item 1.
