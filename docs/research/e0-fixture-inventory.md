# E0 fixture inventory and classification (#192)

Build-sequence §5.1 inventory, recorded 2026-11-07 against the 37
golden fixtures in `tests/golden/` (each: `case.json` where present +
`golden.test.ts` + vitest snapshot, all with double-run determinism
canaries) plus the unit/perf suites. Classes per §5.1: **V** verbatim
semantic parity owed, **S** semantic-only, **R** redesigned in Rust
(fixture = regression reference, divergence list is the deliverable).

Reading of the E0 exit gate, reconciling its two clauses: §5.1's own
rule is "freeze before the port of that system starts, not all up
front — but the inventory and classification are E0 exit criteria."
So E0 freezes what exists (37 goldens, below), classifies every row,
and records explicit owed-fixture entries for the four rows that have
unit coverage but no golden yet. Each owed entry blocks its port
epic's entry gate, not E0's exit.

## Row-by-row (§5.1 order)

| TS system | Class | Frozen goldens | Other frozen coverage | Status |
|---|---|---|---|---|
| core `world/inbox/prng/digest/spatialHash` | V (contract) | m1t2 | `prng.test.ts`, `digest.test.ts`, `spatialHash.test.ts`, `ordersInbox.test.ts` | Frozen. Rust parity already proven bit-exact on m1t2 (#187). |
| `path/*` + movement | S | m1t4, m1t9, m1t10 (+ most economy goldens exercise paths) | `navigability.test.ts`, `formations.test.ts`, perf budgets | Frozen. Deliberate divergence on record: Rust applies paths in-tick, no 2-tick worker latency (C6). |
| gather/construction/training/production/placement/costs + economy/stockpile | V | m1t9, m1t10, m2t1, m2t2, m2t3 | `gather.test.ts`, `construction.test.ts`, `training.test.ts`, `production.test.ts`, `placement.test.ts` | Frozen. |
| combat (`systems/combat`, `sim/combat`) | V | m2t5a, m2t5b, m2t6, m2t7, m3t4, m3t9 | `combat.test.ts`, `balance/engagements.test.ts` | Frozen. |
| fog + knowledge | S | m2t8 (fog), m4t4a (knowledge) | `fog.test.ts` (incl. #192 recomputeAll-oracle test), `perf/fog.test.ts` (alias flaw fixed in #192; gate now honest) | Frozen. |
| lifecycle/school/skills/injuries/equipment/needs + `components/pop` | V→S | m3t5 (school+lifecycle), m3t2 (skills), m3t4 (injuries), m2t6 (equipment), m3t3 (needs) | `lifecycle.test.ts`, `school.test.ts`, `skills.test.ts`, `injuries.test.ts`, `equipment.test.ts`, `needs.test.ts`, `pop.test.ts` | Frozen. E11 mood-ledger additions diverge deliberately after. |
| households day-boundary formation | R | m3t6, m3t7, m3t8 (aggregate outcomes) | `households.test.ts` | Frozen as reference; Rust shards/incrementalises (199 ms hitch). |
| `ai/popBrain` job selection | R | m3t3, m3t5, m3t6, m3t7, m3t8 (T0 behaviour) | `popbrain.test.ts`, `perf/popbrain-budget.test.ts` | Frozen as reference; spatial pruning changes job picks by design. |
| AI planner (strategy roster) | S | m2t9, m2t10a, m2t10b, m4t6a, m4t6b, m4t6c | `ai/*`, `militaryManager.test.ts` | Frozen. |
| schedules/social/morale/culture | S | m3t6/m3t7/m3t8 (schedules, social), m3t9 (morale), m4t4a, m4t4b (culture) | `schedules.test.ts`, `social.test.ts`, `morale.test.ts` | Frozen. |
| mass (`systems/mass`) | S | — | `mass.test.ts` | **Owed:** record a golden before its port (E10/E11 band). Unit-frozen only. |
| companies/management | V | m4t1 (management), m4t2, m4t3, m4t5c (companies) | `companies.test.ts`, `companyExpansion.test.ts`, `management.test.ts` | Frozen. |
| market (`systems/market`) | V | — | `market-and-trade.test.ts` | **Owed:** record a golden before E9/E10 market port. Unit-frozen only. (Note: `sim/src/deep.rs` migration has no market likewise.) |
| age/conquest/relics/victory | S | m2t4 (age), m2t7 (conquest), m4t5a (victory), m4t5b (relics+victory), m4t4b | `age.test.ts`, `victory*.test.ts` | Frozen. |
| upgrades (`systems/upgrades`) | S | — (age ladder m2t4 exercises research adjacent paths) | `upgrades.test.ts` | **Owed:** record a golden before its port. Unit-frozen only. |
| scenario S5 (`sim/scenario`) | V | — | `scenario.test.ts`, `scenarioTriggers.test.ts` | **Owed:** record a golden before E14. Unit-frozen only. ADR-0010 keeps S5 mission-logic ownership. |
| mapgen + save/replay/mirror/session | S (formats break) | m1t3 (mapgen hash + terrain grid), m5t3-replay | `mapgen.test.ts`, `fourPlayerMapgen.test.ts`, `saveRoundTrip.test.ts`, `replay.test.ts`, `session.test.ts`, `perf/mirror.test.ts` | Frozen (outcomes; AOF1 byte formats die at the boundary per #165). |
| `data/definitions` + schema | V (data) | exercised by m2t1, m2t4 and all definition-driven goldens | `data/definitions.test.ts`, `data/civilizations.test.ts`, `data/building-models.test.ts` | Frozen (content values; codegen is E1/E3 work). |

## Counts

- 37 golden fixtures, all with recorded snapshots and double-run
  canaries; full TS suite state at freeze is recorded in #192's close
  comment (the `fixtures/v1-final` tag points at that commit).
- Rows fully frozen with goldens: 13 of 17. Owed-fixture rows: 4
  (mass, market, upgrades, scenario) — each unit-frozen, golden due
  before its system's port epic. Redesigned rows: households,
  popBrain (fixtures frozen as aggregate reference).

## Freeze rules from the tag forward

- TS `src/sim` behaviour changes after the tag require re-recording
  goldens (`npm run golden:record`) and a note in the consuming Rust
  epic — the TS game is now the behavioural oracle, not a second
  live authority (ADR-0012 §1).
- New per-system goldens land in `tests/golden/` following the m1t2
  harness shape (case.json + milestone digests + arrivals), so the
  Rust parity harness (`sim/src/parity.rs`) can consume them.
