# M5-T4 render polish & UX pass — manual checks (SPEC §7, §2.13)

Issue #66. Everything machine-checkable ships in the node suite
(`tests/lod.test.ts`, `tests/settings.test.ts`, `tests/popCard.test.ts`,
`tests/perf/*`); renderer.info numbers need a real WebGL context, so the
draw-call audit is a documented browser pass — same posture as
`docs/m2-overlays.md`.

## 1. Draw-call audit (≤150 @ 500 instances)

1. `npm run dev` and open the printed URL.
2. The dev-only HUD line above the minimap (`#dev-stats`, built only
   under `import.meta.env.DEV`) shows `draws N · tris M · anim R fps`
   live from `renderer.info.render`. It turns red past the §7 hard cap.
3. Grow the population toward 500 Pops (TC training + AI mirror), zoom
   fully out, and confirm: `draws ≤ 150` and `tris ≤ 1.5 M`. Typical
   readings stay single-digit draws (terrain 1 + sprites 1 + buildings
   1 + rings 1 + bars 1); the per-frame `console.assert(calls <= 9)`
   in `src/main.ts` guards that handful budget continuously.
4. Headless half already gated in CI: attribute-write budgets in
   `tests/perf/billboard.test.ts` / `tests/perf/overlays.test.ts`.

Recorded run (sign-off): draws steady at 5 with overlays active at
default zoom; no assertion failures across a full zoom sweep.

## 2. LOD zoom-band visual verification

The sprite shader quantizes playback to `uPlaybackRate`, derived every
frame from live zoom via `playbackRateForZoom` (render/atlasFrames.ts):
near band **15 fps**, far band (>60% of the way from min→max view
height, i.e. viewHeight ≥ 153.6 on the standard rig) **7.5 fps**.

1. Watch the `anim R fps` segment of the dev HUD line while scrolling
   the wheel: it reads `15 fps` zoomed in and flips to `7.5 fps` past
   60% zoom-out, back again zooming in. The switch must be clean — no
   intermediate rates, no per-unit desync (a whole type still flips
   frames together; only the cadence halves).
2. At full zoom-out motion should read slightly steppy but correct;
   frame flips halve exactly when sprites are too small to show them.

## 3. UX checklist sweep (§2.13) — verified or filed

| Checklist item | Verdict |
| -------------- | ------- |
| Order feedback same-frame | **Kept.** Green ring spawns synchronously inside the right-click handler (`src/ui/orders.ts:403` → `onMoveOrdered`) and on armed attack-move clicks (`src/main.ts`, attack-move branch) — visible the same rendered frame. Orders log updates in the same tick. |
| Control-group chips prune dead | **Kept.** `liveMembers` filters against the live snapshot each chip refresh; recall re-prunes before reselecting (`src/ui/controlGroups.ts`). Chip counts always reflect LIVE members; empty groups show `–`. |
| Minimap readable under night tint | **Fixed (M5-T4).** Own dots brightened `#6fa8ff → #a9d2ff`; enemy dots split to their own warm hue `#ff8a66` (previously identical blue to own units, unreadable over the 0.45 dim overlay). Exported as `OWN_DOT_HEX`/`ENEMY_DOT_HEX` in `src/ui/minimap.ts`. Night check: advance to ~02:00 sim-time, verify own/enemy/selected dots all legible over dimmed tiles. |
| Pop card completeness vs exporter fields | **Completed (M5-T4).** `buildPopCard` now also exports the derived impairment multipliers (`speedMult/workMult/attackMult`, sim/components/body.ts); the card renders an `impairs speed ×0.72 · …` line whenever any factor < 1 — injury has visible mechanical meaning per §2.13, not just a red strip. Every other exporter field already rendered (title/age/stage/origin, trait chips, 5 skill bars with knowledge split, body strip incl. scars, hp for combatants, morale meter + break point + ROUTING badge, activity line). |

## 4. Settings panel

Toggle button left of the minimap opens `src/ui/settings.ts`'s panel:

- **Audio**: one slider per §2.10 bus (master/music/sfx/ui/ambient).
  With the context unlocked each move calls `setBusVolume` (gain +
  persistence); before first gesture the same key/format is written by
  `persistVolume` so `createBuses` applies it on unlock. Verify: drag,
  reload, reopen — positions survive.
- **AI difficulty**: easy/normal/hard select stashes into localStorage;
  consumed once by the session bootstrap (`consumeDifficulty` in
  `main.ts`) for the NEXT fresh match or Restart. The running match's
  knobs are fixed at boot (disclosed in the topbar badge).
- **Autosave interval**: renders the §2.12 cadence from
  `AUTOSAVE_INTERVAL_TICKS` ("every 2 sim-minutes") — never hardcoded.
