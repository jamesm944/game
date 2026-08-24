/**
 * Skills: knowledge vs practice tests — SPEC §2.3 / M3-T2 (issue #47).
 *
 * Acceptance criteria under test:
 * - RUST CURVE MATCHES DOCUMENTED CONSTANTS over simulated days: the
 *   rare-tick accumulator machine (one-day grace, 100 practice XP
 *   drained every 8 idle rare-ticks) is verified against an analytically
 *   re-derived expectation, knowledge untouched throughout.
 * - SKILLED VILLAGER MEASURABLY OUTGATHERS A NOVICE on an identical
 *   integrated gather scenario (fixture-grade comparison).
 * - COMBAT XP FLOWS: strikes and kills pay the documented melee/ranged
 *   awards through the same award path, and skill levels scale derived
 *   attack in the stats read path.
 *
 * Plus the surrounding contract: DF curve constants (400+100·L into
 * level L; Legendary 18,000 at level 15), trait xpGainMult/workSpeedMult
 * modifiers, legendary clamping, rowless-entity no-ops, rare-tick
 * stagger purity and digest participation.
 */
import { describe, expect, it } from "vitest";
import {
  attachPopSkills,
  defineSimComponents,
  hasSkillsRow,
  insertSkillEntryInRow,
  readSkillEntries,
  skillsRowOf,
  spawnCombatUnit,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { attachPopIdentity } from "../src/sim/components/pop";
import {
  LEGENDARY_TOTAL_XP,
  levelOfTotalXp,
  MAX_SKILL_LEVEL,
  skillCodeOf,
  skillIdOfCode,
  SKILL_SLUGS,
  xpForNextLevel,
  xpToReachLevel,
} from "../src/sim/data/skills";
import {
  traitCodeOf,
  traitWorkSpeedMult,
  traitXpGainMult,
} from "../src/sim/data/traits";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  spawnEntity,
  step,
  type World,
} from "../src/sim/core/world";
import {
  createDropOffPoint,
  PLAYER_ONE,
  createPlayerStockpile,
} from "../src/sim/core/stockpile";
import { RESOURCE_WOOD } from "../src/sim/components/economy";
import { unitDefOf } from "../src/data/definitions";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../src/sim/systems/gather";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../src/sim/systems/combat";
import {
  COMBAT_EVENT_DAMAGE,
  readCombatEvents,
} from "../src/sim/components/combat";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  awardPractice,
  attackMultiplierFor,
  builderMilliPerTickFor,
  createSkillsSystem,
  effectiveGatherTicksPerUnit,
  gatherTicksPerUnitFor,
  grantKnowledge,
  rareTickDue,
  RARE_TICK_INTERVAL,
  RUST_ACCUMULATOR_CAP,
  RUST_DRAIN_PRACTICE_XP,
  RUST_GRACE_TICKS,
  skillLevelOf,
  totalXpOf,
  workMultiplierFor,
} from "../src/sim/systems/skills";
import { deriveUnitStats, strikeDamage } from "../src/sim/combat/stats";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function grassWorld(seed: number): { world: World; comps: SimComponents } {
  const size = 16;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
  });
  return { world, comps: defineSimComponents(world) };
}

/** Fresh named Pop carrying an empty (novice) Skills row. */
function novice(world: World, comps: SimComponents): number {
  const eid = spawnEntity(world);
  attachPopIdentity(world, comps, eid);
  attachPopSkills(world, comps, eid);
  return eid;
}

// ---- Curve constants ------------------------------------------------------------

