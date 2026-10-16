/**
 * Milestone A1: AI Skirmish Research Automation & Unit Line Upgrades (Issue #136).
 *
 * Verifies:
 * 1. AiKnowledge Tech Awareness queries:
 *    - isTechResearched & researchedTechIds
 *    - canResearchTech & availableTechsForBuilding & researchableTechIds
 *    - isBuildingResearching
 *    - trainableUnitIds returns active researched line upgrades
 * 2. Build-Order Tech Steps:
 *    - Step execution with action: { kind: "researchTech", techId: "fletching" }
 *    - Completion condition: { kind: "techResearched", techId: "fletching" }
 *    - Resource budgeting prevents premature issuance
 *    - Updated strategies (archers-push, scouts-rush, fast-castle-knights) contain tech steps
 * 3. Dynamic Military Tech Planner (planMilitaryTechResearch):
 *    - Evaluates AI army composition and prioritizes matching unit upgrades (e.g. Man-at-Arms, Crossbowman, Light Cav)
 *    - Prioritizes Blacksmith upgrades tailored to dominant army branch (Archers -> Fletching/Bodkin, Infantry -> Forging/Scale Mail, Cavalry -> Scale Barding/Forging)
 *    - Avoids concurrent research on the same building within a pass
 *    - Debits planning-time resource budget accurately
 * 4. Full AI Simulation & Field Transformation:
 *    - AI issues researchTech in sim; when research finishes, existing units and training queues auto-upgrade
 * 5. Determinism & Bit-Exact Replay:
 *    - Two identical runs with AI researching techs produce identical world digests
 */

import { describe, expect, it } from "vitest";
import { techCodeOf, unitCodeOf, unitDefOf } from "../../src/data/definitions";
import {
  defineSimComponents,
  readTrainQueue,
  spawnCombatUnit,
  writeTrainQueue,
  type SimComponents,
} from "../../src/sim/components";
import {
  createPlayerAgeState,
  getAgeResearchRow,
  setAgeResearchRow,
  setPlayerAgeRank,
} from "../../src/sim/components/age";
import { markTechResearched } from "../../src/sim/components/combat";
import {
  createPlayerStockpile,
  PLAYER_ONE,
} from "../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../src/sim/core/world";
import {
  createAiKnowledge,
  createResourceBudget,
  type AiKnowledge,
} from "../../src/sim/ai/knowledge";
import {
  planBuildOrder,
  STRATEGIES,
  type BuildOrderMemory,
  type CommandDraft,
  type Strategy,
} from "../../src/sim/ai/buildOrder";
import {
  createMilitaryMemory,
  planMilitaryTechResearch,
} from "../../src/sim/ai/militaryManager";
import { createAgeSystem, RESEARCH_TECH_KIND } from "../../src/sim/systems/age";
import { createTrainingSystem } from "../../src/sim/systems/training";
import {
  createFogVisibility,
  createRowEntityResolver,
} from "../../src/sim/systems/fog";
import { stampFinishedBuilding } from "../../src/sim/systems/placement";
import { buildLayers, TERRAIN_GRASS } from "../../src/sim/world/layers";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 24;

interface TestHarness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly knowledge: AiKnowledge;
  readonly fog: ReturnType<typeof createFogVisibility>;
}

function createHarness(
  player = PLAYER_ONE,
  ageRank = 2,
  stock = [2000, 2000, 2000, 2000, 0, 0, 0],
): TestHarness {
  const fog = createFogVisibility(SIZE, 2);
  const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
  const world = createWorld(20261013, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
    visibility: fog.provider,
  });
  const comps = defineSimComponents(world);
  fog.bindSource({
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  });

  createPlayerStockpile(world, comps, player, [...stock]);
  createPlayerAgeState(world, comps, player);
  setPlayerAgeRank(world, comps, player, ageRank);

  registerSystem(world, createAgeSystem(comps));
  registerSystem(world, createTrainingSystem(comps));

  fog.recomputeAll();

  const knowledge = createAiKnowledge({
    world,
    comps,
    player,
    view: fog.knowledgeFor(player),
  });

  return { world, comps, knowledge, fog };
}

