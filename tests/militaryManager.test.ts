/**
 * Military manager unit coverage — SPEC §2.8 layer 3 / M4-T6 (issue #61).
 *
 * Pure-decision tests over tiny stubbed knowledge surfaces: utility
 * scoring beats proximity, counter-picks read the §2.5 tables, and the
 * defense clock honors the reaction-latency knob. The golden trio
 * (m4t6a/b/c) covers the integrated pipeline; these pin the arithmetic.
 */
import { describe, expect, it } from "vitest";
import {
  createMilitaryMemory,
  planCounterTraining,
  planDefenseRally,
  planOffensive,
  planRelicCollection,
  planRelicDeposit,
  scoreOffensiveTarget,
  type MilitaryMemory,
} from "../src/sim/ai/militaryManager";
import type { CommandDraft } from "../src/sim/ai/buildOrder";
import {
  createResourceBudget,
  type AiKnowledge,
} from "../src/sim/ai/knowledge";
import { AI_DIFFICULTIES } from "../src/sim/ai/difficulty";

/** Minimal knowledge stub: only what each scenario needs. */
function knowledgeStub(parts: Partial<AiKnowledge> = {}): AiKnowledge {
  const never = (): never => {
    throw new Error("not needed in this scenario");
  };
  return {
    player: 1,
    // Lazily explosive: touching the raw fog handle is the one crime.
    get view(): never {
      return never();
    },
    tick: () => 0,
    resources: () => [0, 0, 0, 0, 0, 0, 0],
    ageRank: () => 1,
    nextAgeTechId: () => undefined,
    canStartAgeAdvance: () => false,
    finishedBuildings: () => [],
    ownBuildingOrigin: () => undefined,
    unfinishedSites: () => [],
    buildersOn: () => [],
    trainQueueOf: () => [],
    trainableUnitIds: () => [],
    population: () => 0,
    populationCap: () => 0,
    villagerEids: () => [],
    armyUnits: () => [],
    assignmentOf: () => undefined,
    carryOf: () => undefined,
    ownUnitTile: () => undefined,
    damagedOwnBuildings: () => [],
    knownNodes: () => [],
    workersOnNode: () => 0,
    visibleEnemies: () => [],
    visibleEnemyVillagers: () => [],
    canAfford: () => true,
    canPlace: () => true,
    placementBlockReason: () => undefined,
    canTrain: () => true,
    knownGroundRelics: () => [],
    ownMonasteries: () => [],
    carriedRelicOf: () => undefined,
    knownTargetMarkets: () => [],
    tradeCarts: () => [],
    isTradeCartActive: () => false,
    ...parts,
  } as AiKnowledge;
}

describe("offense scoring (utility vs proximity)", () => {
  it("pays villagers over nearer empty targets", () => {
    // House at distance² 45 with no workers; camp at 149 with three.
    const k = knowledgeStub({
      finishedBuildings: (defId) => (defId === "town-center" ? [100] : []),
      ownBuildingOrigin: () => ({ x: 3, y: 3 }),
      visibleEnemies: () => [
        { eid: 10, defId: "house", tileX: 7, tileY: 12 },
        { eid: 11, defId: "lumber-camp", tileX: 14, tileY: 13 },
      ],
      visibleEnemyVillagers: () => [
        { eid: 20, tileX: 14, tileY: 11 },
        { eid: 21, tileX: 15, tileY: 12 },
        { eid: 22, tileX: 13, tileY: 12 },
      ],
    });
    const target = scoreOffensiveTarget(k);
    expect(target?.targetId).toBe(11);
    expect(target?.villagersNearby).toBe(3);
  });

  it("returns undefined when fog offers nothing", () => {
    const k = knowledgeStub({});
    expect(scoreOffensiveTarget(k)).toBeUndefined();
  });
});

describe("one-shot offensive", () => {
  it("fires once below threshold never, and spends shared memory", () => {
    const memory: { attackedTick?: number | undefined } = {};
    const army = [
      { eid: 5, defId: "knight", tileX: 1, tileY: 1 },
      { eid: 6, defId: "knight", tileX: 1, tileY: 2 },
      { eid: 7, defId: "knight", tileX: 1, tileY: 3 },
    ];
    const k = knowledgeStub({
      armyUnits: () => army,
      finishedBuildings: (defId) => (defId === "town-center" ? [100] : []),
      ownBuildingOrigin: () => ({ x: 0, y: 0 }),
      visibleEnemies: () => [{ eid: 9, defId: "barracks", tileX: 6, tileY: 6 }],
    });
    const strategy = { attackArmyThreshold: 3 };
    const first = planOffensive(k, strategy, memory);
    expect(first?.data.attackerIds).toEqual([5, 6, 7]);
    expect(first?.data.targetId).toBe(9);
    expect(memory.attackedTick).toBe(0);
    // Spent memory silences every later pass.
    expect(planOffensive(k, strategy, memory)).toBeUndefined();
  });

  it("stays sheathed under the army threshold", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 5, defId: "knight", tileX: 1, tileY: 1 }],
      visibleEnemies: () => [{ eid: 9, defId: "barracks", tileX: 6, tileY: 6 }],
    });
    expect(planOffensive(k, { attackArmyThreshold: 2 }, {})).toBeUndefined();
  });
});

