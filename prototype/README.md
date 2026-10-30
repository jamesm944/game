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
| E | **Imperium & Chronicle** | **Grand RTS & Pop Sim Synthesis** (Victoria 3 + EU5 + CK3 + DF/RimWorld + AoE4): Top bar capacities (Imperial favor, council approval, unrest %, net resource flow rates, class strata), left operational lenses (War, Civic & Tax, Council, Market, Deeds), adaptive bottom deck switching between CK3/DF Pop character sheet, AoE4 military tactical grid, and Manor Lords workplace production, plus Paradox outliner. |

All four show the same state: 58 Pops (cap 60), Epoch III / rank 7 of 24,
seven resources, six victory paths, a River Keep queue, and Pop mood /
health / needs / tax / unrest / factions. Compare **information hierarchy
and primary affordance**, not colour alone.

### E — Imperium & Chronicle (Grand RTS Synthesis)

The comprehensive synthesis answering the user's requirement to look beyond simple RTS HUDs and integrate **Victoria 3**, **EU5 / Project Caesar**, **Crusader Kings III**, **Dwarf Fortress / RimWorld**, and **Manor Lords** alongside **Age of Empires IV**:

- **Top bar (60px):**
  - Left: House crest, civ, and **Rank Progression across 24 historical tiers** (`Epoch III · Rank 7/24`).
  - Center: 7 gatherable resources with net production flow rates (`+18/m`, `+12/m`...) and Market Inflation Index (`1.04×`).
  - Right: **Macro State Capacities**: Population by strata (`58/60: 32 Peasants, 14 Working, 8 Burghers, 4 Nobles`), Imperial Favor (`★ 4.8/10`), Council Approval (`61%`), Class Unrest / Radicalism risk (`24%`), and active Job Tax Rate (`15%`).
- **Left Operational Lens Rail (Victoria 3 style):**
  - 5 dedicated lenses (`⚔ War`, `⚖ Civic & Tax`, `👑 Council`, `⚒ Market`, `📜 Deeds`).
  - Clicking a lens opens a slide-out drawer (380px) for that domain while leaving the playfield edge-to-edge clear. Clicking it again closes it.
  - **Civic & Tax Drawer:** Live income tax rate slider, Victoria 3-style social strata table (Standard of Living, population, tax share, unrest), grain subsidies toggle, and household demographics.
  - **Town Council Drawer:** Active legislative session ("Bill #14: Royal Salt & Iron Surcharge" voting countdown), 4 estate factions loyalty, and voting actions.
  - **Market Drawer:** Commodity supply/demand table with live fluctuating prices (Planks, Tools, Weapons, Bricks), plus autonomous Chartered Companies with pending expansion proposals.
- **Adaptive Bottom Deck (286px):**
  - Adapts contextually between 3 operational modes via the deck mode switcher:
  - **Mode 1: Citizen Pop Selected (CK3 + RimWorld + Dwarf Fortress):**
    - *Col 1:* Minimap, control groups, Day/Night time dial.
    - *Col 2 (CK3 Character Sheet):* Large expressive portrait, Pop Name (`Godwin of Deep Seam`), Social Strata (`Peasant Laborer`), Age (38), Household (`Godwin & Elsbeth`), and persistent health/injuries (`Scarred foot`).
    - *Col 3 (RimWorld Thought Ledger):* Hunger, Rest, and Morale meters + live thought drivers (`[+6] Warm hearth`, `[-8] Salt tax (15%)`, `[-14] Saw goblin raid scout`, `[-5] Double shift`).
    - *Col 4 (DF Skills & IAUS Brain):* Practice vs Theory skill bars (Mining 77, Masonry 45, Melee 38) + current IAUS utility assignment and cooldown timer.
    - *Col 5 (Citizen Direct Orders):* Assign Job, Send to School, Visit Tavern (Morale), Draft to Militia, Rehome Household.
  - **Mode 2: Military Squad Selected (AoE4 + CoH3):**
    - Squad composition (12 Footmen, 8 Archers), aggregate HP (1,840), Combat Counter Triangle bonuses (+4 vs Cavalry, -3 vs Siege), Morale break point (82%), 12 tactical RTS commands (Move, Attack, Patrol, Stop, Line/Box/Stagger/Flank formations, Stances), and reinforcement training queue.
  - **Mode 3: Workplace Selected (Manor Lords + Anno 1800):**
    - Industry card (River Ironworks Tier II), production recipes (`2 Iron Ore + 1 Coal ➔ 1 Weapons + 1 Tools`), input/output buffer storage, market value created (360g), appointed Foreman (Osric), and physical cart walker logistics.
- **Right Rail Outliner (Paradox / CK3 style):**
  - Collapsible sticky triage cards: Idle Pops (3, click to cycle), Raid warning banner (North ford), active Council session vote, and Grand Wonder construction stage.

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
