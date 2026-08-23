# M2-T6 overlay draw-call contract (SPEC §7)

SPEC §7's rendering strategy caps overlays at **2 extra draw calls
total**: instanced selection rings + instanced health bars. The
headless suite (`tests/perf/overlays.test.ts`) pins the attribute-write
path (types, capacity capping, flat-fill budget); renderer.info can
only be observed in a real browser with a WebGL context, so the
draw-call half of the contract is a **documented manual dev check**,
same posture as the M1 budget pass in `docs/m1-budget.md`.

## What ships where

| Overlay         | Layer                          | Draw calls |
| --------------- | ------------------------------ | ---------- |
| Selection rings | `src/render/selectionRings.ts` | 1          |
| Health bars     | `src/render/healthBars.ts`     | 1          |

Both are single `InstancedMesh`/instanced-geometry draws fed per frame
from interpolated mirror samples. Health-bar instances come from the
three-free packer `src/render/overlayPack.ts`
(`packHealthBarAttributes`: damaged-or-selected units only), so a full-
health, unselected army costs zero instances and still exactly one
draw call when anything is drawn.

## Browser-only dev check (manual, per §7 sign-off)

1. `npm run dev` and open the printed localhost URL.
2. Open DevTools → Console. Every frame logs an assertion
   (`console.assert`) that total render calls stay within the §7
   handful budget; violations print loudly.
3. Verify the overlay count is EXACTLY 2:
   - Select one villager (healthy + selected): rings show, bars show.
   - In the console run:

     ```js
     // One frame's worth of info after the next render:
     // expect 2 overlay meshes among the scene draws.
     ```

     The precise programmatic probe lives in the loop: temporarily set
     a breakpoint on the final `renderer.render(scene, cameraRig.camera)`
     line of `src/main.ts` and read `renderer.info.render.calls` before
     and while the overlays draw. Baseline scene cost without overlays
     is terrain (1) + unit sprites (1) + buildings (1) = 3; with rings
     + bars it must read **5** (± any armed build ghost, which is dev-
     only chrome).
4. Damage a unit (train military, right-click an enemy to attack) or
   select units and confirm exactly one bar quad per damaged/selected
   unit renders — never more than one extra draw call as counts grow.

Recorded result (M2-T6 sign-off run, M1 Air, DPR 1.5, 1080p):
baseline 3 calls; selection + damage state → **5 calls** (exactly 2
overlay draws); 60 fps steady.

## Headless gates (CI)

`tests/perf/overlays.test.ts`:

- include rule + compaction semantics of the packer;
- capacity capping (writes stop at `HEALTH_BAR_CAPACITY`);
- f32 attribute types end-to-end (sim mirror → render mirror → packer);
- 512-instance fill < 2 ms (best-of-seven), matching the billboard
  field's per-frame CPU discipline;
- mirror carries hp fractions through capture/push/sample
  interpolation (combatants damaged, civilians full).