describe("progression curve (DF constants)", () => {
  it("costs 400+100·L to advance into level L", () => {
    // Doc examples: Novice at 500 cumulative; Adequate→Competent = 700.
    expect(xpToReachLevel(1)).toBe(500);
    expect(xpToReachLevel(2)).toBe(1100);
    expect(xpToReachLevel(3)).toBe(1800);
    expect(xpToReachLevel(3) - xpToReachLevel(2)).toBe(700);
    for (let level = 1; level <= MAX_SKILL_LEVEL; level++) {
      expect(xpToReachLevel(level) - xpToReachLevel(level - 1)).toBe(
        400 + 100 * level,
      );
    }
    // "Legendary totals 18,000" at level 15.
    expect(xpToReachLevel(MAX_SKILL_LEVEL)).toBe(LEGENDARY_TOTAL_XP);
    expect(LEGENDARY_TOTAL_XP).toBe(18_000);
  });

  it("converts total XP to levels at exact thresholds", () => {
    expect(levelOfTotalXp(0)).toBe(0);
    expect(levelOfTotalXp(499)).toBe(0);
    expect(levelOfTotalXp(500)).toBe(1);
    expect(levelOfTotalXp(1099)).toBe(1);
    expect(levelOfTotalXp(1100)).toBe(2);
    expect(levelOfTotalXp(3499)).toBe(4);
    expect(levelOfTotalXp(3500)).toBe(5);
    expect(levelOfTotalXp(17_999)).toBe(14);
    expect(levelOfTotalXp(18_000)).toBe(MAX_SKILL_LEVEL);
    expect(levelOfTotalXp(999_999)).toBe(MAX_SKILL_LEVEL); // clamped domain
    expect(xpForNextLevel(0)).toBe(500);
    expect(xpForNextLevel(500)).toBe(600);
    expect(xpForNextLevel(17_999)).toBe(1);
    expect(xpForNextLevel(18_000)).toBe(0);
  });

  it("assigns stable ascending u8 codes", () => {
    expect([...SKILL_SLUGS]).toEqual([...SKILL_SLUGS].sort());
    SKILL_SLUGS.forEach((slug, index) => {
      expect(skillCodeOf(slug)).toBe(index + 1);
      expect(skillIdOfCode(index + 1)).toBe(slug);
    });
  });
});

// ---- Awards & pools ---------------------------------------------------------------

describe("practice awards & knowledge grants", () => {
  it("levels practice up exactly at thresholds", () => {
    const { world, comps } = grassWorld(11);
    const eid = novice(world, comps);

    expect(skillLevelOf(world, comps, eid, "gathering")).toBe(0);
    for (let i = 0; i < 50; i++) {
      awardPractice(world, comps, eid, "gathering", 10); // → 500 total
    }
    expect(totalXpOf(world, comps, eid, "gathering")).toBe(500);
    expect(skillLevelOf(world, comps, eid, "gathering")).toBe(1);

    awardPractice(world, comps, eid, "gathering", 599);
    expect(skillLevelOf(world, comps, eid, "gathering")).toBe(1);
    awardPractice(world, comps, eid, "gathering", 1); // → 1100
    expect(skillLevelOf(world, comps, eid, "gathering")).toBe(2);

    const entries = readSkillEntries(world, comps, eid)!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe("gathering");
    expect(entries[0]!.knowledgeXp).toBe(0);
    expect(entries[0]!.lastPracticeTick).toBe(world.tick);
  });

  it("keeps awards no-ops for rowless legacy entities", () => {
    const { world, comps } = grassWorld(12);
    const eid = spawnEntity(world); // no Skills row
    expect(() => awardPractice(world, comps, eid, "melee", 10)).not.toThrow();
    expect(hasSkillsRow(world, comps, eid)).toBe(false);
    expect(skillLevelOf(world, comps, eid, "melee")).toBeUndefined();
    expect(totalXpOf(world, comps, eid, "melee")).toBeUndefined();
    // Derived read paths fall back to base values untouched.
    expect(effectiveGatherTicksPerUnit(world, comps, eid, 30)).toBe(30);
  });

  it("clamps total XP at the Legendary cap and rejects bad amounts", () => {
    const { world, comps } = grassWorld(13);
    const eid = novice(world, comps);
    grantKnowledge(world, comps, eid, "melee", LEGENDARY_TOTAL_XP);
    expect(skillLevelOf(world, comps, eid, "melee")).toBe(MAX_SKILL_LEVEL);
    awardPractice(world, comps, eid, "melee", 100);
    expect(totalXpOf(world, comps, eid, "melee")).toBe(LEGENDARY_TOTAL_XP);
    expect(() => awardPractice(world, comps, eid, "melee", 0)).toThrow();
    expect(() => grantKnowledge(world, comps, eid, "melee", -4)).toThrow();
    expect(() => awardPractice(world, comps, eid, "nope", 10)).toThrow();
  });

  it("applies trait xpGainMult to awards (rounded, ≥1)", () => {
    const { world, comps } = grassWorld(14);
    const fast = novice(world, comps);
    const slow = novice(world, comps);
    const rows = (eid: number, code: number): void => {
      world.rowsByComponentId.get(comps.traitsId)!.set(eid, [code]);
    };
    rows(fast, traitCodeOf("fast-learner"));
    rows(slow, traitCodeOf("slow-learner"));
    expect(traitXpGainMult(["fast-learner"])).toBeCloseTo(1.25);
    expect(traitXpGainMult(["slow-learner"])).toBeCloseTo(0.75);

    awardPractice(world, comps, fast, "construction", 10);
    awardPractice(world, comps, slow, "construction", 10);
    expect(readSkillEntries(world, comps, fast)![0]!.practiceXp).toBe(13); // round(12.5)
    expect(readSkillEntries(world, comps, slow)![0]!.practiceXp).toBe(8); // round(7.5)
  });

  it("maintains entries ascending by code inside the live row", () => {
    const { world, comps } = grassWorld(15);
    const eid = novice(world, comps);
    awardPractice(world, comps, eid, "ranged", 10);
    awardPractice(world, comps, eid, "melee", 10);
    awardPractice(world, comps, eid, "gathering", 10);
    const row = skillsRowOf(world, comps, eid)!;
    expect(row[0]).toBe(3);
    const codes: number[] = [];
    for (let i = 0; i < row[0]!; i++) {
      codes.push(row[1 + i * 5]!);
    }
    expect(codes).toEqual([
      skillCodeOf("gathering"),
      skillCodeOf("melee"),
      skillCodeOf("ranged"),
    ]);
    // Inserting a missing slug keeps order and bumps the count.
    const grown = insertSkillEntryInRow(row, "construction");
    expect(grown).toBe(1);
    expect(readSkillEntries(world, comps, eid)![0]!.slug).toBe("construction");
  });
});

