# AAA HUD prototype (throwaway)

Answers [Prototype the AAA HUD](https://github.com/jamesm944/game/issues/149):
**which HUD structure should the AAA build adopt?**

This is not production code. It imports nothing from the app, persists
nothing, and is meant to be deleted once the winning structure is folded
into the real HUD.

## Run

```sh
npm run dev
```

Open <http://127.0.0.1:5173/prototype/aaa-hud.html>. D is the default.

Switch variants with the floating bottom bar, the `←` / `→` keys, or
`?variant=A|B|C|D`. The `1` / `2` / `3` / `4` keys jump directly, and
`Esc` opens or closes the pause/settings surface.

## Variants

| Key | Name | Structure |
| --- | --- | --- |
| A | **Royal Command** | Classic RTS command deck: top resource ribbon, left objectives, right victory paths, bottom three-zone deck (minimap · command card · inspector). |
| B | **Chronicle** | Sim-first: full-height settlement sidebar with named Pops, mood, needs and factions; contextual inspector on the right; slim command bar. The map stays dominant. |
| C | **War Table** | Diegetic parchment: royal commission scroll, victory banners, radial command ring around the selected building, council drawer, framed minimap. |
| D | **Crown & Chronicle** | AoE4-style: one 60px resource bar, one tabbed info panel, one bottom command deck (minimap · commands · training queue · inspector). The map is left open. |

All four show the same state: 58 Pops (cap 60), Epoch III / rank 7 of 24,
seven resources, six victory paths, a River Keep queue, and Pop mood /
health / needs / tax / unrest / factions. Compare **information hierarchy
and primary affordance**, not colour alone.

### D — Crown & Chronicle

The intended answer to "mix the variants, but make it a game, not a
dashboard". Modeled on Age of Empires IV:

- **Top bar (60px):** house crest and name, seven resources with income,
  current epoch and progress, speed controls, idle-villager and report
  badges, pause and settings.
- **Info panel (left, on demand):** one tabbed panel instead of two
  full-height rails. **Commission** holds the objective list and reward;
  **Victory** holds the six Victory Paths; **People** holds named Pops
  sorted by mood plus council loyalty. The settlement footer always shows
  mood / health / unrest / tax and opens People.
- **Map:** open centre with a selection ring, a contested crossing marker
  and a raid marker. No rails covering the playfield.
- **Command deck (bottom, 292px):** minimap and control groups · selection
  strip (HP and next queue item) · Train / Build / Research / Age tabs ·
  12 large command tiles with hotkeys and costs · 206px training queue ·
  contextual inspector.
- **Inspector tabs:** **River Keep** shows stats and upgrades; **People**
  shows the selected Pop's vitals, skills (practice vs theory), activity
  and civic state.
- **Villager orders:** selecting a Pop switches the command grid to
  Move / Gather / Build / Repair / Stop / Attack / Patrol / Guard /
  Garrison / Drop Off / Follow / Return, and the selection strip shows
  mood, health and needs.
- **Toasts (top right):** three field reports (houses needed, research
  complete, raid sighted), timed and colour-coded.
- **Responsive:** below 1440 the resource labels and training-queue column
  drop; below 1320 the bar keeps five primary resources; below 1100 the
  speed control, queue chip and command hint drop and the command tiles
  switch to icon + name. The layout fits a ~1024-wide pane without
  clipping or scrollbars.

The pause/settings surface is shared by every variant: audio, video,
gameplay and accessibility settings, plus an Objectives tab, Resume,
Save & Exit and Surrender. Settings are inert; this is a layout test.

## What to judge

- Can you tell what is urgent (houses, raid, idle villagers) at a glance?
- Is the sim depth (mood, health, needs, tax, unrest, factions) readable
  without burying the map?
- Is the command card the obvious next action?
- Do the top bar, info panel and command deck read as one hierarchy
  rather than competing panels?
- Does the HUD survive a 1280×800 window, a ~1024-wide pane and a busy
  mid-game state?

Screenshots: `hud-{A,B,C,D}.png` at 1600×900, `hud-*-1280.png` at
1280×800 and `hud-*-1024.png` at 1024×800. D also has `hud-D-pop*`,
`hud-D-people*`, `hud-D-victory*`, `hud-D-age*` and `hud-D-pause*`.

## Assets

- Backdrop: `docs/screenshots/dawn-village.png`, cropped to hide the old
  HUD baked into the screenshot.
- Portraits: `src/assets/atlas/villager.png` and `knight.png`, tinted with
  CSS. Town Center uses an inline SVG crest.
- Fonts: Cinzel + Inter, matching the current shell.

## Verdict

Record the chosen variant (or the mix, e.g. "D's deck with B's People
panel") on issue #149, then fold the winner into the real HUD and delete
this directory.
