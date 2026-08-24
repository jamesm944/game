# M4 Manual Browser Checks — SPEC §8 sign-off (M4-T7)

The M4 demo's sim half is proven headlessly: the six-path victory suite
(`tests/e2e/m4-paths.test.ts`, recorded in `docs/m4-budget.md`) wins via
EVERY §2.11 path against the live AI opponent, and
`tests/e2e/m4-company-growth.test.ts` shows a mining company expanding
itself AND an organic founding in one unattended run. Everything below needs
a browser + GPU and cannot execute in the headless harness. Run `npm run dev`
and work down the list. Any failure gets filed against an M4 follow-up issue.

## 1. Company oversight panel (§2.7, M4-T1/T2/T3)

- [ ] Chartering a company from a building panel (name, focus, seed
      workplaces) creates it live: branches listed, treasury ticking up as
      deliveries land, share slider rerouting the tithe percentage.
- [ ] Branch foremen appear WITHOUT any player appointment (exclusive
      staffing) — the panel shows them as company-seated, not player-seated.
- [ ] Auto-expansion: with auto-approve on, a new branch site appears near an
      unclaimed node paid from the treasury; with always-ask, a proposal
      notification arrives and approve/reject both resolve it.
- [ ] The expansion log reads as public history (executed/approved/rejected/
      founded entries in order).
- [ ] Freeze halts proposals and staffing churn but production and passive
      accrual continue; seize returns a branch to direct ownership; dissolve
      reverts Pops/workplaces cleanly.
- [ ] An organic founding surfaces its notification with the free-dissolve
      grace countdown; dissolving past the window charges the gold severance.

## 2. Victory paths UI (§2.11, M4-T4/T5)

- [ ] The victory panel lists all six paths with live readouts that match
      reality (capacity counts, sustained rate vs need, hold progress).
- [ ] Knowledge progress climbs during school hours and stalls at night;
      culture ticks on festivals/monument boundaries; economic tracks
      delivery bursts.
- [ ] Completing a Wonder or banking all relics flips the path's act state,
      and the hold timer visibly runs while it stands.
- [ ] A decision fires the correct victory/defeat overlay naming the path;
      Restart deals a fresh seed.

## 3. Delegation layer feel (§2.7, M4-T1)

- [ ] Foremen fill workplace slots from idle labor without orders; a direct
      player order always overrides (override rule) and dismissal is instant.
- [ ] Domain managers respect their strategy-weight sliders when shifting
      workers between workplaces of their domain.

## 4. AI difficulty disclosure (§2.8, M4-T6)

- [ ] The HUD difficulty badge matches the chosen preset; easy visibly slows
      AI reactions; hard's income cheat is disclosed (never hidden).

## 5. Performance sanity under the full stack

- [ ] With ~300 villagers, delegation + a running company active, the frame
      rate holds ~60 fps and the sim doesn't stutter when expansions fire.
- [ ] Record GPU numbers into `docs/m4-budget.md`'s table while checking
      this item.

## Sign-off

When every box above ticks, M4 closes fully (the headless gates stay green
in CI regardless).