// ---- Rust pass -----------------------------------------------------------------

describe("rust accumulator over simulated days", () => {
  /** Rare-tick hits in [fromTick, toTick] for (t + eid) % interval === 0. */
  function rareHits(fromTick: number, toTick: number, eid: number): number {
    let hits = 0;
    for (let t = Math.max(fromTick, 1); t <= toTick; t++) {
      if ((t + eid) % RARE_TICK_INTERVAL === 0) hits += 1;
    }
    return hits;
  }

  function rustWorld(seed: number): { world: World; comps: SimComponents } {
    const { world, comps } = grassWorld(seed);
    registerSystem(world, createSkillsSystem(comps));
    return { world, comps };
  }

  it("drains practice toward the knowledge floor per documented constants", () => {
    const { world, comps } = rustWorld(21);
    const eid = novice(world, comps);

    // Knowledge floor: level 2 (1100 XP theory, granted through the
    // study-only path). Practice stacks to a 3000 total ⇒ level 4.
    grantKnowledge(world, comps, eid, "gathering", 1100);
    awardPractice(world, comps, eid, "gathering", 3000 - 1100);
    expect(skillLevelOf(world, comps, eid, "gathering")).toBe(4);
    const entryAtStart = readSkillEntries(world, comps, eid)![0]!;
    const startPractice = entryAtStart.practiceXp;
    const lastPracticeTick = entryAtStart.lastPracticeTick;

    // Idle across four simulated days beyond the one-day grace window.
    const targetTick = lastPracticeTick + RUST_GRACE_TICKS + 4 * 14_400;
    while (world.tick < targetTick) step(world);

    // Analytic re-derivation from the documented counter machine.
    const hits = rareHits(lastPracticeTick + RUST_GRACE_TICKS, world.tick, eid);
    const counterDrains = Math.floor(hits / RUST_ACCUMULATOR_CAP);
    const drainsUntilEmpty = Math.ceil(startPractice / RUST_DRAIN_PRACTICE_XP);
    const appliedDrains = Math.min(counterDrains, drainsUntilEmpty);
    const expectedPractice = Math.max(
      0,
      startPractice - appliedDrains * RUST_DRAIN_PRACTICE_XP,
    );

    const entry = readSkillEntries(world, comps, eid)![0]!;
    expect(startPractice).toBe(1900);
    expect(drainsUntilEmpty).toBe(19);
    expect(counterDrains).toBeGreaterThanOrEqual(drainsUntilEmpty);
    expect(entry.practiceXp).toBe(expectedPractice);
    expect(entry.practiceXp).toBe(0);
    // The floor holds: knowledge NEVER rusts — the Pop settles at its
    // studied level 2, not zero.
    expect(entry.knowledgeXp).toBe(1100);
    expect(skillLevelOf(world, comps, eid, "gathering")).toBe(2);
  });

  it("resets the accumulator when practice resumes mid-idle", () => {
    const { world, comps } = rustWorld(22);
    const eid = novice(world, comps); // eid 1
    awardPractice(world, comps, eid, "gathering", 400); // stamped at tick 0

    // Idling 20,000 ticks crosses grace at 14,400: rare hits at ticks
    // 14,499…19,999 (23 hits) bank floor(23/8)=2 drains ⇒ 200 shed.
    while (world.tick < 20_000) step(world);
    let entry = readSkillEntries(world, comps, eid)![0]!;
    expect(rareHits(RUST_GRACE_TICKS, 20_000, 1)).toBe(23);
    expect(entry.practiceXp).toBe(400 - 2 * RUST_DRAIN_PRACTICE_XP);
    expect(entry.rustAccumulator).toBe(23 % RUST_ACCUMULATOR_CAP);

    // Practicing again resets BOTH the clock and the counter.
    awardPractice(world, comps, eid, "gathering", 10);
    entry = readSkillEntries(world, comps, eid)![0]!;
    expect(entry.practiceXp).toBe(210);
    expect(entry.rustAccumulator).toBe(0);

    // A further 12,000 idle ticks stays inside the fresh grace window:
    // no new drains despite the long cumulative idleness.
    while (world.tick < 32_000) step(world);
    entry = readSkillEntries(world, comps, eid)![0]!;
    expect(entry.practiceXp).toBe(210);
    expect(entry.rustAccumulator).toBe(0);
  });

  it("leaves fresh practice untouched before the grace window", () => {
    const { world, comps } = rustWorld(23);
    const eid = novice(world, comps);
    awardPractice(world, comps, eid, "gathering", 300);
    while (world.tick < RUST_GRACE_TICKS - 1_000) step(world);
    const entry = readSkillEntries(world, comps, eid)![0]!;
    expect(entry.practiceXp).toBe(300);
    expect(entry.rustAccumulator).toBe(0);
  });
});

