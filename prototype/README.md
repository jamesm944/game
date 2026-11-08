# AAA HUD prototype (throwaway)

Answers [Prototype the AAA HUD](https://github.com/jamesm944/game/issues/149):
**which HUD structure should the AAA build adopt?**

This is not production code. It imports nothing from the app, persists
nothing, and is meant to be deleted once the winning structure is folded
into the real HUD.

**D is the final synthesis, now carrying E's macro capacities.** A, B, C
and E are kept only as reference points for the comparison; they are not
competing recommendations.

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
| D | **Crown & Chronicle (final)** | AoE4-style shell with the sim depth folded in: one 60px resource bar plus a crown-favor chip, one four-tab info panel (Commission · Victory · People · Realm), one adaptive bottom deck (minimap · commands · queue · four-tab inspector). Realm opens with a four-cell crown pulse (favor · approval · unrest · tax) and splits into Tax / Council / Market; the deck switches between keep, squad, workplace and Pop modes. The map is left open. |
| E | **Imperium & Chronicle** | **Grand RTS & Pop Sim Synthesis** (Victoria 3 + EU5 + CK3 + DF/RimWorld + AoE4): Top bar capacities (Imperial favor, council approval, unrest %, net resource flow rates, class strata), left operational lenses (War, Civic & Tax, Council, Market, Deeds), adaptive bottom deck switching between CK3/DF Pop character sheet, AoE4 military tactical grid, and Manor Lords workplace production, plus Paradox outliner. |

All five show the same state: 58 Pops (cap 60), Epoch III / rank 7 of 24,
seven resources, six victory paths, a River Keep queue, and Pop mood /
health / needs / tax / unrest / factions. Compare **information hierarchy
and primary affordance**, not colour alone.

### E — Imperium & Chronicle (historical reference)

E is **not** the recommendation. It is kept because it contains useful
ideas (strata, bills, market, squad and workplace detail) that were folded
into D-final. In its own layout the top bar overflows, the minimap renders
black, and the civic drawer covers the map by default.

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

### D — Crown & Chronicle (final synthesis)

The answer to "mix the variants, but make it a game, not a dashboard".
Modeled on Age of Empires IV's shell, with Against the Storm's corner
discipline and Manor Lords' panel restraint:

- **Top bar (60px):** house crest and name, seven resources with income,
  a compact crown-favor chip, current epoch and progress, speed controls,
  idle-villager and report badges, pause and settings.
- **Info panel (left, on demand):** one tabbed panel instead of two
  full-height rails. **Commission** holds the objective list and reward;
  **Victory** holds the six Victory Paths; **People** holds named Pops
  sorted by mood, and shows the selected Pop's practice-vs-theory skills;
  **Realm** holds the sim-depth controls. The settlement footer always
  shows mood / health / unrest / tax and opens People.
- **Realm crown pulse:** the Realm tab opens with E's macro capacities in
  one compact strip — favor, approval, unrest and tax — before the
  sub-tabs. It gives the sim state a single read without adding a second
  bar or a permanent rail.
- **Realm sub-tabs:** **Tax** is a live rate slider with income, four
  social strata, loyalty and mood; **Council** is a pair of active bills
  with ayes bars and a Vote action plus four faction loyalties; **Market**
  is a goods table with stock, price and seven-day trend. Moving the tax
  slider updates the pulse, footer tax chip, income and market tax
  immediately.
- **Map:** open centre with a selection ring, a contested crossing marker
  and a raid marker. No rails covering the playfield.
- **Command deck (bottom, 292px):** minimap and control groups · selection
  strip (HP and next queue item) · Train / Build / Research / Age tabs ·
  12 large command tiles with hotkeys and costs · 206px training queue ·
  contextual inspector.
- **Inspector tabs:** **Keep** shows stats and upgrades; **Squad** shows
  the River Guard's strength, morale, supply, counter triangle and roster;
  **Works** shows the Lower Ward Workshop's recipe, input/output buffers
  and workers; **People** shows the selected Pop's vitals, thought ledger
  and current activity. All four fit without scrolling at 1600, 1280 and
  1024 widths.
- **Adaptive deck:** the selection strip, command tabs, command grid and
  queue column all switch with the inspector. Keep keeps Train / Build /
  Research / Age and the training queue; Squad shows 12 squad orders and
  the company roster; Works shows 12 workshop orders and the production
  queue; a Pop shows villager orders, that Pop's day and the thought
  ledger.
- **Villager orders:** selecting a Pop switches the command grid to
  Move / Gather / Build / Repair / Stop / Attack / Patrol / Guard /
  Garrison / Drop Off / Follow / Return, and the selection strip shows
  mood, health and needs.
- **Toasts (top right):** three field reports (houses needed, research
  complete, raid sighted), timed and colour-coded.
- **Responsive:** below 1440 the resource labels and training-queue column
  drop and the inspector compacts its head; below 1320 the bar keeps five
  primary resources; below 1100 the favor chip, speed control, queue chip
  and command hint drop and the command tiles switch to icon + name. Every
  panel, inspector tab and Realm sub-tab was measured at 1600×900,
  1280×800 and 1024×800 with no clipping or scrollbars.

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

Screenshots: `hud-{A,B,C,D,E}.png` at 1600×900, `hud-*-1280.png` at
1280×800 and `hud-*-1024.png` at 1024×800. D-final also has
`_final-D-{realm-tax,realm-council,realm-market,squad,works,people,pop,victory,pause}.png`
at 1600×900, plus the 1280 and 1024 checks. `_final-sheet-{1,2,3}.jpg`
collects every situation, and `_compare-D-vs-E-{1,2}.jpg` keeps the
side-by-side that led to the mix.

## Assets

- Backdrop: `docs/screenshots/dawn-village.png`, cropped to hide the old
  HUD baked into the screenshot.
- Portraits: `src/assets/atlas/villager.png` and `knight.png`, tinted with
  CSS. Town Center uses an inline SVG crest.
- Fonts: Cinzel + Inter, matching the current shell.

## Verdict

D-final — Crown & Chronicle with E's crown pulse — is the locked
synthesis ([ADR-0011](../docs/adr/0011-crown-and-chronicle-hud.md)). The
user signed off on 2026-11-06; fold it into the real HUD, then delete this
directory.
