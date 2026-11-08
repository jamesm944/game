# Map 8 build sequence: ordered epics and validation gates from the locked roadmap

- **Issue:** [jamesm944/game#184](https://github.com/jamesm944/game/issues/184)
- **Map:** [jamesm944/game#182](https://github.com/jamesm944/game/issues/182) (Wayfinder map 8: Build the AAA Game)
- **Date:** 2026-11-07
- **Mode:** research and planning only; no code integrated, no donor code copied, no issue closed by this document
- **Inputs (primary sources, all read in full):** Map 6 [#140](https://github.com/jamesm944/game/issues/140) Decisions-so-far; `docs/research/open-source-donor-integration-roadmap.md` (12 phases, #160); `docs/research/deep-sim-workloads-and-scaling.md` (tiers + spike protocol, #164); `docs/research/donor-build-and-test-inventory.md` (pinned donors, #161); `docs/research/save-and-replay-compatibility-boundary.md` (#165); ADR-0007/0008/0009/0010/0011; `SPEC.md`; `CONTEXT.md`; sibling Map 8 tickets #183/#185/#186/#187/#188; current `src/` + `tests/` tree on `research/df-rw-deep-sim` @ `c11baae`.

## 1. Executive result

The locked roadmap sequences into **17 epics (E0–E16)** on one critical spine — freeze the TS reference → skeleton → determinism proof → core RTS loop → combat/fog/AI → persistence → judged vertical slice → logistics → housing/tax → emotional Pops → politics → epochs → campaign — with presentation, HUD and the Ink runtime as parallel tracks that join the spine at named gates. Every epic below carries entry/exit gates expressed in the repo's existing vocabulary: golden fixtures, replay/hash equality across 1/2/4/8 workers, and per-tier perf budgets (T0 300 / T1 1k / T2 5k / T3 20k Pops).

Three findings shape the order and are **not** papered over (full register in §7):

1. **ADR-0008's migration order (deep systems greenfield first, TS keeps movement/combat, both sims live together) conflicts with the #165 hard-break boundary and the one-authoritative-store rule.** This sequence therefore ports the core loop first and treats ADR-0008 Phases 1–2 as superseded in order, not in architecture. A confirming ADR amendment is owed (§7, C1).
2. **"Parity" cannot mean TS hash equality.** #165 explicitly rejects matching v1 float quirks and byte layouts, so #187's "final-state hash equality" must be read as *semantic trace equality against frozen TS fixtures, plus Rust-internal hash equality across worker counts* (§7, C2).
3. **The vertical-slice anchor is still undecided** (#183, HITL). E8 is written so both candidates on record — Epoch-1 settlement doubling as campaign chapter 1/tutorial, or a mid-game stress slice — share E0–E7 unchanged; only E8's content list and tier target move (§6).

**No `ROADMAP.md` exists in this repo** (verified 2026-11-07). The roadmap of record is #140's Decisions-so-far plus `SPEC.md` §8 (M1–M5 + Maps 2–5.2, all shipped, v1.1.0). References to "the roadmap" below mean those two sources.

## 2. Where the build starts: today's state (E0 entry facts)

| Asset | State today | Source |
|---|---|---|
| TS game | v1.1.0 shipped: 31 system files in `src/sim/systems/`, 29-system production roster via `wireSkirmishSystems` in `src/game/session.ts`, S5 scenario engine in `src/sim/scenario/`, 37 golden fixture dirs in `tests/golden/`, perf gates in `tests/perf/` | `package.json`; `src/game/session.ts`; `tests/` listing |
| Behavioural reference role | "The TypeScript/three.js game remains the behavioral reference during migration" | ADR-0009 |
| Engine lock | Unity URP presentation + Rust authoritative sim; Godot preserved fallback; prototype on branch `codex/hybrid-engine-prototype` (`33621e4` baseline, digest `68c9dc948474e127`, 500 Pops) | ADR-0009; #140 notes |
| Sim lock | Rust native binary, shipyard ECS + Rayon + SoA, FlatBuffers bridge, sorted-ID phase-barrier determinism, 30 Hz | ADR-0008 §§1–4 |
| Narrative lock | Ink single runtime (Unity integration); S5 data triggers own mission logic; story state = versioned blob in Rust saves, advanced only by allowlisted sim commands | ADR-0010 |
| Epoch lock | 8 Master Epochs × 3 Sub-Ages = ranks 1–24, triple gate (tech + institutional readiness + Great Wonder quota), starting era + era cap, diffusion | ADR-0007; `CONTEXT.md` §Historical Epochs |
| Current era code | Still 4-age AoE2 ladder: `ageGateSchema` enum + `AGE_RANK` 1=dark…4=imperial in `src/data/schema.ts`, `src/sim/systems/age.ts` | source, verified |
| Movement lock | Integer grid A* retained after full Recast/flow-field gates (#162/#167/#168/#169/#170/#171/#172/#173); versioned FIFO is production control; Recast re-gate only after build-off-critical-path | #140 Decisions-so-far; `docs/research/recast-vs-astar-full-scale.md` |
| HUD lock | Crown & Chronicle: D shell + E capacities (favour chip, crown pulse: favour/approval/unrest/tax) — supersedes #140's stale "Locked Variant E" gist | ADR-0011 (2026-11-06) |
| Campaign lock | Single-settlement Chronicle: 8 epoch chapters, 1 flagship mission each (Wonder finales), chapter 1 = tutorial, one headline deep-sim system per chapter, curated starts, no save import, data-only S5 missions | #150 via #140 |
| Donors | 8 repos pinned + audited under `scratch/donor-audit/`; Generals = verified determinism donor, Voidstrike = source donor (pinned checkout does not typecheck/build), Widelands = best routing fixtures, DFHack Orders = best automation fixtures, Augustus/RimWorld mods need new adapter tests | `docs/research/donor-build-and-test-inventory.md` §1 |
| Distribution lock | macOS + Windows standalone direct builds, M1/16 GB reference floor, browser demo capped (~1k Pops, three.js + WASM), no telemetry/updater | #181 via #140 |
| Missing systems (measured absence) | No faction/tax/council/edict system in `src/`; production exists on only 2 building defs (`workSlots: 1`); W3/W4/W6 unmeasurable until built | `deep-sim-workloads-and-scaling.md` §6 |

Open Map 8 siblings this sequence must absorb, not duplicate: **#183** vertical-slice anchor (HITL grilling), **#185** Unity toolchain pin, **#186** production Unity+Rust skeleton, **#187** Rust ECS parity proof, **#188** Ink-in-Unity spike. They map to E8's entry decision, E1, E1, E2 and E14's spike respectively (§5).

## 3. Gate vocabulary (harmonised; used by every epic)

### 3.1 Determinism gates

- **Golden fixtures:** command-stream + seed + milestone digests (`SPEC.md` §7 digest recipe: FNV-1a-64, milestones every 30th tick + final; recording via `npm run golden:record` only, hand-editing digests forbidden). v1 fixtures archive at tag `fixtures/v1-final` and leave the CI gate; v2 fixtures start fresh from the first Rust tick (ADR-0008 §5; #165 §3). **The tag does not exist yet** (`git tag` shows only `v1.0.0`, `v1.1.0`) — creating it is E0 work.
- **Worker-count equality:** every v2 golden/replay must produce byte-identical milestone digests at `RAYON_NUM_THREADS=1,2,4,8` (#165 §3.2; ADR-0008 §5). This is the machine-verifiable determinism proof; it is a *release* gate for every sim epic from E2 on, not a final-epic concern.
- **Replay/hash equality:** same seed + same command trace ⇒ identical final digest on re-run, per the Generals donor pattern (record → parse/play twice → per-frame CRC + RNG checkpoint vs live; first-divergent-frame reporting) in `web/src/sim/replayDeterminism.test.ts`, `gate4Determinism.test.ts`, `stateHashHarness.ts` @ `816b259c` (donor inventory §3, Priority 1).
- **Save round-trip:** capture → restore → recapture equality, including mid-activity, mid-shipment, mid-vote, mid-request and mid-dilemma saves (donor roadmap Phases 5–8 exit gates; Generals `sim/simSnapshot.ts` + 135 tests @ `816b259c`).
- **TS semantic parity (E0–E4 only):** where a system is ported verbatim, Rust output must match the frozen TS semantic trace (entity-level outcomes, event order keyed `(tick, phase, sourceEntity, sequence, eventType)` per donor roadmap Phase 2) — **not** v1 digest bytes (#165 §1.3 rejects float-quirk matching; see C2).

### 3.2 Perf budgets per tier

Canonical thresholds are `deep-sim-workloads-and-scaling.md` §8, restated here so epics can cite one table. Workloads: W1 economy+deep Pop, W2 combat+fog, W3 logistics+production, W4 politics+society, W5 delegation+companies, W6 everything (§8 mixes; W1/W2 measured in TS, W3–W6 specified-only until the systems exist, §6/§10).

| Tier | Pops | Entities | Map | Players | Tick budget | Source |
|---|---:|---:|---|---:|---|---|
| T0 floor | 300 | ~1,000 | 120² | 2 | p95 ≤ 8 ms (= today's SPEC §7 contract) | deep-sim §7/§8; `SPEC.md` §7 |
| T1 target | 1,000 | ~3,000 | 192² | 2–4 | p95 ≤ 33.3 ms; Rust must beat TS CPU means (W1 ≈10.9 ms @1k) | deep-sim §7/§8 |
| T2 production | 5,000 | ~15,000 | 256² | 4 | p95 ≤ 33.3 ms **and p99 ≤ 33.3 ms for a production claim**; worst single tick ≤ 100 ms; latency wall p95 ≤ 66 ms | deep-sim §8 |
| T3 stretch | 20,000 | ~60,000 | 384² | 4 | reported, **not gated** | deep-sim §7/§8 |

Protocol rules that bind every perf gate (deep-sim §8/§9/§10): ≥150 warmup + ≥600 measured ticks **including one day boundary and one evening think-wave** (the tail is event-shaped: households day pass, PopBrain storm, repath storms, §2); per-system means + worst-30-tick histogram; digest equality across worker counts in the same run; quiet machine (load < 2) with calibration kernel recorded — all TS absolutes to date were taken at load 5–15 and are upper bounds (§Method). ADR-0008 §6's spike target ("<8 ms full hot loop at 5k **and 20k** entities on **M2**") conflicts with this table on tier, machine and strictness — treated as superseded by §8 pending amendment (C4).

Renderer budget (presentation epics): `SPEC.md` §7 (≤150 draw calls hard cap, ≤12 ms frame hard cap, mirror ≤2 ms @500) was written for three.js billboards; the Unity prototype measured frame p50 8.41 ms / p95 8.93 ms uncapped @500 Pops on M1 (ADR-0009). E5 must re-derive a Unity-native budget table; carrying the three.js numbers forward unexamined would be a false gate (C9).

### 3.3 Standing invariants every epic inherits

1. One authoritative entity store, one Activity implementation; donor code behind adapters with pinned commit + copied-path manifest (donor roadmap §4 rules 1–3, §5 constraints in donor inventory).
2. Rendering/audio/UI consume snapshots/events and never mutate sim state; AI and narrative enter through the same command inbox as the player (donor roadmap §4; ADR-0009; ADR-0010 §3).
3. Parallel workers compute proposals; cross-entity conflicts resolve at phase barriers in sorted entity-ID order; worker count and completion timing cannot change output (ADR-0008 §3; donor roadmap §3.2 invariant).
4. All randomness from named seeded streams; no wall-clock inside sim or stories (donor roadmap §4 rule 6; ADR-0010 §2).
5. Meaning is never keyword-matched: no keyword/regex/substring interpretation of player language in sim, triggers, dilemmas or HUD (ADR-0010 §6; machine-wide rule).
6. Fog-honest AI: observations only through `KnowledgeView`, cheats disclosed (donor roadmap Phase 10; current `src/sim/systems/knowledge.ts` pattern).
7. A slice is not done until its golden test passes; every sim-behaviour change ships a fixture (`SPEC.md` §7 agent workflow rule).

## 4. The sequence at a glance

| Epic | Title | Depends on | Tier reached | Vertical slice? |
|---|---|---|---|---|
| E0 | Freeze the reference: v1 archive, semantic fixture corpus, donor quarantine | — | T0 (TS) | Blocker |
| E1 | Production skeleton: Unity pin, Rust crate, FlatBuffers bridge, empty settlement | E0 | T0 | Blocker |
| E2 | Determinism spike: shipyard kernels, 1/2/4/8-worker proof, TS parity harness | E1 | T1–T3 (kernels) | Blocker |
| E3 | Core RTS loop port: commands, movement (A\*), economy, building | E2 | T0→T1 (W1) | Blocker |
| E4 | Combat, fog and AI opponent port | E3 | T1 (W2) | Blocker |
| E5 | Unity presentation: terrain, water, cameras, art pipeline | E1 (joins at E3 snapshots) | 500 visible | Blocker |
| E6 | HUD, front end and audio skeleton | E1, E5 shell | — | Blocker (shell) |
| E7 | Persistence productised: AOF2 saves, replays, fixture CI | E3, E4 | T1 | Blocker |
| E8 | Vertical slice assembly and judgement (anchor: #183) | E3–E7 | T0/T1 per #183 | **The slice** |
| E9 | Physical logistics and economic automation (+ delegation at scale) | E8 | T1→T2 (W3, W5) | Later |
| E10 | Housing tiers, Pop wealth, taxation, sentiment | E9 | T2 (W1-deep) | Later |
| E11 | Emotional Pops: thought ledgers, wounds, rooms, chronicles | E10 | T2 (W4 floor) | Later |
| E12 | Politics and storyteller: council, Emperor, unrest, dynamic incidents | E10, E11 | T2 (W4) | Later |
| E13 | Epochs pipeline: 24 ranks, triple gate, wonders, diffusion, content batches | E9–E12 schemas | T2 | Later (first transition may be in slice: #183) |
| E14 | Campaign, tutorial and Ink narrative production | E7 blob, E12, E13 | T1–T2 | Later (spike parallel from E1) |
| E15 | Map/scenario editor and mods | E8, E14 runtime | — | Later |
| E16 | Scale, hardening and ship: W6/T2 claim, audio content, desktop builds, browser demo | E9–E15 | T2 gated, T3 reported | Later |

Donor-roadmap traceability: Phase 0→E0, Phase 1→**closed** (ADR-0008/0009/0010 decided what it left open), Phase 2→E1+E2, Phase 3→E5 (Unity rewrite, not TSL harvest — C5), Phase 4→E3+E4 (bake-off already resolved by #173: retain A\*), Phase 5→E9, Phase 6→E10, Phase 7→E11, Phase 8→E12, Phase 9→E13, Phase 10→E14+E15+E4/E16 (AI split), Phase 11→E16 + gates distributed into every epic.

## 5. The epics in order

### E0 — Freeze the reference: v1 archive, semantic fixture corpus, donor quarantine

**Goal:** make the TS game a frozen, machine-checkable behavioural oracle before any Rust line is load-bearing. Absorbs donor roadmap Phase 0 and extraction-order step 1 (donor inventory §4: "Determinism contract first").
**Entry gate:** none. This is the only epic that can start today with zero open decisions.
**Work:**
- Tag `fixtures/v1-final` at the last TS-only commit; remove v1 goldens from the v2 CI gate; declare the TS feature freeze trigger explicitly (two different triggers are on record — C3).
- **Fix the fog perf gate before freezing it:** `tests/perf/fog.test.ts`'s resolver aliases the stored stamp object so re-stamps are skipped; it measures queue dedupe, not stamping (deep-sim §3: honest 0.88 ms vs gated 0.04 ms @300). Freezing a false gate would poison E4's parity target.
- Record the frozen semantic corpus (§5.1 table): per TS system, seed + command trace + milestone digests + semantic event trace, on 32×32/small maps per `SPEC.md` §7 layout, plus property fixtures (resource-conservation ledger, full damage-counter table, A\* termination).
- Refresh donor quarantine: `third_party/manifest.json` + per-donor copied-path manifests at the audited pins (Voidstrike `4df02351`, Generals `816b259c`, OpenRA `dbe67473`, Widelands `bfc7713d`, Augustus `dae1899e`, DFHack `438faf3b`, RimWar `aab38d57`, PickUpAndHaul `09f1fac9` — donor inventory §1); local clones already at `scratch/donor-audit/{browser,rts,city,mods}/`.
- Port the Generals harness *patterns* (not production code) as the parity tooling spec: `web/src/sim/replayDeterminism.test.ts`, `gate4Determinism.test.ts`, `stateHashHarness.ts`, `simSnapshot.ts` @ `816b259c`.
**Donor entry points:** Generals paths above (`scratch/donor-audit/browser/generals-rts-threejs-port/web/src/sim/`). No other donor code enters in E0.
**Exit gate:** tag exists; full TS suite green at the tag (`npm test`, incl. 37 goldens twice-run canary); fog gate honest; every TS system in §5.1 has ≥1 frozen semantic fixture or an explicit "redesigned, no parity owed" entry; donor manifest complete for all 8 pins.
**Blocks:** everything. **Slice:** blocker.

#### 5.1 What must be frozen as TS fixtures before Rust ports

Rule: **freeze before the port of that system starts, not all up front** — but the *inventory and classification* are E0 exit criteria, because #165's hard break means anything not frozen as a semantic trace is behavioural knowledge that exists only in TS source. Three classes: **V** = verbatim parity owed (semantic trace must match), **S** = semantic-only (outcomes/aggregates match within characterised divergence), **R** = redesigned in Rust (freeze only as regression reference; divergence list is the deliverable).

| TS source (freeze this behaviour) | Class | Why / note |
|---|---|---|
| `src/sim/core/{world,inbox,prng,digest,spatialHash}.ts` — tick order, late-command rejection, seeded streams, digest recipe | V (contract) | The determinism contract itself; Rust re-implements, fixtures prove equivalence of *rules* |
| `src/sim/path/*`, `src/sim/path.worker.ts`, `systems/movement.ts` — integer A\*, string-pull, slot assignment, dueTick application | S | Rust A\* runs in-tick in parallel, not via 2-tick-latency worker (ADR-0003 `PATH_LATENCY=2`); path *results* must match, application timing changes deliberately (C6) |
| `systems/{gather,construction,training,production,placement,costs}.ts` + `src/sim/economy/`, `core/stockpile.ts` | V | Core loop economics; resource-conservation property is the key fixture |
| `systems/combat.ts`, `src/sim/combat/` — damage counters, morale effects | V | SPEC §7 full damage-table snapshot ports directly |
| `systems/fog.ts`, `systems/knowledge.ts` | S | Fix gate first (above); `updateKnowledgePass` O(buildings×players) may be restructured (deep-sim §10.7) |
| `systems/{lifecycle,school,skills,injuries,equipment,needs}.ts`, `components/pop.ts` | V→S | Port verbatim in E3/E11; mood-ledger additions in E11 diverge deliberately after |
| `systems/households.ts` day-boundary formation | **R** | Proven O(couples×entities×households) single-tick hitch (199 ms @2k, deep-sim §2); Rust shards/incrementalises it. Freeze aggregate outcomes only |
| `src/sim/ai/popBrain.ts` job selection | **R** | Thinkers×candidates ≈n² (deep-sim §3); Rust needs spatial pruning/advertised-jobs index, which changes *which* job a Pop picks. Freeze behaviour at T0 scale as reference, expect characterised divergence |
| `src/sim/ai/` planner (strategy, `wireSkirmishSystems` roster) | S | No phase home in ADR-0008 (C7); scheduling changes, decisions-on-same-knowledge must match |
| `systems/{schedules,social,morale,culture,mass}.ts` | S | Rare-tick cadences preserved; E11/E12 extend state |
| `systems/{companies,management,market}.ts` | V | Delegation (M4) semantics; W5 scale-out is new, T0 behaviour is frozen |
| `systems/{age,upgrades,victory,conquest,relics}.ts` | S | 4-age semantics freeze as the rank-1..4 subset behaviour; E13 generalises to 24 |
| `src/sim/scenario/{engine,triggers,presets,types}.ts` (S5) | V | ADR-0010 keeps S5 as mission-logic owner; trigger semantics port verbatim |
| `src/sim/mapgen/`, `src/game/{session,saveManager,replayPlayer,replayFixture}.ts`, `src/sim/{save,replay,mirror}.ts` | S (formats break) | Map hashes + save/restore *outcomes* freeze; byte formats are AOF1 and die at the boundary (#165) |
| `src/data/definitions/**` + `src/data/schema.ts` (Zod) | V (data) | JSON definitions are the reusable asset (#165 §4.1); Rust/Unity consume via new codegen (E1), content values freeze |

### E1 — Production skeleton: Unity pin, Rust crate, FlatBuffers bridge, empty settlement

**Goal:** the #186 skeleton on the #185 toolchain: judged foundation, no gameplay beyond placeholder Pop movement.
**Entry gate:** E0 exit (freeze declared, so skeleton work can't drift TS behaviour); #185's pin decision (prototype `6000.3.11f1` vs installed `6000.6.6f1`, ADR-0009 costs) recorded with one-command headless macOS+Windows builds of a trivial scene.
**Work:**
- Production Unity project layout decided relative to the TS game (#185) — note an untracked `My project/` Unity dir already exists in the checkout; E1 must adopt-or-replace it explicitly, not accrete a second project.
- Rust crate: shipyard world, 30 Hz fixed tick, phase skeleton per ADR-0008 §3 (with two additions owed by evidence: an AI-planner phase home and a rare/global-passes phase — deep-sim §11, C7).
- `.fbs` schema as single source of truth for `Command`, `Snapshot`, `GameEvent` (ADR-0008 §4); `flatc` codegen for Rust + C# (ADR-0008 says TypeScript accessors — superseded by ADR-0009's Unity client, C5). Transport decision recorded here: ADR-0008 specifies a Tauri sidecar over Unix socket/named pipe, but the client is now a Unity standalone (#181), so sidecar-process-under-Unity vs in-process plugin must be chosen in E1 — it is currently **undecided** (C5).
- Bridge semantics from donor comparison (donor inventory §4 step 2): Generals `web/src/browser/simRenderBridge.ts` (+19 tests @ `816b259c`) for lifecycle/reconciliation/ObjectID-reuse contracts; Voidstrike `src/engine/workers/{GameWorker,WorkerBridge,types,RenderStateAdapter}.ts` @ `4df02351` as reference for snapshot/interpolation shape only (its save system is explicitly excluded: worker `localStorage` dependency, simplified restore — donor inventory §3 Priority 2).
- Empty coastal settlement reusing the hybrid prototype's judged terrain/camera work (`prototypes/hybrid/` on `codex/hybrid-engine-prototype`); content-definition pipeline: `src/data/definitions/**.json` → Rust (Serde) + Unity from one source (donor roadmap §3.2 Serde row; #165 §4.1).
**Exit gate:** #186's own bar — deterministic tick at T0 scale through the real bridge; save/load round-trip replays identically; James judges foundation (structure, iteration speed, look). Plus: schema-version + engine/schema IDs present in every container from day one (#165 §1.4).
**Blocks:** E2, E5, E6. **Slice:** blocker.

### E2 — Determinism spike: shipyard kernels, 1/2/4/8-worker proof, TS parity harness

**Goal:** #187 + ADR-0008 Phase 0, executed under the deep-sim §9 protocol. This is the gate every later sim system depends on (#187).
**Entry gate:** E1 bridge + tick skeleton; E0 frozen corpus available.
**Work:**
- Implement the three hot kernels the evidence names — movement integration, PopBrain-style think scoring (with the spatial-pruning redesign stubbed in so its cost shape is measured, not just the n² original), fog flush — in shipyard/Rayon (deep-sim §9 protocol). ADR-0008 §6 names mood-ledger rollup + economic summation + pathfinding reservation instead; run **both** lists or record why one list subsumes the other (the mood ledger doesn't exist in TS to port — it's E11 state; measuring a synthetic rollup is fine, calling it parity is not).
- Differential harness: old (TS) and new (Rust) implementations against the same command stream, semantic traces compared, first-divergence reporting (donor roadmap Phase 2; Generals `stateHashHarness.ts` pattern).
- One frozen TS reference scenario end-to-end in Rust (#187's scenario), digest-equal across 1/2/4/8 workers.
- Re-check ADR-0008's "<0.2 ms localhost round-trip" at real snapshot rates: 23 B/unit logical payload ⇒ 1.4 MB/s @2k units, 13.8 MB/s @20k at 30 Hz (deep-sim §5).
**Exit gate:** §9 protocol run at T1/T2/T3 kernel scale on a quiet machine: per-system speedup vs worker count, phase-barrier wait time, digest equality at 1/2/4/8, measured window includes day-boundary + evening think-wave analogues; TS CPU means re-recorded on the same quiet machine before any ratio is claimed (deep-sim §7 caveat); parity on the reference scenario = semantic equality or a characterised, deliberate divergence list judged trustworthy by James (#187). Amdahl expectation set in advance: ≤1.7×/2.6×/3.4× at 2/4/8 workers from TS shares (deep-sim §9) — a spike claiming more must show which serial system it sharded.
**Blocks:** E3. **Slice:** blocker. *If E2 fails, the fallback of record is single-threaded Rust as a stepping stone (ADR-0008 Considered Options), not a return to TS.*

### E3 — Core RTS loop port: commands, movement (A\*), economy, building

**Goal:** a headless-playable skirmish economy in Rust at TS parity: spawn, move, gather, build, train, produce. This epic deliberately **reorders ADR-0008 Phase 3 before its Phase 1** (C1): deep systems need a living core loop to attach to, and #165 forbids the dual-sim runtime ADR-0008 Phase 2 describes.
**Entry gate:** E2 exit; E0 fixtures frozen for every system ported here (§5.1 V-rows).
**Work / donor entry points:**
- Command inbox + Activity queue: port missing behaviours only — current TS already follows OpenRA's model (`src/sim/activities/`); donor reference `OpenRA.Game/Activities/Activity.cs`, `OpenRA.Mods.Common/Activities/` @ `dbe67473` for queued attack/patrol/garrison/transport/repair/cancel-resume semantics, with new lifecycle tests (upstream has none for activities — donor inventory §3 Priority 4).
- Movement: integer A\* per ADR-0003 as amended by #173 (retain A\*, versioned FIFO semantics, stale-passability rejection, exact formation slots). No Recast, no flow-field migration in this epic; both are closed gates, re-openable only on new evidence. PathFinding.js (`src/finders` @ donor roadmap §3.2) stays reference-only — #162 showed no advantage.
- Map/world: tile grid + passability versioning (ADR-0002/0003), seeded mapgen outcome-parity with `src/sim/mapgen/`.
- Economy core: gather/carry/drop-off, stockpiles, construction, training, production queues from frozen TS semantics.
**Exit gate:** W1 at T0 p95 ≤ 8 ms and T1 p95 ≤ 33.3 ms (quiet machine); v2 goldens for every ported system green at 1/2/4/8 workers; semantic parity vs frozen traces on V-class systems; save/load resumes mid-activity and mid-construction; input latency 1 tick applied / 1 tick visible under sync-equivalent transport at T1 (deep-sim §5 gate).
**Blocks:** E4, E7, E9. **Slice:** blocker.

### E4 — Combat, fog and AI opponent port

**Goal:** W2 in Rust: melee/ranged/naval-adjacent combat as frozen, fog with the honest gate, and the AI opponent on `KnowledgeView`.
**Entry gate:** E3 exit; fog frozen fixture is the post-fix honest one (E0).
**Work / donor entry points:**
- Combat: frozen damage-counter table; target acquisition/stance heuristics may draw on OpenRA mod activities + Generals `web/src/sim` selective modules @ `816b259c` behind differential tests (donor roadmap §3.1: module-by-module, no wholesale replacement).
- Fog/shroud: keyed source counts + dirty-cell resolution pattern from `OpenRA.Game/Traits/Player/Shroud.cs` @ `dbe67473` as design reference; the per-flush building-knowledge pass must be measured, not assumed (deep-sim §10.7).
- AI planner gets its explicit phase home here (C7): it was the second-largest system under combat in TS (0.76→3.23 ms as armies tripled, deep-sim §4) and multiplies per AI player unless sharded/budgeted. Voidstrike `src/engine/ai`, `src/engine/systems/ai` @ `4df02351` (influence maps, scouting memory, retreats) is **later** (E16 deepening); E4 ports the existing TS planner's decisions-on-same-knowledge.
**Exit gate:** W2 at T1 (1,000 villagers + 300/side measured mix, deep-sim §4) p95 ≤ 33.3 ms with per-system shares reported; fog cost reported as µs per tile-crossing contributor vs TS's honest 2.1–3.2 µs; AI plays a full skirmish through public commands only (fog-honest audit); goldens + replays identical at 1/2/4/8.
**Blocks:** E7, E8. **Slice:** blocker.

### E5 — Unity presentation: terrain, water, cameras, art pipeline

**Goal:** the premium look in the locked engine: URP terrain/water/lighting, all three camera modes, instanced Pops/buildings at prototype-proven frame cost, art-bible asset pipeline. Runs **parallel to E3/E4** against E1's snapshot schema; joins the spine when E3 publishes real snapshots.
**Entry gate:** E1 exit (bridge + empty settlement judged); art bible Option A, Cohesive Stylized Realism — modular CC0 3D + PBR + ACES + AI portraits/icons (#148 via #140); asset catalogue + AI-copyright boundaries from #144 (`docs/research/asset-sourcing-aaa.md`).
**Work / donor entry points:**
- Reimplement, don't translate: donor roadmap Phase 3's Voidstrike TSL harvest (`src/rendering/tsl`, `src/rendering/compute`, `src/rendering/water` @ `4df02351`) is **reference for look and effect inventory only** under Unity — the roadmap itself says "reimplement shaders in the selected engine instead of translating TSL line by line" (Phase 3, Godot/Unity branch). pmndrs/postprocessing likewise drops out (Unity URP post replaces it). This is the largest donor-value write-down caused by ADR-0009 (C5).
- Carry forward judged prototype work: hybrid prototype terrain/camera (`prototypes/hybrid/`, improved slice `f51aba9`/`fbb3396`), Blender settlement diorama (`prototype/blender-settlement/`), first-impression order terrain+camera → units/buildings → HUD → audio (#140 standing decisions).
- Snapshot→visual binding with the Generals bridge lifecycle contract (E1); banished-style work presentation (activity anims, tool/cargo props) re-expressed in Unity animation from `SPEC.md` §2.14 — note SPEC's mechanism (baked billboard atlases, "NO SkinnedMesh in v1") is a three.js-era decision and must be re-decided for Unity, not inherited silently (C9).
**Exit gate:** matched captures at all three camera modes pass James's visual review (tactical default, #140); 500 visible Pops profiled vs prototype baseline (p50 8.41 / p95 8.93 ms uncapped, ADR-0009) under a **new Unity-native budget table** recorded in this epic; zero sim-digest change from any presentation work (donor roadmap Phase 3 exit gate).
**Blocks:** E6, E8. **Slice:** blocker.

### E6 — HUD, front end and audio skeleton

**Goal:** Crown & Chronicle shell live on real snapshot data; title/match-setup flow; audio buses ready for content long before content exists.
**Entry gate:** E1 bridge events; E5 shell surface; ADR-0011 (D shell + E capacities — *not* #140's stale Variant-E gist, C8).
**Work:**
- HUD per ADR-0011: 60px top bar with crown-favour chip, four-tab info panel (Commission · Victory · People · Realm), crown pulse (favour/approval/unrest/tax), adaptive bottom deck, settlement footer; responsive rules are part of the decision (≤1440/≤1320/≤1100 breakpoints). Prototype of record: `prototype/aaa-hud.html` @ `49c2924`. **Split the epic internally:** shell + bindings for state that exists at E3/E4 (resources, selection, queues, victory) land here; favour/approval/unrest/tax bindings are placeholder-fed until E10/E12 create that state (ADR-0011 Consequences: prototype values "are placeholders, not data contracts").
- Front end: successor to shipped F1 (title screen + match setup, #137 via #140), including starting-era/era-cap controls stubbed to E13's data model.
- Audio skeleton per #180: Unity AudioMixer port of the proven bus/intent model, semantic event taxonomy before content batching (donor roadmap Phase 11 order: directors/backends first); donor patterns Voidstrike `src/audio`, `src/engine/systems/AudioSystem.ts` and Generals `web/src/browser/audio*` @ respective pins — pattern reuse only, event vocabulary replaced. Audio never in sim state (#180).
**Exit gate:** a full skirmish is *commandable* start-to-finish through the HUD (no debug UI, no "DEV" badge — the #140 audit defects stay fixed); HUD verified at 1600×900 / 1280×800 / 1024×800 per ADR-0011 evidence standard; audio intents fire from sim events with −16 LUFS bus structure in place (#180), content may be placeholder.
**Blocks:** E8. **Slice:** blocker (shell); macro bindings complete only at E12.

### E7 — Persistence productised: AOF2 saves, replays, fixture CI

**Goal:** turn E1's round-trip demo into the #165 contract as shipping infrastructure.
**Entry gate:** E3+E4 state surface stable enough to version; #165 header spec (AOF2 magic, `EngineId`, map hash, state digest, gzip payload) adopted or amended explicitly — it currently lives in a research doc, while ADR-0008 §5 defers format decisions to "a separate migration ADR"; E7 must settle which document is normative (C3).
**Work / donor entry points:**
- v2 container + loud v1 rejection (`"Unsupported v1 save format…"` class errors, magic + engine mismatch, digest verification — #165 §2.2). Dual-engine cross-loading prohibited.
- Replay = seed + command stream + milestone digests (`formatVersion: 2`, `engine: "rust-shipyard"` — #165 §3.2); Generals `web/src/sim/{replayRecording,replayPlayback,replayCommandBridge}.ts`, `web/src/formats/replay/` @ `816b259c` as the working subset reference (retail parity explicitly not claimed, donor inventory Priority 1); OpenRA `OpenRA.Game/Network/{Order,OrderIO,OrderManager,ReplayRecorder,ReplayConnection}.cs` @ `dbe67473` for bounded order serialisation + sync-hash patterns; Widelands `src/logic/replay.cc` + `generic_save_handler.cc` @ `bfc7713d` for embedded-initial-save and transactional backup/restore patterns.
- CI: `cargo test --test golden` × `RAYON_NUM_THREADS=1,2,4,8` on every sim change; snapshot capture→restore→recapture suites (Generals `simSnapshot.ts` pattern); one home for fixtures — #165 says `tests/golden/v2/`, ADR-0008 says the Rust crate's cargo tests; pick one in E7 (C3).
- Reserve the versioned narrative-blob slot in the save format now (ADR-0010 §2), even though Ink lands in E14 — retrofitting it later breaks every fixture.
**Exit gate:** save at any tick in E3/E4 scenarios → load → identical subsequent digests; replay of a recorded skirmish reproduces final digest at all four worker counts; v1 file produces the explicit error, never corruption; mid-activity/mid-construction saves resume (donor inventory §5 constraint).
**Blocks:** E8, E14. **Slice:** blocker.

### E8 — Vertical slice assembly and judgement (anchor: #183)

**Goal:** first judgeable build of the actual game: one settlement, playable start-to-victory, on the production stack.
**Entry gate:** E3–E7 exits **and #183 resolved** (epoch, map, systems, acceptance bar). E8 is the only epic whose content list cannot be written today — §6 details both candidates and what each pulls forward.
**Work:** integration, not new systems: slice content set (units/buildings/techs for the chosen epoch from `docs/research/era-ranks-content-and-donor-matrix.md`), victory path, AI opponent at slice scope, tutorialisation hooks if the anchor doubles as campaign chapter 1, performance pass to the anchor's tier.
**Exit gate:** James judges the build against #183's acceptance bar (Map 8's execution override: "build tickets exist to be judged", #182); slice replays/saves green at 1/2/4/8; tier target met (T0 guaranteed, T1 if #183 chooses the stress slice); a written slice-debt list (every placeholder, stub binding and deferred mechanic named) becomes E9+ input.
**Blocks:** E9 (deep systems build on a judged core, per donor roadmap §6 bundle logic). **Slice:** this is it.

### E9 — Physical logistics and economic automation (+ delegation at scale)

**Goal:** W3: goods move physically; production runs on standing bills; foremen/companies operate the same request system the player sees. Locked pillar: physical walker/bailiff logistics (#146 via #140).
**Entry gate:** E8 judged; **plus one scope decision E9 must take first** — which resources/buildings require roads/carriers vs which keep direct hauling (donor roadmap §7 leaves this open; its Phase 5 says "optional configured logistics layers", #146 says the pillar is locked — the optionality is per-settlement configuration, not per-mechanic existence, C10).
**Work / donor entry points (local clones in `scratch/donor-audit/`):**
- Widelands @ `bfc7713d`: `src/economy/{router,routeastar,routing_node,request,transfer,flag,road,ware_instance,warehousesupply,workers_queue}.*`; carrier state machines `src/logic/map_objects/tribes/carrier.cc`, `worker_tasks/carrier_*`. **Start from its tests:** `src/economy/test/test_routing.cc` (18 source-verified cases — best routing fixtures of any donor, donor inventory Priority 3). Caveat carried: `RouteAStar` does not support concurrent instances — parallel routing needs new isolation tests.
- PickUpAndHaul @ `09f1fac9`: `Source/PickUpAndHaul/{WorkGiver_HaulToInventory,JobDriver_HaulToInventory,JobDriver_UnloadYourHauledInventory,CompHauledToInventory,PawnUnloadChecker}.cs` — batch allocation/unload policies behind storage/inventory/reservation ports; no upstream tests, required test list in donor inventory Priority 8.
- DFHack @ `438faf3b`: `plugins/orders.cpp` + fixtures `test/plugins/orders.lua` (schema validation, import/export, restore); `plugins/workflow.cpp` maintain-range hysteresis (`resume <= goal-gap`, `suspend >= goal`) — extract the pure rules only: the plugin's build declaration and only test are commented out at this pin (donor inventory Priority 6).
- Delegation scale-out: TS companies/management frozen semantics (§5.1) re-based onto the request system; W5 mix (1 company/1,000 Pops, deep-sim §8) becomes measurable for the first time.
**Exit gate:** donor Phase 5 gate — seeded multi-workplace scenarios complete without deadlock or duplicated cargo; save/load resumes every reservation and shipment; throughput/idle-time measured vs E8 baseline; W3 + W5 run at T1→T2 under §8 protocol; commodity trace (produced→requested→reserved→carried→stored→consumed) inspectable in UI.
**Blocks:** E10, E13 (diffusion rides physical trade). **Slice:** later.

### E10 — Housing tiers, Pop wealth, taxation, sentiment

**Goal:** the city pillar: Caesar III residential evolution + job-income taxation with real consequences (locked #146 + #151: multi-tier stratification, physical bailiffs, market luxury consumption).
**Entry gate:** E9 goods/logistics live (housing consumes delivered goods; bailiffs are walkers on E3 movement + E9 roads).
**Work / donor entry points:**
- Augustus @ `dae1899e`: `src/building/properties.c` (20 declarative housing tiers), `src/building/{house_evolution,house_service,house_population}.c`, `src/figure/service.c` (service coverage — donor inventory corrects the roadmap's `figure.c`/`city/figures.c` paths), `src/city/{finance,sentiment,migration}.c`. **No upstream test suite exists** — golden fixtures for every housing threshold, coverage decay edge, tax-ledger integer case and sentiment boundary are authored here *before* porting (donor inventory Priority 5).
- Reconciliation duty: Augustus sentiment/migration map onto personal income, wealth, class and affordability — they must not duplicate the TS morale system they replace/extend (donor roadmap Phase 6); exactly one morale/mood state survives (see E11).
- Household formation (redesigned in E3 window) now carries class, savings and housing security — the demographic inputs ADR-0007 §4 requires (fertility ∝ savings × calorie security / cost-of-living × inflation). Market inflation comes from the ported market system extended with floating prices (ADR-0007 §4; `CONTEXT.md` Market Inflation).
**Exit gate:** donor Phase 6 gate — any Household's tier, affordability, tax burden and sentiment explainable from inspectable events; no negative-resource/wealth duplication (conservation property extended to money); long-run demographic soak bounded; HUD People/Realm tax bindings (E6 placeholders) go live.
**Blocks:** E11, E12, E13 (institutional-readiness gate reads class structure). **Slice:** later.

### E11 — Emotional Pops: thought ledgers, wounds, rooms, chronicles

**Goal:** DF/RimWorld-class interior lives (locked #146 pillar 1; priorities ranked in #142: thought/mood ledgers first, then storyteller/rooms/temperature; z-levels reserved for an ADR — still unopened, not in this sequence).
**Entry gate:** E10 household/economic causes exist (thoughts need causes to ledger); rare-tick discipline from #141 ("new sim depth must execute strictly on staggered rare-ticks", #140) — RimWorld tickerType Normal/Rare 250/Long 2000 pattern (deep-sim §6).
**Work:** thought/memory ledgers + mental breaks; wounds → bleeding/incapacitation/rescue/triage (extends frozen `injuries`); room detection + beauty/impressiveness; chronicles/tales generated from the real event log, named masterworks, post-match histories. Implemented from documented mechanics (`docs/research/df-rimworld-donor-inventory.md`, `pop-sim-sources.md`) — no vanilla DF/RimWorld code exists to copy (donor roadmap §3.3). RimThreaded @ donor roadmap §3.2 is reference for parallelisation hazards only.
**Exit gate:** donor Phase 7 gate — identical seeds reproduce thoughts, breaks, wounds, tales; rare-tick budgets hold at T2 (W4's society floor: TS measured ~12% of tick for mass/social/morale/culture/households at 2k Pops, deep-sim §6 — E11 must report its share against that floor); every major mood change has a readable cause chain surfaced in HUD (Pop character sheet, ADR-0011 deck).
**Blocks:** E12 (radicalisation reads mood), E14 (chronicles feed campaign). **Slice:** later.

### E12 — Politics and storyteller: council, Emperor, unrest, dynamic incidents

**Goal:** W4 complete: delegate council voting (#154), Imperial quests/Favor (#155), interest-group radicalisation → riots/revolt/civil war with negotiation and peace treaties (#151, ADR-0007 §5), RimWorld-style dynamic storyteller (#146 pillar 4).
**Entry gate:** E10 (wealth/class/tax state), E11 (mood state) — politics without both duplicates state, which donor Phase 8 explicitly forbids ("without duplicating Thought/Morale state").
**Work / donor entry points:**
- Augustus imperial machinery @ `dae1899e`: `src/scenario/request.c` is the real request lifecycle (normal/dispatched/late/received/overdue/ignored + favour + save/load; `src/city/request.c` is only an adapter — donor inventory Priority 5 corrects the roadmap), `src/city/emperor.c` per roadmap §3.3, `src/building/monument.c` phase/resource matrices (also E13's wonder donor).
- RimWar @ `aab38d57`: portable policies in `Source/RimWar/{WorldComponent_PowerTracker,RimWarData,RimWarSettlementComp,WorldUtility}.cs` + `Source/RimWar/Planet/IncidentUtility.cs`; `WorldComponent_IncidentTracker.cs` is a **stub** (roadmap §3.3 names it as the entry point — corrected by donor inventory Priority 7). New adapter tests required, incl. characterising the suspicious comparison at `IncidentUtility.cs:116` before preserving or fixing it.
- Council/Influential Figures/ideologies are local design on locked research (`town-council-mechanics.md`, `emperor-favor-system.md`), all effects via sim commands; dilemmas surface through E14's Ink runtime, but the *state machines* (votes, decrees, escalation) are sim-owned here.
**Exit gate:** donor Phase 8 gate — council/imperial/rebel actions cannot bypass command ordering; saves resume mid-vote, mid-request, mid-dilemma; repeated seeds identical; W4 at T2 under §8 protocol (20 factions, 12 votes/day mix); crown-pulse HUD bindings (favour/approval/unrest) fully live, closing E6's placeholder debt.
**Blocks:** E13 (ideological transformation), E14 (dilemma content). **Slice:** later.

### E13 — Epochs pipeline: 24 ranks, triple gate, wonders, diffusion, content batches

**Goal:** ADR-0007 end-to-end: `eraGate: 1..24` content model, triple era gate, staged/capturable Great Wonders, technological diffusion, starting-era/era-cap match setup.
**Entry gate:** stable economy/combat/content schemas from E9–E12 (donor Phase 9 dependency). The 6-vs-8-epoch reconciliation is already done (`era-ranks-content-and-donor-matrix.md` §1 follows ADR-0007's 8×3); E13 builds against the matrix, not against `historical-eras-architecture.md`'s 6-epoch sketch.
**Work:**
- Generalise definitions: replacement/legacy rules per rank (matrix §2 obsolescence pipeline); content validation + fixture generation per rank; wonders from Augustus `monument.c` patterns in local ECS state; diffusion via E9's physical trade caravans, border/road proximity, diplomatic pacts (ADR-0007 §3).
- **Batch by playable slices, never author all 24 ranks before the first transition passes** (donor Phase 9). Internal order: (a) pipeline + Epoch 1→2 transition, (b) Medieval→Colonial as the second reference transition (gunpowder/sail transform combat + naval, the widest mechanism jump in the matrix), (c) remaining epochs in campaign order (E14 pulls them).
**Exit gate:** donor Phase 9 gate — Ancient→Classical and Medieval→Colonial transitions work end-to-end; full 24-rank marathon validation automated (headless era-cap combinations, wonder capture/legacy cases); era advance impossible with any one triple-gate leg missing (negative fixtures per leg).
**Blocks:** E14 chapter content beyond the slice epoch. **Slice:** later, unless #183 pulls the first transition into E8 (§6).

### E14 — Campaign, tutorial and Ink narrative production

**Goal:** the Chronicle saga: 8 epoch chapters as data-only S5 missions with Ink dialogue/dilemmas (ADR-0010, #150).
**Entry gate:** two-stage. **Runtime** entry: E7's blob slot + #188 spike results (Ink Unity integration pinned, inklecate-pinned compile, one allowlisted external function issuing a mock command, blob round-trip) — the spike runs parallel from E1 and must not wait for E12. **Content** entry: E12 dilemma state machines + E13 epoch pipeline (chapters are epoch-flagship missions with Wonder finales).
**Work:**
- S5 port (frozen verbatim, §5.1) owns mission sequencing; Ink opens only at S5-action dialogue moments and returns outcomes as allowlisted commands (ADR-0010 §§3–4). Widelands `data/campaigns/*/scripting/mission_thread.lua` @ `bfc7713d` is a *structure* reference for tutorial progression only — its coroutine runtime is rejected (ADR-0010 §4, no second scripting system).
- Chapter 1 doubles as tutorial: camera/commands → economy/logistics → housing/tax → combat → politics/era (donor Phase 10 chain), one headline deep-sim system taught per chapter (#150).
- Headless replay duty: choices are commands, so replay must re-derive or checkpoint story state — E14 must decide whether the Ink runtime runs inside the replay harness or blobs are checkpointed in the replay file (currently undecided, C11). No keyword interpretation anywhere in stories/triggers (ADR-0010 §6).
**Exit gate:** donor Phase 10 gate (narrative half) — tutorial + chapter saves/replays resume exactly, incl. mid-dialogue; malformed compiled-Ink mod JSON rejected cleanly without corrupting a match (ADR-0010 §5); each shipped chapter completable start-to-finale on a fresh profile.
**Blocks:** E15 (editor authors S5+Ink content), E16 (campaign is a ship gate). **Slice:** later — unless #183 anchors E8 as chapter 1, in which case tutorialisation of the slice is E8 scope and full E14 still follows.

### E15 — Map/scenario editor and mods

**Goal:** authoring for maps, S5 triggers, starting conditions; data mods first, no arbitrary native code (donor Phase 10).
**Entry gate:** E8 (stable map/content formats), E14 runtime (validated Ink JSON load path).
**Work / donor entry points:** Unity-native editor tooling (URP terrain tools) with Voidstrike `src/editor/`, `src/app/game/setup/editor` @ `4df02351` as workflow reference only (React/Three tooling does not port — C5); navigation validation reuses E3's passability/A\* as the oracle; mod surface = JSON definitions (E1 pipeline, whole-set validation, fail loudly per `SPEC.md` §3 load discipline) + compiled Ink JSON (ADR-0010 §5). Map 8 leaves "mod authoring tooling beyond the decided load-time validation" unspecified (#182) — E15's first ticket is that decision, not code.
**Exit gate:** a map + scenario authored in the editor loads, saves, replays identically; malformed mods fail validation listing every error, match uncorrupted (donor Phase 10 gate).
**Slice:** later.

### E16 — Scale, hardening and ship

**Goal:** the full-game claim: W6 at T2, content-complete audio, desktop builds, capped browser demo, provenance.
**Entry gate:** nominally last, but its measurement duties run continuously from E3 (donor Phase 11: "Dependencies: ongoing; final gate after all preceding phases"). No epic above may defer its perf evidence to E16.
**Work:**
- W6 (W2∪W3∪W4∪W5, one day-boundary + battle wave + vote in the same 600-tick window, deep-sim §8) at T2: p95 **and** p99 ≤ 33.3 ms, worst tick ≤ 100 ms, latency wall p95 ≤ 66 ms; T3 reported not gated; dispersed-spawn variant added before any T2 claim (deep-sim §10.10); AI deepening (Voidstrike influence/scouting behind `KnowledgeView`, donor Phase 10) and balance — explicitly "Not yet specified" on #182 until deep sim runs at tier scale, so E16 opens with that specification ticket.
- Map-size debt: T2/T3 assume 256²/384² maps but only 120² is implemented/measured (deep-sim §7/§10.5) and ADR-0003 defers portal-sector tiling until maps exceed ~256² — the tiling decision (build it, or cap map size) must be taken before T2 is claimable (C6).
- Audio content batch by semantic event (#180: adaptive epoch-layered score, CC0-first provenance manifest, generated-voice dialogue + non-verbal barks, camera-mode/speed-reactive mix); desktop standalone builds macOS+Windows (#181; #185 pipeline); browser demo as a *separate* capped artifact (~1k Pops, three.js + WASM single-threaded sim build per ADR-0008 §1/#181) — its production timing vs desktop milestones is unspecified on #182 and is decided here, not assumed parallel.
- Long soaks (300+ Pops 10k+ ticks, `SPEC.md` §7 nightly pattern, scaled per tier), donor attribution/provenance + retained upstream test reports (donor Phase 11).
**Exit gate:** donor Phase 11 gate at full scope — determinism (1/2/4/8), performance (T0–T2), campaign/tutorial, visual, audio and content gates all green on the M1/16 GB reference floor (#181); James judges the game done (#182 destination).
**Slice:** later.

## 6. Vertical slice: first vs later

#183 (HITL) owns the anchor decision; this section only prices the two candidates already on record so the choice is informed. Everything in E0–E7 is needed under **both**.

| | Candidate A: Epoch-1 settlement = chapter 1/tutorial | Candidate B: mid-game stress slice |
|---|---|---|
| Content pulled into E8 | Epoch 1 ranks 1–3 units/buildings (era matrix §3), primitive economy, no era transition needed | A mature-epoch set (e.g. Medieval ranks 7–9), full military roster at T1+ |
| Extra epics pulled forward | E14 tutorialisation hooks only; E13 stays later | E9 logistics partially (supply at scale), E13 content pipeline for one mid epoch — but *not* its transition logic |
| Tier proved | T0, aspirationally T1 | T1 by design; T2 kernel evidence from E2 extrapolated, not yet a W6 claim |
| What it de-risks | Campaign/tutorial shape (#150), new-player path, art/HUD judgement at settlement camera | Perf/determinism at scale before content investment; movement storms (deep-sim §2) |
| What it leaves unproven longest | Scale (T2 unproven until E9–E12 land on top) | Onboarding and Epoch-1 content (campaign start rebuilt later) |

**Needed first (either candidate):** E0 freeze, E1 skeleton/bridge, E2 determinism proof, E3 core loop, E4 combat/fog/AI-at-parity, E5 presentation at judged quality, E6 HUD shell + front end, E7 saves/replays. **Deliberately later:** physical logistics depth (E9), wealth/tax (E10), mood ledgers (E11), council/Emperor/storyteller (E12), era transitions + 24-rank content (E13), campaign chapters 2–8 (E14), editor/mods (E15), T2 claim + browser demo (E16). The slice therefore plays like the shipped TS game's *scope* on the new stack at higher fidelity — that is the point: deep-sim pillars land one judged epic at a time on a proven core, mirroring how M1–M5 were built (`SPEC.md` §8).

Dependency graph (spine left→right; parallel tracks below):

```text
E0 ── E1 ── E2 ── E3 ── E4 ── E7 ── E8 ── E9 ── E10 ── E11 ── E12 ── E13 ── E14 ── E16
            │              ▲                 │             ▲       ▲        ▲
            └── E5 ── E6 ──┘                 └─ (E9 trade)─┘       │        │
            └── #188 Ink spike ── (runtime joins at E14 entry) ────┘        │
                                          E15 after E8 + E14 runtime ───────┘
```

## 7. Conflicts and ambiguities in the locked decisions (not papered over)

Each item: what conflicts, the sources, what this sequence assumes, and what would settle it. **None of these are resolved by this document** — they are flagged for the map, in the ticket's own terms (#184: "marking what the vertical slice needs first versus what can land later"; parent instruction: flag, don't paper over).

- **C1 — Migration order: ADR-0008 Phases 1–2 vs #165 vs one-store rule.** ADR-0008 §6 builds deep systems (mood, tax, housing, eras) greenfield in Rust *first* while TS keeps movement/combat, with both sims running in one harness and the renderer reading Pop state from Rust and movement from TS. #165 prohibits dual-engine cross-loading and any hybrid save; donor roadmap §4 rule 1 requires one authoritative entity store. Two live sims splitting one entity set cannot satisfy all three. *This sequence assumes:* core-loop-first (E3 before E10–E13), TS as offline oracle only. *Settles it:* an ADR-0008 amendment restating the migration order.
- **C2 — Parity meaning: #187 "final-state hash equality" vs #165 hard break.** #165 §1.3 rejects matching "v1 JavaScript float-rounding quirks, byte-exact array packing, or legacy data layouts"; ADR-0008 §5 archives v1 fixtures out of the CI gate. A Rust digest therefore *cannot* equal a TS v1 digest without violating the boundary. *Assumed:* parity = semantic trace equality vs frozen fixtures (§5.1) + Rust-internal hash equality across workers. *Settles it:* #187's resolution wording when it closes.
- **C3 — Freeze trigger, fixture home, format authority.** Freeze: #165 §5 says TS freezes "upon commencement of the v2 sim pipeline"; ADR-0008 §6 freezes TS "at the start of Phase 3" (full migration). Fixture home: #165 §1.2 says `tests/golden/v2/`; ADR-0008 §5 says `cargo test --test golden` in the Rust crate. Format: #165 §2 specifies the AOF2 header in detail; ADR-0008 §5 defers to "a separate migration ADR if/when" — and the `fixtures/v1-final` tag neither document's plan requires *exists yet*. *Assumed:* freeze at E0 (earliest, safest reading); fixture home + format authority decided in E7. *Settles it:* one short ADR or a #165 addendum.
- **C4 — Perf targets disagree across documents.** ADR-0008 §6: spike "<8 ms for the full hot loop at 5k and 20k entities on M2". Deep-sim §8: T2 (5k Pops ≈15k entities) p95/p99 ≤33.3 ms, T3 *not gated*; reference machine is M1 (#181 floor; deep-sim measurements on M1). SPEC §7's 8 ms is a T0 (300–500 Pop) contract. The ADR target is simultaneously stricter (8 ms at 20k) and off-machine (M2). *Assumed:* deep-sim §8 table is canonical (§3.2). *Settles it:* ADR-0008 amendment or E2's recorded restatement.
- **C5 — Bridge/client stack half-superseded.** ADR-0008 builds for a Tauri sidecar + Unix socket + TypeScript FlatBuffers accessors + a `Map<u32, Object3D>` (Three.js) renderer. ADR-0009 moves presentation to Unity and says it supersedes ADR-0008's renderer assumptions "insofar as it left the presentation engine open", but transport (socket sidecar vs in-process), C# codegen, and lifecycle (who spawns/restarts the Rust process) were never re-decided; #181's standalone Unity builds retire Tauri entirely. Donor consequences: Voidstrike TSL/editor (React/Three), Generals TS bridge code and pmndrs/postprocessing all degrade from "port" to "reference". *Assumed:* E1 decides transport explicitly. *Settles it:* E1/#186 resolution record.
- **C6 — Movement semantics vs scale assumptions.** Three loose ends: (a) ADR-0003's model applies paths via a 2-tick `dueTick` worker contract; ADR-0008's in-tick parallel phases imply different application timing — replay parity with TS movement is therefore semantic, not tick-exact (priced in §5.1). (b) ADR-0008 Phase 2 promises "A\* reservations"; no reservation system exists in TS or was benchmarked in #162–#173 — the term is unspecified. (c) T2/T3 need 256²/384² maps (deep-sim §7) but ADR-0003 defers portal-sector tiling until >~256² and only 120² is implemented/measured (deep-sim §10.5). *Assumed:* A\* as gated by #173; tiling decision forced in E16 before any T2 claim. *Settles it:* a movement addendum ADR when E3/E16 reach it.
- **C7 — ADR-0008's phase list has no home for two measured serial systems.** The AI planner (2nd-largest system under combat, per-player sequential, deep-sim §4) and day-boundary/global passes (households: worst single tick measured, §2) fit none of Phases 1–7. Deep-sim §11 already recommends adding both. *Assumed:* E1's phase skeleton adds them. *Settles it:* same ADR-0008 amendment as C1/C4.
- **C8 — Stale gists on the closed map.** #140 Decisions-so-far still says HUD "Locked Variant E" (ADR-0011, 2026-11-06, locks D shell + E capacities instead), says "six epochs" in the #153 gist history (ADR-0007: 8×3, reconciled in the era matrix), and its #145 entry (Tauri/WebGPU platform) is self-flagged as under review and now superseded by ADR-0009/#181. #140 is closed, so these won't be edited there. *Assumed:* ADRs win over gists everywhere in this sequence. *Settles it:* nothing needed if every Map 8 ticket cites ADRs, not gists — worth one line on #182.
- **C9 — Presentation contracts are three.js-era.** SPEC §7 budgets (draw calls, billboard atlases, "NO SkinnedMesh anywhere in v1", mirror ≤2 ms @500) and §2.14's bake pipeline describe the old renderer. ADR-0009's Unity evidence (frame p50/p95 @500 Pops) is a prototype measurement, not a budget. *Assumed:* E5 writes the Unity-native budget; SPEC §7 numbers gate only the TS/browser-demo line. *Settles it:* E5's recorded budget table.
- **C10 — Physical-logistics scope: locked pillar, unscoped surface.** #146 locks physical walker logistics as a pillar; donor roadmap Phase 5 introduces roads/flags/carriers as "optional configured logistics layers rather than silently invalidating all current drop-offs" and §7 still lists "which resources/buildings require roads" as open research. These compose only if optionality means per-settlement/per-resource configuration of a mandatory system. *Assumed:* that reading; E9's first decision enumerates the surface. *Settles it:* E9 entry ticket.
- **C11 — Ink replay mechanics unspecified.** ADR-0010 stores story state as an opaque blob in Rust saves and advances it only via commands, with the runtime living in Unity (C#). Replays are command streams: either the replay harness must run Ink headlessly to re-derive blobs, or replays must checkpoint blobs — neither is decided, and Rust cannot validate a blob it cannot interpret (version skew between pinned inklecate/runtime and save schema version). *Assumed:* #188 spike surfaces the friction; E14 takes the decision before content depends on it. *Settles it:* #188 findings + E14 entry record.
- **C12 — Cross-platform replay equality is unclaimed by any ADR.** ADR-0008 guarantees same-seed equality "across any worker count" via sorted reduction, and mandates AVX2/NEON SIMD kernels; sorted order does not make float math identical across ARM (macOS) and x86 (Windows) — both are ship targets (#181). SPEC §7's TS-era answer (hash exact f64 bit patterns; mac+linux drift check nightly) has no Rust successor. Also unspecified: ADR-0008's per-entity RNG (`global_seed XOR entity_id XOR tick`) vs the named-stream discipline TS and donor roadmap §4 rule 6 use. *Assumed:* replay equality is same-platform until E2/E7 prove or bound cross-arch equality (integer/fixed-point authoritative math would settle it by construction). *Settles it:* E2 spike must state the float policy explicitly.
- **C13 — Content single-source-of-truth pipeline unspecified.** Definitions live as Zod-validated JSON (`src/data/schema.ts`, SPEC §3); Rust (Serde) and Unity (C#) both need them, plus `eraGate` generalisation (ADR-0007's consequence note still says "preserving bitECS fast array operations" — obsolete under shipyard). No document names the schema owner or codegen direction. *Assumed:* E1 builds JSON→Rust+Unity codegen with JSON staying canonical. *Settles it:* E1 record.
- **C14 — Browser-demo line keeps a second renderer alive indefinitely.** #181 keeps a capped demo (three.js + WASM, ~1k Pops) while ADR-0009 moves primary presentation to Unity and ADR-0008 §1 maintains a `wasm32` single-threaded sim target. Nothing sequences the demo against desktop milestones (#182 lists its timing as unspecified), and its three.js front end diverges from E5/E6 from the moment they land. *Assumed:* demo is an E16 artifact reusing the frozen TS presentation, not a parallel product. *Settles it:* one Map 8 decision before E16.
- **C15 — Balance & AI strategy are open on both maps.** #140 and #182 both carry "Balance & AI strategy" as not-yet-specified; #182 correctly notes it needs the deep sim running at tier scale. Consequence priced here: E4 ports AI at parity only; any ticket promising "good AI" before E12/E16 is ungrounded. Not a conflict — an ordering constraint this sequence obeys by placing AI deepening in E16.

## 8. Sources

Primary (read in full for this ticket):

- Issues: [#184](https://github.com/jamesm944/game/issues/184) (question), [#182](https://github.com/jamesm944/game/issues/182) (Map 8), [#140](https://github.com/jamesm944/game/issues/140) (Map 6 Decisions-so-far), [#183](https://github.com/jamesm944/game/issues/183), [#185](https://github.com/jamesm944/game/issues/185), [#186](https://github.com/jamesm944/game/issues/186), [#187](https://github.com/jamesm944/game/issues/187), [#188](https://github.com/jamesm944/game/issues/188).
- ADRs: `docs/adr/0007-historical-epochs-and-eras-progression.md`, `0008-rust-native-sim-core-and-renderer-bridge.md`, `0009-unity-urp-presentation-engine.md`, `0010-ink-narrative-runtime-and-s5-mission-model.md`, `0011-crown-and-chronicle-hud.md`; `0003-unit-movement-and-pathfinding.md` for the movement contract.
- Research: `docs/research/open-source-donor-integration-roadmap.md` (#160, 12 phases), `deep-sim-workloads-and-scaling.md` (#164, tiers/W1–W6/spike protocol), `donor-build-and-test-inventory.md` (#161, pins + verified test inventory), `save-and-replay-compatibility-boundary.md` (#165), `era-ranks-content-and-donor-matrix.md` (#163), `recast-vs-astar-full-scale.md` (#173).
- Repo state: `SPEC.md` (§§2/3/7/8), `CONTEXT.md`, `package.json` (v1.1.0), `src/game/session.ts` (`wireSkirmishSystems`), `src/sim/systems/` (31 files), `src/sim/scenario/` (S5), `src/data/schema.ts` (4-age `ageGate`), `tests/golden/` (37 dirs), `tests/perf/`, `scratch/donor-audit/` (8 pinned clones: `browser/{voidstrike,generals-rts-threejs-port}`, `rts/{openra,widelands}`, `city/{augustus,dfhack}`, `mods/{RimWar,PickUpAndHaul}`), `git tag` (no `fixtures/v1-final` yet), branch `research/df-rw-deep-sim` @ `c11baae`.

Every donor path cited above is quoted from the audited inventory/roadmap at its pinned commit; where the inventory corrects the roadmap (Augustus request/service paths, RimWar stub, DFHack Workflow disabled), the inventory wins and the correction is noted at the citation. Paths are upstream-relative; spot-checked against the local clones on 2026-11-07 (Widelands/OpenRA clones nest under `scratch/donor-audit/rts/*/source/`).