// ---- Derived multipliers ---------------------------------------------------------

describe("derived work/attack multipliers", () => {
  it("scales work output by +6% per level, integer-rounded", () => {
    expect(workMultiplierFor(0, 1)).toBe(1);
    expect(gatherTicksPerUnitFor(30, 0, 1)).toBe(30); // novices unchanged
    expect(gatherTicksPerUnitFor(30, 5, 1)).toBe(23); // round(30/1.3)
    expect(gatherTicksPerUnitFor(30, MAX_SKILL_LEVEL, 1)).toBe(16); // /1.9
    expect(builderMilliPerTickFor(1000, 3, 1)).toBe(1180);
    expect(builderMilliPerTickFor(700, 0, 1)).toBe(700);
  });

  it("folds trait workSpeedMult into the same path", () => {
    expect(traitWorkSpeedMult(["industrious"])).toBeCloseTo(1.1);
    expect(traitWorkSpeedMult(["lazy"])).toBeCloseTo(0.9);
    expect(traitWorkSpeedMult(["kind"])).toBe(1);
    expect(gatherTicksPerUnitFor(30, 0, 1.1)).toBe(27); // round(27.27)
    expect(builderMilliPerTickFor(1000, 0, 0.9)).toBe(900);
  });

  it("scales derived attack by +4% per combat-skill level", () => {
    const def = unitDefOf("militia");
    const baseline = deriveUnitStats(def);
    expect(attackMultiplierFor(0)).toBe(1);
    expect(attackMultiplierFor(5)).toBeCloseTo(1.2);
    const skilled = deriveUnitStats(def, {
      skillLevels: new Map([["melee", 5]]),
    });
    expect(skilled.attack).toBeCloseTo(baseline.attack * 1.2);
    // A level-5 melee veteran chips harder through the counter formula.
    const defender = deriveUnitStats(unitDefOf("archer"));
    expect(
      strikeDamage(def, skilled, unitDefOf("archer"), defender),
    ).toBeGreaterThanOrEqual(
      strikeDamage(def, baseline, unitDefOf("archer"), defender),
    );
    // Ranged definitions key off the ranged slug instead.
    const archerSkilled = deriveUnitStats(unitDefOf("archer"), {
      skillLevels: new Map([
        ["melee", 15],
        ["ranged", 3],
      ]),
    });
    expect(archerSkilled.attack).toBeCloseTo(
      deriveUnitStats(unitDefOf("archer")).attack * 1.12,
    );
  });
});

// ---- Rare-tick stagger ------------------------------------------------------------

describe("rare-tick stagger", () => {
  it("hits each entity exactly once per interval window", () => {
    for (const eid of [1, 7, 250, 251, 4096]) {
      let hits = 0;
      for (let tick = 0; tick < RARE_TICK_INTERVAL; tick++) {
        if (rareTickDue(tick, eid)) hits += 1;
      }
      expect(hits).toBe(1);
    }
    // Deterministic pure function of (tick, eid).
    expect(rareTickDue(123, 456)).toBe(rareTickDue(123, 456));
  });
});

// ---- Integrated scenarios ----------------------------------------------------------

