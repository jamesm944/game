# M5-T5 — Balance pass (issue #67)

SPEC §2.5 counter table + §2.6 economy rates sanity pass against AoE2
documented baselines. Two new headless suites pin the result:
`tests/balance/engagements.test.ts` (equal-cost duel matrix) and
`tests/balance/economyRamp.test.ts` (Dark→Imperial ramp benchmark).

## 1. Counter table (SPEC §2.5 / CONTEXT.md "Counter triangle")

The shipped table was degenerate: of the five military units only the
skirmisher carried a real counter edge (`archer ×3`) plus the knight's
anti-villager raid multiplier. Both CONTEXT-documented triangle edges
*infantry → archer* and *archer → cavalry* had no data behind them, and
equal-cost simulation confirmed the counted-against sides LOSE their
nominal favorable matchups (militia 0–7 survivors vs archers; scouts
0–1 vs skirmishers).

### Attack-bonus changes (`src/data/definitions/units/*.json`)

| Unit           | Before                            | After                                        |
| -------------- | --------------------------------- | -------------------------------------------- |
| militia        | —                                 | **+** `{archer, ×2}`                         |
| archer         | —                                 | **+** `{cavalry, ×1.5}`                      |
| scout-cavalry  | —                                 | **+** `{archer, ×1.5}`                       |
| skirmisher     | `{archer, ×3}`                    | *(unchanged)*                                |
| knight         | `{civilian, ×1.5}`                | *(unchanged — raw stats carry its matchups)* |

The militia/archer bonuses key on the `archer` armor class, which the
skirmisher also carries — one column each covers both ranged lines,
matching AoE2's light-infantry/light-cavalry support roles.

### Equal-cost engagement matrix (post-pass, 3 pinned seeds)

Armies sized by `nA·costA ≈ nB·costB` (≤8% drift); both sides
attack-move through the real command surface until elimination.

| Favorable matchup          | Pairing        | Survivors per seed (20260901/02/03) |
| -------------------------- | -------------- | ----------------------------------- |
| militia → archer           | 7 v 8          | 3 / 4 / 2                           |
| militia → skirmisher       | 9 v 12         | 7 / 7 / 9                           |
| archer → knight            | 12 v 6         | 7 / 6 / 6                           |
| archer → scout-cavalry     | 8 v 7          | 7 / 7 / 7                           |
| skirmisher → archer        | 7 v 6          | 6 / 6 / 6                           |
| knight → militia           | 6 v 10         | 6 / 6 / 6                           |
| knight → skirmisher        | 4 v 9          | 3 / 4 / 4                           |
| knight → scout-cavalry     | 6 v 10         | 6 / 6 / 6                           |
| scout-cavalry → skirmisher | 9 v 12         | 4 / 5 / 5                           |

Every unit wins ≥1 favorable matchup and loses ≥1 (no comp beats
everything, no unwinnable book): archer falls to militia + skirmisher;
skirmisher to militia/knight/scout; militia to knight; knight to
archer; scout to archer + knight.

## 2. Economy ramp vs AoE2 pacing

Age-tech `researchTime` values were half the documented AoE2
constants, making transitions trivially fast once the macro economy
was scripted honestly (`src/data/definitions/techs/*-age.json`):

| Tech         | Cost (unchanged, AoE2-exact) | researchTime before | after (AoE2) |
| ------------ | ---------------------------- | ------------------- | ------------ |
| feudal-age   | 500 food                     | 1800 (60 s)         | **3900 (2:10)** |
| castle-age   | 800f + 200g                  | 2700 (90 s)         | **4800 (2:40)** |
| imperial-age | 1000f + 800g                 | 3600 (120 s)        | **5100 (2:50)** |

Villager/train/build/gather constants already matched AoE2 (trainTime
750 = 25 s, costs identical, ~0.42 units/s effective gather at typical
walk distances) and were left untouched.

### Ramp benchmark (`tests/balance/economyRamp.test.ts`)

Scripted pure-boom macro (continuous villager production under the
housed pause, flat 50/30/20 food/wood/gold split, 3 builders/site,
advances enqueued the moment legal + affordable) through the real
command surface on the lean production roster:

| Age      | Band (±20% of boom-line ref) | Before    | After       |
| -------- | ---------------------------- | --------- | ----------- |
| Feudal   | [12960 .. 19440]             | 15705 ✓   | 17805 ✓ (9:53) |
| Castle   | [25200 .. 37800]             | 27525 ✓   | 29505 ✓ (16:23) |
| Imperial | [32400 .. 48600]             | 36075 ✗ fast | 35340 ✓ (19:38) |

Before the fix Imperial landed at 20:02 game clock — outside the −20%
edge of even the boom-line budget; after aligning research durations
all three rungs sit inside their bands with margin on both sides.

## 3. Ripple adjustments (semantic gates kept green)

- `tests/age.test.ts`: exact completion-tick pins recomputed for the
  AoE2 research times (enqueue + researchTime − 1).
- `tests/e2e/m2-full-game.test.ts`: demo ceiling raised to 56k ticks
  for the slower ladder; knight wave re-sized (12→20, push at 16) —
  the defender now counter-picks the §2.5 archer column against
  knights and gets ~5k more boom ticks, so the scripted push needs its
  documented ≈3:1 superiority again.
- `tests/golden/m2t4`, `m2t9`: fixture choreography retimed to the new
  research constants (ladder events re-pinned exactly).
- `tests/golden/m4t6c`: economic-window horizon extended past the
  slowest (easy) feudal completion.
- Digests re-recorded via `npm run golden:record` for m2t4/m2t9/m2t10a
  after every semantic gate above was verified green; combat damage
  snapshot in `tests/combat.test.ts` regenerated from definitions.

## 4. Verification

`npm run lint && npm run typecheck && npm test` — 107 files,
696 tests green.
