# M3 Manual Browser Checks — SPEC §8 sign-off (M3-T10)

The M3 demo's sim half is proven headlessly
(`tests/e2e/m3-village-week.test.ts`, recorded in `docs/m3-budget.md`): one
unattended village week with zero player commands — kids graduate, families
form, tavern rounds happen, Sunday Mass lands, the economy grows. Everything
below needs a browser + GPU and cannot execute in the headless harness. Run
`npm run dev`, let a village breathe (the e2e's scenario is a good template:
houses + school + church + tavern and a few dozen villagers), then work down
the list. Any failure gets filed against an M3 follow-up issue.

## 1. Pop card visuals (§2.13 "Pop card", M3-T1/T2/T4/T9)

- [ ] Selecting one villager opens the Pop card: name/age/origin, trait
      chips, five skill bars, health bar with injury status.
- [ ] Skill bars MOVE over time: a wood-chopping villager's relevant skill
      creeps up; a long-idle villager's practice visibly rusts toward their
      knowledge floor (§2.3 rust).
- [ ] Traits differ between villagers (weighted/conflicting generation) and
      school graduates carry visibly more/better traits than unschooled adults.
- [ ] An injured villager shows the hurt body part AND visibly slower
      movement/work — injury has mechanical meaning, not just a red bar.

## 2. Day/night lighting tint (§2.4, M3-T6)

- [ ] Sky/light color tracks the sim clock: dawn warms up, midday neutral,
      dusk cools, night is dark-but-readable — tint-only, no gameplay fog of
      war change.
- [ ] The full 8-minute day cycles without stutter or pop at boundaries.
- [ ] At ~22:00 villagers walk home and disappear into houses; the town
      empties; at ~05:00 they stream back out (staggered, not a teleport).

## 3. Minimap with social dots (§2.9 projection + §2.4 evenings)

- [ ] Minimap live dots track the village's rhythm: clustered at work nodes
      by day, streaming to tavern/church in the evening, packed at homes at
      night — social life is readable from the minimap alone.
- [ ] Sunday morning: dots converge on the church for Mass, then disperse
      into rest-day leisure.
- [ ] Dots never desync from world positions (minimap is a pure projection,
      never independent state).

## 4. Village life feel (the demo itself)

- [ ] Watch one full week without clicking: kids are born, attend School
      (9am–3pm) and graduate; couples pair off into houses; babies appear.
- [ ] Evenings show venue traffic: some villagers drink at the tavern
      (gold topbar ticks down), pious ones visit the church, sociable ones
      call on friends.
- [ ] No idle-storm: evening departures/beddings trickle instead of everyone
      pathfinding in the same frame (§2.4 ±90 s jitter).
- [ ] Needs have visible consequences: a hungry villager detours to eat; a
      sleep-deprived one naps mid-shift; nobody starves while food income
      holds.
- [ ] Leaving the game alone for minutes never stalls it — the IAUS brain
      keeps everyone employed, fed and housed (the §8 demo definition).

## Sign-off

When every box above ticks, M3 closes fully (the headless gates stay green in
CI regardless). Record GPU numbers into `docs/m3-budget.md` §table while
checking item 1.