describe("counter-pick scoring (§2.5 tables)", () => {
  it("strict improvement gate: skirmisher beats archer line vs archers", () => {
    const k = knowledgeStub({
      visibleEnemies: () =>
        Array.from({ length: 6 }, (_, i) => ({
          eid: 30 + i,
          defId: "archer",
          tileX: 10,
          tileY: 10 + i,
        })),
      finishedBuildings: () => [50],
      trainableUnitIds: () => ["archer", "skirmisher"],
    });
    const out: { kind: string; data: Record<string, unknown> }[] = [];
    planCounterTraining(
      k,
      createResourceBudget(
        knowledgeStub({ resources: () => [999, 999, 999, 0, 0, 0, 0] }),
      ),
      createMilitaryMemory(),
      out as never,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.data.unitId).toBe("skirmisher");
  });

  it("never fires without scouted composition", () => {
    const k = knowledgeStub({
      finishedBuildings: () => [50],
      trainableUnitIds: () => ["archer", "skirmisher"],
    });
    const out: unknown[] = [];
    planCounterTraining(
      k,
      createResourceBudget(k),
      createMilitaryMemory(),
      out as never,
    );
    expect(out.length).toBe(0);
  });

  it("respects the per-match cap", () => {
    const k = knowledgeStub({
      visibleEnemies: () =>
        Array.from({ length: 6 }, (_, i) => ({
          eid: 30 + i,
          defId: "archer",
          tileX: 10,
          tileY: 10 + i,
        })),
      finishedBuildings: () => [50],
      trainableUnitIds: () => ["archer", "skirmisher"],
    });
    const memory: MilitaryMemory = createMilitaryMemory();
    memory.countersTrained = 8;
    const out: unknown[] = [];
    planCounterTraining(k, createResourceBudget(k), memory, out as never);
    expect(out.length).toBe(0);
  });
});

describe("defense rally latency", () => {
  function threatenedKnowledge(tick: number) {
    return knowledgeStub({
      tick: () => tick,
      armyUnits: () => [{ eid: 40, defId: "knight", tileX: 1, tileY: 1 }],
      visibleEnemies: () => [{ eid: 41, defId: "knight", tileX: 9, tileY: 9 }],
      damagedOwnBuildings: () => [
        { eid: 42, defId: "house", tileX: 8, tileY: 8 },
      ],
    });
  }

  it("holds for the preset delay then rallies once", () => {
    const memory = createMilitaryMemory();
    const delay = AI_DIFFICULTIES.normal.reactionDelayTicks;

    // Observation window: nothing before the delay elapses…
    for (let tick = 0; tick < delay; tick++) {
      expect(
        planDefenseRally(threatenedKnowledge(tick), memory, delay),
      ).toBeUndefined();
    }
    // …then exactly one rally on the first eligible probe.
    const rally = planDefenseRally(threatenedKnowledge(delay), memory, delay);
    expect(rally?.data.purpose).toBe("defense");
    expect(rally?.data.targetId).toBe(41);
    // Cooldown suppresses re-issue while the threat stands.
    expect(
      planDefenseRally(threatenedKnowledge(delay + 1), memory, delay),
    ).toBeUndefined();
  });

  it("hard reacts instantly; easy holds a full window", () => {
    const hardMemory = createMilitaryMemory();
    const hardRally = planDefenseRally(
      threatenedKnowledge(0),
      hardMemory,
      AI_DIFFICULTIES.hard.reactionDelayTicks,
    );
    expect(hardRally?.data.purpose).toBe("defense");

    const easyMemory = createMilitaryMemory();
    const easyDelay = AI_DIFFICULTIES.easy.reactionDelayTicks;
    // One tick of observation is not enough…
    expect(
      planDefenseRally(
        threatenedKnowledge(easyDelay - 1),
        easyMemory,
        easyDelay,
      ),
    ).toBeUndefined();
    // …and the clock keeps running across probes, so the rally lands a
    // full delay AFTER the first observation, not after the last one.
    const easyRally = planDefenseRally(
      threatenedKnowledge(2 * easyDelay - 1),
      easyMemory,
      easyDelay,
    );
    expect(easyRally?.data.purpose).toBe("defense");
  });

  it("restarts the clock when the threat leaves and returns", () => {
    const memory = createMilitaryMemory();
    const delay = 20;
    planDefenseRally(threatenedKnowledge(0), memory, delay);
    // Threat walks away — observation resets.
    const quiet = knowledgeStub({
      tick: () => 10,
      armyUnits: () => [{ eid: 40, defId: "knight", tileX: 1, tileY: 1 }],
      visibleEnemies: () => [
        { eid: 41, defId: "knight", tileX: 30, tileY: 30 },
      ],
      damagedOwnBuildings: () => [
        { eid: 42, defId: "house", tileX: 8, tileY: 8 },
      ],
    });
    expect(planDefenseRally(quiet, memory, delay)).toBeUndefined();
    // Back at tick 11: the clock restarts, no instant rally.
    const back = threatenedKnowledge(11);
    expect(planDefenseRally(back, memory, delay)).toBeUndefined();
  });
});