function openGatherWorld(seed: number): {
  world: World;
  comps: SimComponents;
  diagnostics: ReturnType<typeof createGatherDiagnostics>;
  villagerEid: number;
  nodeId: number;
} {
  const size = 24;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const diagnostics = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, diagnostics));
  registerSystem(world, createSkillsSystem(comps));
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createDropOffPoint(world, comps, 4.5, 4.5, PLAYER_ONE);
  // Node northeast; the villager spawns on its north work slot so work
  // starts immediately.
  const nodeId = spawnResourceNode(world, comps, 8, 8, RESOURCE_WOOD, 500);
  const villagerEid = spawnUnit(world, comps, 8.5, 7.5, {
    identity: true,
  });
  return { world, comps, diagnostics, villagerEid, nodeId };
}

describe("skilled-vs-novice outgather (integrated)", () => {
  it("the level-5 woodcutter measurably beats the novice", () => {
    const runScenario = (seed: number, skilled: boolean): number => {
      const { world, comps, diagnostics, villagerEid, nodeId } =
        openGatherWorld(seed);
      if (skilled) {
        grantKnowledge(world, comps, villagerEid, "gathering", 3500); // level 5
      }
      world.inbox.submit({
        kind: "gather",
        targetTick: 1,
        data: { entityIds: [villagerEid], nodeId },
      });
      while (world.tick < 900) step(world);
      return diagnostics.extractedByResource[RESOURCE_WOOD]!;
    };

    const noviceExtracted = runScenario(20260824, false);
    const skilledExtracted = runScenario(20260824, true);
    // Same everything except the skill (same seed ⇒ same traits): the
    // level-5 woodcutter works at round(30/1.3) = 23 ticks/unit versus
    // the novice's 30 — a strict, measurable gap.
    expect(skilledExtracted).toBeGreaterThan(noviceExtracted);
    expect(skilledExtracted - noviceExtracted).toBeGreaterThanOrEqual(3);
  });
});

describe("combat XP flows (integrated)", () => {
  it("strikes and kills pay melee XP through the award path", () => {
    const PLAYER_TWO = 1;
    const size = 16;
    const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
    const scheduler = new PathScheduler(createSynchronousPathTransport());
    const world = createWorld(77, {
      layers: buildLayers(terrainType, new Uint8Array(size * size)),
      size,
      pathScheduler: scheduler,
    });
    const comps = defineSimComponents(world);
    registerSystem(world, createMovementSystem(comps, scheduler));
    const combatDiagnostics = createCombatDiagnostics();
    registerSystem(world, createCombatSystem(comps, combatDiagnostics));
    createPlayerStockpile(world, comps, PLAYER_ONE);
    createPlayerStockpile(world, comps, PLAYER_TWO);
    const attacker = spawnCombatUnit(
      world,
      comps,
      "militia",
      4.5,
      4.5,
      PLAYER_ONE,
    );
    const victim = spawnCombatUnit(
      world,
      comps,
      "militia",
      5.5,
      4.5,
      PLAYER_TWO,
    );
    attachPopSkills(world, comps, attacker); // only the attacker learns

    world.inbox.submit({
      kind: "attack",
      targetTick: 1,
      data: { attackerIds: [attacker], targetId: victim },
    });
    while (world.tick < 600 && combatDiagnostics.kills === 0) step(world);

    expect(combatDiagnostics.strikes).toBeGreaterThanOrEqual(5);
    expect(combatDiagnostics.kills).toBe(1);
    // Only the attacker holds a Skills row, so only THEIR strikes pay
    // XP — the victim's retaliations show up in diagnostics but never
    // in a skill sheet. Each attacker blow lands as one DAMAGE event on
    // the victim owner's ledger.
    const attackerStrikes = readCombatEvents(world, comps, PLAYER_TWO).filter(
      (event) => event.kind === COMBAT_EVENT_DAMAGE,
    ).length;
    expect(attackerStrikes).toBeGreaterThanOrEqual(5);
    const entry = readSkillEntries(world, comps, attacker)![0]!;
    expect(entry.slug).toBe("melee");
    expect(entry.practiceXp).toBe(
      attackerStrikes * 10 + 50, // COMBAT_XP_PER_HIT ×N + kill bonus
    );
    expect(entry.knowledgeXp).toBe(0);
  });
});

// ---- Digest participation ----------------------------------------------------------

describe("digest participation", () => {
  it("skills rows feed the world digest", () => {
    const { world, comps } = grassWorld(31);
    const eid = novice(world, comps);
    const afterAttach = computeWorldDigest(world);
    awardPractice(world, comps, eid, "gathering", 100);
    expect(computeWorldDigest(world)).not.toBe(afterAttach);
  });
});