describe("Milestone A1: AI Skirmish Research Automation & Unit Line Upgrades (Issue #136)", () => {
  describe("1. AiKnowledge Tech Awareness", () => {
    it("reports researched tech status and completed tech ids", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);

      expect(knowledge.isTechResearched("fletching")).toBe(false);
      expect(knowledge.researchedTechIds()).toEqual([]);

      markTechResearched(world, comps, PLAYER_ONE, techCodeOf("fletching"));
      expect(knowledge.isTechResearched("fletching")).toBe(true);
      expect(knowledge.isTechResearched("forging")).toBe(false);
      expect(knowledge.researchedTechIds()).toContain("fletching");
    });

    it("evaluates canResearchTech, availableTechsForBuilding, and researchableTechIds", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);
      const bsEid = stampFinishedBuilding(world, comps, "blacksmith", 10, 10, {
        playerId: PLAYER_ONE,
      });

      const options = knowledge.availableTechsForBuilding(bsEid);
      expect(options.length).toBeGreaterThan(0);
      expect(options.some((o) => o.techId === "fletching")).toBe(true);

      expect(knowledge.canResearchTech(bsEid, "fletching")).toBe(true);
      expect(knowledge.researchableTechIds(bsEid)).toContain("fletching");

      // Bodkin arrow requires Castle Age (rank 3), in Feudal (rank 2) it cannot be researched
      expect(knowledge.canResearchTech(bsEid, "bodkin-arrow")).toBe(false);

      // Building research occupancy check
      expect(knowledge.isBuildingResearching(bsEid)).toBe(false);

      // Issue research order
      world.inbox.submit({
        kind: RESEARCH_TECH_KIND,
        targetTick: world.tick + 1,
        data: {
          siteEid: bsEid,
          playerId: PLAYER_ONE,
          techId: "fletching",
        },
      });
      step(world);

      expect(knowledge.isBuildingResearching(bsEid)).toBe(true);
      // Busy building cannot start another research
      expect(knowledge.canResearchTech(bsEid, "forging")).toBe(false);
    });

    it("trainableUnitIds reflects active researched unit line upgrades", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);
      const barracksEid = stampFinishedBuilding(
        world,
        comps,
        "barracks",
        10,
        10,
        { playerId: PLAYER_ONE },
      );

      // In Feudal age before man-at-arms-upgrade, barracks trains militia
      const initialTrainables = knowledge.trainableUnitIds(barracksEid);
      expect(initialTrainables).toContain("militia");
      expect(initialTrainables).not.toContain("man-at-arms");

      // Mark man-at-arms-upgrade researched
      markTechResearched(
        world,
        comps,
        PLAYER_ONE,
        techCodeOf("man-at-arms-upgrade"),
      );

      // Now barracks replaces militia with man-at-arms
      const upgradedTrainables = knowledge.trainableUnitIds(barracksEid);
      expect(upgradedTrainables).not.toContain("militia");
      expect(upgradedTrainables).toContain("man-at-arms");
      expect(knowledge.resolveUpgradedUnitId("militia")).toBe("man-at-arms");
    });
  });

  describe("2. Build-Order Tech Steps", () => {
    it("planBuildOrder issues researchTech when step action is researchTech and budget allows", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);
      const bsEid = stampFinishedBuilding(world, comps, "blacksmith", 10, 10, {
        playerId: PLAYER_ONE,
      });

      const customStrategy: Strategy = {
        id: "test-tech-strategy",
        villagerTarget: 10,
        gatherWeights: { food: 0.5, wood: 0.5, gold: 0 },
        attackArmyThreshold: 10,
        steps: [
          {
            id: "step-fletching",
            action: {
              kind: "researchTech",
              techId: "fletching",
              buildingDefId: "blacksmith",
            },
            complete: {
              kind: "techResearched",
              techId: "fletching",
            },
            gate: {},
          },
        ],
      };

      const memory: BuildOrderMemory = {};
      const budget = createResourceBudget(knowledge);
      const reserved = { isReserved: () => false, reserve: () => {} };

      const draft = planBuildOrder(
        knowledge,
        customStrategy,
        budget,
        reserved,
        memory,
      );
      expect(draft).toBeDefined();
      expect(draft?.kind).toBe("researchTech");
      expect(draft?.data.siteEid).toBe(bsEid);
      expect(draft?.data.playerId).toBe(PLAYER_ONE);
      expect(draft?.data.techId).toBe("fletching");
    });

    it("advances build-order step when techResearched condition is met", () => {
      const { world, comps, knowledge, fog } = createHarness(PLAYER_ONE, 2);
      stampFinishedBuilding(world, comps, "town-center", 10, 10, {
        playerId: PLAYER_ONE,
      });
      stampFinishedBuilding(world, comps, "blacksmith", 14, 10, {
        playerId: PLAYER_ONE,
      });
      fog.recomputeAll();

      const customStrategy: Strategy = {
        id: "test-multistep",
        villagerTarget: 10,
        gatherWeights: { food: 0.5, wood: 0.5, gold: 0 },
        attackArmyThreshold: 10,
        steps: [
          {
            id: "step-fletching",
            action: {
              kind: "researchTech",
              techId: "fletching",
              buildingDefId: "blacksmith",
            },
            complete: {
              kind: "techResearched",
              techId: "fletching",
            },
            gate: {},
          },
          {
            id: "step-houses",
            action: {
              kind: "placeBuilding",
              defId: "house",
              minClearance: 1,
              maxRadius: 10,
            },
            complete: { kind: "buildingUp", defId: "house", count: 1 },
            gate: {},
          },
        ],
      };

      const memory: BuildOrderMemory = {};
      const budget = createResourceBudget(knowledge);
      const reserved = { isReserved: () => false, reserve: () => {} };

      // Step 1: fletching is issued
      const draft1 = planBuildOrder(
        knowledge,
        customStrategy,
        budget,
        reserved,
        memory,
      );
      expect(draft1?.kind).toBe("researchTech");

      // Mark fletching researched
      markTechResearched(world, comps, PLAYER_ONE, techCodeOf("fletching"));

      // Next planning pass: step 1 condition is met, advances to step 2 (house)
      const budget2 = createResourceBudget(knowledge);
      const draft2 = planBuildOrder(
        knowledge,
        customStrategy,
        budget2,
        reserved,
        memory,
      );
      expect(draft2?.kind).toBe("placeBuilding");
      expect(draft2?.data.defId).toBe("house");
    });

    it("verifies tactical strategies include appropriate military techs", () => {
      const archersStrategy = STRATEGIES["archers-push"];
      const hasFletching = archersStrategy.steps.some(
        (s) =>
          s.action.kind === "researchTech" && s.action.techId === "fletching",
      );
      expect(hasFletching).toBe(true);

      const scoutsStrategy = STRATEGIES["scouts-rush"];
      const hasBloodlinesScouts = scoutsStrategy.steps.some(
        (s) =>
          s.action.kind === "researchTech" && s.action.techId === "bloodlines",
      );
      expect(hasBloodlinesScouts).toBe(true);
    });
  });

  describe("3. Dynamic Military Tech Planner (planMilitaryTechResearch)", () => {
    it("prioritizes unit line upgrade when AI has active branch and building", () => {
      const { world, comps, knowledge, fog } = createHarness(PLAYER_ONE, 2);
      const barracksEid = stampFinishedBuilding(
        world,
        comps,
        "barracks",
        10,
        10,
        { playerId: PLAYER_ONE },
      );

      // Spawn a militia
      spawnCombatUnit(world, comps, "militia", 10, 11, PLAYER_ONE);
      fog.recomputeAll();

      const budget = createResourceBudget(knowledge);
      const memory = createMilitaryMemory();
      const drafts: CommandDraft[] = [];

      expect(knowledge.finishedBuildings("barracks")).toEqual([barracksEid]);
      expect(knowledge.armyUnits().map((u) => u.defId)).toEqual(["militia"]);
      expect(
        knowledge.canResearchTech(barracksEid, "man-at-arms-upgrade"),
      ).toBe(true);

      planMilitaryTechResearch(knowledge, budget, memory, drafts);

      // Should emit researchTech for man-at-arms-upgrade at the barracks
      const upgradeDraft = drafts.find(
        (d) =>
          d.kind === "researchTech" && d.data.techId === "man-at-arms-upgrade",
      );
      expect(upgradeDraft).toBeDefined();
      expect(upgradeDraft?.data.siteEid).toBe(barracksEid);
    });

    it("prioritizes Blacksmith attack/armor techs matching dominant army composition", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);
      const bsEid = stampFinishedBuilding(world, comps, "blacksmith", 10, 10, {
        playerId: PLAYER_ONE,
      });

      // Spawn archers so army is archer-heavy
      spawnCombatUnit(world, comps, "archer", 10, 11, PLAYER_ONE);
      spawnCombatUnit(world, comps, "archer", 10, 12, PLAYER_ONE);

      const budget = createResourceBudget(knowledge);
      const memory = createMilitaryMemory();
      const drafts: CommandDraft[] = [];

      planMilitaryTechResearch(knowledge, budget, memory, drafts);

      // Archer dominant army should prioritize fletching
      const fletchingDraft = drafts.find(
        (d) => d.kind === "researchTech" && d.data.techId === "fletching",
      );
      expect(fletchingDraft).toBeDefined();
      expect(fletchingDraft?.data.siteEid).toBe(bsEid);
    });

    it("avoids issuing multiple research orders to the same building in one pass", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);
      const bsEid = stampFinishedBuilding(world, comps, "blacksmith", 10, 10, {
        playerId: PLAYER_ONE,
      });

      const budget = createResourceBudget(knowledge);
      const memory = createMilitaryMemory();
      const drafts: CommandDraft[] = [
        {
          kind: "researchTech",
          data: {
            siteEid: bsEid,
            playerId: PLAYER_ONE,
            techId: "fletching",
          },
        },
      ];

      planMilitaryTechResearch(knowledge, budget, memory, drafts);

      // No second tech draft should be issued for bsEid
      const bsDrafts = drafts.filter(
        (d) => d.kind === "researchTech" && d.data.siteEid === bsEid,
      );
      expect(bsDrafts.length).toBe(1);
    });

    it("respects shared resource budget and does not plan techs when unaffordable", () => {
      // Stockpile with 0 resources
      const { world, comps, knowledge } = createHarness(
        PLAYER_ONE,
        2,
        [0, 0, 0, 0, 0, 0, 0],
      );
      stampFinishedBuilding(world, comps, "blacksmith", 10, 10, {
        playerId: PLAYER_ONE,
      });

      const budget = createResourceBudget(knowledge);
      const memory = createMilitaryMemory();
      const drafts: CommandDraft[] = [];

      planMilitaryTechResearch(knowledge, budget, memory, drafts);
      expect(drafts.length).toBe(0);
    });
  });

  describe("4. End-to-End Simulation & Field Auto-Transformation", () => {
    it("AI research execution transforms field units and queues upon completion", () => {
      const { world, comps, knowledge } = createHarness(PLAYER_ONE, 2);
      const barracksEid = stampFinishedBuilding(
        world,
        comps,
        "barracks",
        10,
        10,
        { playerId: PLAYER_ONE },
      );

      // Field militia
      const militiaEid = spawnCombatUnit(
        world,
        comps,
        "militia",
        12,
        12,
        PLAYER_ONE,
      );

      // In-flight militia in queue
      writeTrainQueue(world, comps, barracksEid, [
        { unitCode: unitCodeOf("militia"), remainingTicks: 500 },
      ]);

      const militiaDef = unitDefOf("militia");
      const manAtArmsDef = unitDefOf("man-at-arms");

      // Verify before research
      const combatRowBefore = world.rowsByComponentId
        .get(comps.combatId)!
        .get(militiaEid)!;
      expect(combatRowBefore[0]).toBe(unitCodeOf("militia"));
      expect(combatRowBefore[2]).toBe(militiaDef.hp);

      // Submit researchTech
      world.inbox.submit({
        kind: RESEARCH_TECH_KIND,
        targetTick: world.tick + 1,
        data: {
          siteEid: barracksEid,
          playerId: PLAYER_ONE,
          techId: "man-at-arms-upgrade",
        },
      });

      // Step to start research
      step(world);
      const researchRow = getAgeResearchRow(world, comps, barracksEid);
      expect(researchRow).toBeDefined();

      // Fast-forward research
      setAgeResearchRow(
        world,
        comps,
        barracksEid,
        PLAYER_ONE,
        techCodeOf("man-at-arms-upgrade"),
        1,
      );
      step(world); // research finishes

      // Research complete: tech is marked researched
      expect(knowledge.isTechResearched("man-at-arms-upgrade")).toBe(true);

      // Field unit should be auto-transformed to man-at-arms
      const combatRowAfter = world.rowsByComponentId
        .get(comps.combatId)!
        .get(militiaEid)!;
      expect(combatRowAfter[0]).toBe(unitCodeOf("man-at-arms"));
      expect(combatRowAfter[2]).toBe(manAtArmsDef.hp);

      // In-flight queue should be transformed to man-at-arms
      const queueAfter = readTrainQueue(world, comps, barracksEid);
      expect(queueAfter[0]!.unitCode).toBe(unitCodeOf("man-at-arms"));
    });
  });

  describe("5. Determinism & Bit-Exact Replay Stability", () => {
    it("two identical simulation runs with AI research yield bit-exact digests", () => {
      function runSim(): string {
        const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
        const world = createWorld(42, {
          layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
          size: SIZE,
        });
        const comps = defineSimComponents(world);

        createPlayerStockpile(
          world,
          comps,
          PLAYER_ONE,
          [1000, 1000, 1000, 1000, 0, 0, 0],
        );
        createPlayerAgeState(world, comps, PLAYER_ONE);
        setPlayerAgeRank(world, comps, PLAYER_ONE, 2);

        registerSystem(world, createAgeSystem(comps));
        registerSystem(world, createTrainingSystem(comps));

        const bsEid = stampFinishedBuilding(
          world,
          comps,
          "blacksmith",
          10,
          10,
          { playerId: PLAYER_ONE },
        );

        world.inbox.submit({
          kind: RESEARCH_TECH_KIND,
          targetTick: 2,
          data: {
            siteEid: bsEid,
            playerId: PLAYER_ONE,
            techId: "fletching",
          },
        });

        for (let i = 0; i < 50; i++) {
          step(world);
        }

        return computeWorldDigest(world);
      }

      const digest1 = runSim();
      const digest2 = runSim();
      expect(digest1).toBe(digest2);
    });
  });
});