describe("relic collection planning (§2.11)", () => {
  it("emits nothing when no grounded relics exist", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 50, defId: "monk", tileX: 10, tileY: 10 }],
      knownGroundRelics: () => [],
    });
    const out: CommandDraft[] = [];
    planRelicCollection(k, out);
    expect(out).toHaveLength(0);
  });

  it("emits nothing when no monks exist", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 51, defId: "knight", tileX: 10, tileY: 10 }],
      knownGroundRelics: () => [{ eid: 1, tileX: 12, tileY: 10 }],
    });
    const out: CommandDraft[] = [];
    planRelicCollection(k, out);
    expect(out).toHaveLength(0);
  });

  it("assigns idle monk to nearest grounded relic", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 50, defId: "monk", tileX: 10, tileY: 10 }],
      knownGroundRelics: () => [
        { eid: 2, tileX: 30, tileY: 30 },
        { eid: 1, tileX: 12, tileY: 10 },
      ],
      carriedRelicOf: () => undefined,
    });
    const out: CommandDraft[] = [];
    planRelicCollection(k, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "collectRelic",
      data: { unitEid: 50, relicEid: 1 },
    });
  });

  it("skips monks already carrying a relic", () => {
    const k = knowledgeStub({
      armyUnits: () => [
        { eid: 50, defId: "monk", tileX: 10, tileY: 10 },
        { eid: 51, defId: "monk", tileX: 15, tileY: 15 },
      ],
      knownGroundRelics: () => [{ eid: 1, tileX: 11, tileY: 10 }],
      carriedRelicOf: (eid) => (eid === 50 ? 99 : undefined),
    });
    const out: CommandDraft[] = [];
    planRelicCollection(k, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "collectRelic",
      data: { unitEid: 51, relicEid: 1 },
    });
  });

  it("pairs multiple monks to multiple relics uniquely", () => {
    const k = knowledgeStub({
      armyUnits: () => [
        { eid: 50, defId: "monk", tileX: 2, tileY: 2 },
        { eid: 51, defId: "monk", tileX: 20, tileY: 20 },
      ],
      knownGroundRelics: () => [
        { eid: 1, tileX: 3, tileY: 2 },
        { eid: 2, tileX: 21, tileY: 20 },
      ],
      carriedRelicOf: () => undefined,
    });
    const out: CommandDraft[] = [];
    planRelicCollection(k, out);
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({
      kind: "collectRelic",
      data: { unitEid: 50, relicEid: 1 },
    });
    expect(out).toContainEqual({
      kind: "collectRelic",
      data: { unitEid: 51, relicEid: 2 },
    });
  });
});

describe("relic deposit planning (§2.11)", () => {
  it("emits nothing when no monks carry a relic", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 50, defId: "monk", tileX: 10, tileY: 10 }],
      ownMonasteries: () => [{ eid: 100, tileX: 12, tileY: 12 }],
      carriedRelicOf: () => undefined,
    });
    const out: CommandDraft[] = [];
    planRelicDeposit(k, out);
    expect(out).toHaveLength(0);
  });

  it("emits nothing when monk carries relic but no monastery exists", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 50, defId: "monk", tileX: 10, tileY: 10 }],
      ownMonasteries: () => [],
      carriedRelicOf: () => 1,
    });
    const out: CommandDraft[] = [];
    planRelicDeposit(k, out);
    expect(out).toHaveLength(0);
  });

  it("orders carrier monk to deposit in nearest monastery", () => {
    const k = knowledgeStub({
      armyUnits: () => [{ eid: 50, defId: "monk", tileX: 10, tileY: 10 }],
      ownMonasteries: () => [
        { eid: 101, tileX: 30, tileY: 30 },
        { eid: 100, tileX: 12, tileY: 10 },
      ],
      carriedRelicOf: (eid) => (eid === 50 ? 1 : undefined),
    });
    const out: CommandDraft[] = [];
    planRelicDeposit(k, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "depositRelic",
      data: { unitEid: 50, monasteryEid: 100 },
    });
  });

  it("handles multiple carrying monks each targeting their nearest monastery", () => {
    const k = knowledgeStub({
      armyUnits: () => [
        { eid: 50, defId: "monk", tileX: 2, tileY: 2 },
        { eid: 51, defId: "monk", tileX: 28, tileY: 28 },
      ],
      ownMonasteries: () => [
        { eid: 100, tileX: 0, tileY: 0 },
        { eid: 101, tileX: 30, tileY: 30 },
      ],
      carriedRelicOf: () => 1,
    });
    const out: CommandDraft[] = [];
    planRelicDeposit(k, out);
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({
      kind: "depositRelic",
      data: { unitEid: 50, monasteryEid: 100 },
    });
    expect(out).toContainEqual({
      kind: "depositRelic",
      data: { unitEid: 51, monasteryEid: 101 },
    });
  });
});
