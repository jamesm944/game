/**
 * Age advancement + gate enforcement tests — SPEC §2.11/§3 / M2-T4.
 *
 * The researchAge command pins the AoE2 shape: costs escrowed at
 * enqueue, researchTime counting down every tick from the command tick
 * inclusive (completion lands exactly on enqueueTick + researchTime),
 * completion promoting the player's AgeState rank and appending a
 * digest-visible AgeAdvanced event. Gate enforcement runs across ALL
 * three content handlers — placement, training, research — as polite,
 * digest-visible GateRejected rows that never throw, never pay, never
 * spawn; the production seam's default predicate reads the same age
 * state so gated recipes stall until their age arrives. Worlds with no
 * AgeState row predate the system and stay fully unlocked.
 */
import { describe, expect, it } from "vitest";
import {
  buildingCodeOf,
  techCodeOf,
  unitCodeOf,
} from "../src/data/definitions";
import {
  AGE_DARK_RANK,
  GATE_HANDLER_PLACE,
  GATE_HANDLER_RESEARCH,
  GATE_HANDLER_TRAIN,
  ageRankOf,
  createPlayerAgeState,
  getAgeResearchRow,
  readAgeAdvancedEvents,
  readGateRejections,
  setPlayerAgeRank,
} from "../src/sim/components/age";
import {
  defineSimComponents,
  populationOf,
  readTrainQueue,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  PLAYER_ONE,
  commodityAmountOf,
  createCommodityStockpile,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  RESEARCH_AGE_KIND,
  ageLabelOf,
  createAgeDiagnostics,
  createAgeSystem,
  currentAgeRankOf,
  type AgeDiagnostics,
} from "../src/sim/systems/age";
import {
  TRAIN_VILLAGER_KIND,
  canEnqueueTraining,
  createTrainingDiagnostics,
  createTrainingSystem,
} from "../src/sim/systems/training";
import {
  PLACE_BUILDING_KIND,
  createPlacementDiagnostics,
  createPlacementSystem,
  validatePlacement,
} from "../src/sim/systems/placement";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  PRODUCE_KIND,
  createProductionDiagnostics,
  createProductionSystem,
  type ProductionDiagnostics,
} from "../src/sim/systems/production";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const SIZE = 24;

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly age: AgeDiagnostics;
  readonly training: ReturnType<typeof createTrainingDiagnostics>;
  readonly placement: ReturnType<typeof createPlacementDiagnostics>;
  readonly production: ProductionDiagnostics;
}

/**
 * Ample ledger (eid 1) + all four content systems. `withAge` seeds the
 * Dark-Age AgeState row; legacy worlds omit it (everything unlocked).
 */
function harness({
  food = 6000,
  withAge = true,
}: { food?: number | undefined; withAge?: boolean | undefined } = {}): Harness {
  const terrainType = new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS);
  const world = createWorld(20260824, {
    layers: buildLayers(terrainType, new Uint8Array(SIZE * SIZE)),
    size: SIZE,
  });
  const comps = defineSimComponents(world);
  const age = createAgeDiagnostics();
  const training = createTrainingDiagnostics();
  const placement = createPlacementDiagnostics();
  const production = createProductionDiagnostics();
  registerSystem(world, createTrainingSystem(comps, training));
  registerSystem(world, createProductionSystem(comps, production));
  registerSystem(world, createAgeSystem(comps, age));
  registerSystem(world, createPlacementSystem(comps, placement));
  createPlayerStockpile(world, comps, PLAYER_ONE, [
    food,
    2000,
    1500,
    200,
    0,
    0,
    0,
  ]);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  if (withAge) createPlayerAgeState(world, comps, PLAYER_ONE);
  return { world, comps, age, training, placement, production };
}

/** Stamp the start TC (eid 2) and return its entity id. */
function stampTC(h: Harness): number {
  return stampFinishedBuilding(h.world, h.comps, "town-center", 4, 4, {
    playerId: PLAYER_ONE,
  });
}

function submit(h: Harness, kind: string, data: Record<string, unknown>): void {
  h.world.inbox.submit({ kind, targetTick: h.world.tick + 1, data });
}

function research(h: Harness, techId?: string, siteEid?: number): void {
  submit(h, RESEARCH_AGE_KIND, {
    ...(techId !== undefined ? { techId } : {}),
    ...(siteEid !== undefined ? { siteEid } : {}),
  });
}

describe("age advancement (M2-T4)", () => {
  it("escrows at enqueue and completes exactly researchTime ticks later", () => {
    const h = harness();
    const tc = stampTC(h);
    expect(currentAgeRankOf(h.world, h.comps, PLAYER_ONE)).toBe(AGE_DARK_RANK);

    research(h); // defaults to the next rung: feudal-age
    step(h.world); // tick 1: escrow + open the row + first countdown

    // Full cost left the ledger at ENQUEUE (AoE2-faithful escrow).
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[0]).toBe(
      6000 - 500,
    );
    // Same-tick first countdown mirrors training parity: 3900 → 3899.
    expect(getAgeResearchRow(h.world, h.comps, tc)).toEqual([
      0,
      techCodeOf("feudal-age"),
      3899,
    ]);

    while (h.world.tick < 3899) step(h.world);
    expect(ageRankOf(h.world, h.comps, PLAYER_ONE)).toBe(AGE_DARK_RANK);
    expect(readAgeAdvancedEvents(h.world, h.comps, PLAYER_ONE)).toEqual([]);

    // Tick 3900 = enqueueTick(1) + researchTime(3900) − 1: the command
    // tick itself counts as the first research tick (training parity).
    step(h.world);
    expect(h.world.tick).toBe(3900);
    expect(ageRankOf(h.world, h.comps, PLAYER_ONE)).toBe(2);
    expect(readAgeAdvancedEvents(h.world, h.comps, PLAYER_ONE)).toEqual([
      { tick: 3900, ageRank: 2 },
    ]);
    expect(getAgeResearchRow(h.world, h.comps, tc)).toBeUndefined();
    expect(h.age.advancesCompleted).toBe(1);
  });

  it("honors explicit techId/siteEid and throws on duplicate research", () => {
    const h = harness();
    stampTC(h);
    const barracks = stampFinishedBuilding(h.world, h.comps, "barracks", 12, 4);

    // Jump to feudal + stand the castle prereqs so the tech gate passes;
    // then double-book the SAME host building while its row is live.
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, 2);
    stampFinishedBuilding(h.world, h.comps, "blacksmith", 16, 4);
    stampFinishedBuilding(h.world, h.comps, "blacksmith", 20, 4);

    research(h, "castle-age", barracks);
    step(h.world);
    expect(getAgeResearchRow(h.world, h.comps, barracks)?.[1]).toBe(
      techCodeOf("castle-age"),
    );
    expect(getAgeResearchRow(h.world, h.comps, 2)).toBeUndefined();

    research(h, "castle-age", barracks);
    expect(() => step(h.world)).toThrow(/already researching/);
  });

  it("rejects unknown and non-age techIds loudly", () => {
    const h = harness();
    stampTC(h);
    research(h, "forging");
    expect(() => step(h.world)).toThrow(/age advances only/);
    research(h, "no-such-tech");
    expect(() => step(h.world)).toThrow(/unknown tech definition/);
  });

  it("walks the full Dark→Feudal→Castle→Imperial ladder", () => {
    const h = harness();
    stampTC(h);

    research(h); // feudal
    step(h.world);
    while (currentAgeRankOf(h.world, h.comps, PLAYER_ONE) < 2) {
      step(h.world);
    }

    // Castle needs two finished prior-age military buildings standing.
    stampFinishedBuilding(h.world, h.comps, "blacksmith", 16, 4);
    stampFinishedBuilding(h.world, h.comps, "archery-range", 16, 10);
    research(h); // castle
    step(h.world);
    while (currentAgeRankOf(h.world, h.comps, PLAYER_ONE) < 3) {
      step(h.world);
    }

    research(h); // imperial
    step(h.world);
    while (currentAgeRankOf(h.world, h.comps, PLAYER_ONE) < 4) {
      step(h.world);
    }

    // Exact pinned rungs: the command tick counts as the first research
    // tick, so each advance completes at enqueue + researchTime − 1
    // (enqueues at 1 / 3901 / 8701 → 3900 / 8700 / 13800).
    expect(readAgeAdvancedEvents(h.world, h.comps, PLAYER_ONE)).toEqual([
      { tick: 3900, ageRank: 2 },
      { tick: 8700, ageRank: 3 },
      { tick: 13800, ageRank: 4 },
    ]);
    // Total ladder cost: 500f + 800f·200g + 1000f·800g.
    const amounts = stockpileAmountsOf(h.world, h.comps, PLAYER_ONE);
    expect(amounts[0]).toBe(6000 - 2300);
    expect(amounts[2]).toBe(1500 - 1000);
    expect(h.age.advancesCompleted).toBe(3);
    expect(ageLabelOf(4)).toBe("Imperial Age");
  });
});

describe("gate enforcement across handlers (M2-T4)", () => {
  it("placement: gated buildings refuse politely, ledger untouched", () => {
    const h = harness();
    stampTC(h);

    submit(h, PLACE_BUILDING_KIND, {
      defId: "blacksmith",
      tileX: 8,
      tileY: 8,
    });
    step(h.world); // must NOT throw

    expect(readGateRejections(h.world, h.comps, PLAYER_ONE)).toEqual([
      {
        tick: 1,
        handler: GATE_HANDLER_PLACE,
        defCode: buildingCodeOf("blacksmith"),
      },
    ]);
    // No site spawned, no cost paid.
    expect([
      ...h.world.rowsByComponentId.get(h.comps.buildingSiteId)!.keys(),
    ]).toEqual([]);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]).toBe(2000);
    expect(h.placement.gateRejections).toBe(1);

    // The shared verdict reports the same reason for the ghost UI…
    expect(validatePlacement(h.world, h.comps, "blacksmith", 8, 8)).toEqual({
      ok: false,
      reason: "age-gated",
    });
    // …and the world keeps stepping: dark-age content still works.
    submit(h, TRAIN_VILLAGER_KIND, {});
    step(h.world);
    expect(readTrainQueue(h.world, h.comps, 2)).toHaveLength(1);
  });

  it("training: gated units refuse politely until their age arrives", () => {
    const h = harness();
    stampTC(h);
    const stable = stampFinishedBuilding(h.world, h.comps, "stable", 12, 4);

    submit(h, TRAIN_VILLAGER_KIND, { siteEid: stable }); // scout-cavalry: feudal
    step(h.world); // polite refusal, not a throw

    expect(readGateRejections(h.world, h.comps, PLAYER_ONE)).toEqual([
      {
        tick: 1,
        handler: GATE_HANDLER_TRAIN,
        defCode: unitCodeOf("scout-cavalry"),
      },
    ]);
    expect(readTrainQueue(h.world, h.comps, stable)).toEqual([]);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[0]).toBe(6000);
    expect(canEnqueueTraining(h.world, h.comps, stable)).toBe(false);
    expect(h.training.gateRejections).toBe(1);

    // Reach feudal: the same order now enqueues and escrows normally.
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, 2);
    expect(canEnqueueTraining(h.world, h.comps, stable)).toBe(true);
    submit(h, TRAIN_VILLAGER_KIND, { siteEid: stable });
    step(h.world);
    // Same-tick first countdown mirrors training parity: 900 → 899.
    expect(readTrainQueue(h.world, h.comps, stable)).toEqual([
      { unitCode: unitCodeOf("scout-cavalry"), remainingTicks: 899 },
    ]);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[0]).toBe(6000 - 80);
    expect(h.training.gateRejections).toBe(1);
  });

  it("research: advances refuse outside their exact rung", () => {
    const h = harness();
    stampTC(h);

    // Skipping ahead: castle tech demands feudal FIRST.
    research(h, "castle-age");
    step(h.world);
    expect(readGateRejections(h.world, h.comps, PLAYER_ONE)).toEqual([
      {
        tick: 1,
        handler: GATE_HANDLER_RESEARCH,
        defCode: techCodeOf("castle-age"),
      },
    ]);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[0]).toBe(6000);
    expect(getAgeResearchRow(h.world, h.comps, 2)).toBeUndefined();

    // Redundant re-research past the rung refuses equally politely.
    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, 3);
    stampFinishedBuilding(h.world, h.comps, "blacksmith", 16, 4);
    stampFinishedBuilding(h.world, h.comps, "blacksmith", 20, 4);
    research(h, "feudal-age");
    step(h.world);
    expect(readGateRejections(h.world, h.comps, PLAYER_ONE)).toHaveLength(2);
    expect(h.age.commandsApplied).toBe(0);
  });

  it("production: gated recipes stall until the owner reaches the age", () => {
    const h = harness();
    const sawpit = stampFinishedBuilding(h.world, h.comps, "sawpit", 6, 6);
    const crafter = spawnUnit(h.world, h.comps, 8.5, 6.5);

    submit(h, PRODUCE_KIND, { entityIds: [crafter], buildingEid: sawpit });
    step(h.world);
    for (let i = 0; i < 40; i++) step(h.world);
    // Planks are feudal content: the default seam stalls politely.
    expect(h.production.cyclesStarted).toBe(0);
    expect(h.production.gateBlockedTicks).toBeGreaterThan(0);
    expect(commodityAmountOf(h.world, h.comps, PLAYER_ONE, 0)).toBe(0);

    setPlayerAgeRank(h.world, h.comps, PLAYER_ONE, 2);
    step(h.world); // resumes the very next tick after the age lands
    expect(h.production.cyclesStarted).toBe(1);
    expect(stockpileAmountsOf(h.world, h.comps, PLAYER_ONE)[1]).toBe(2000 - 2);
  });

  it("legacy worlds without AgeState rows keep everything unlocked", () => {
    const h = harness({ withAge: false });
    stampTC(h);
    const stable = stampFinishedBuilding(h.world, h.comps, "stable", 12, 4);

    expect(validatePlacement(h.world, h.comps, "blacksmith", 18, 18).ok).toBe(
      true,
    );
    expect(canEnqueueTraining(h.world, h.comps, stable)).toBe(true);
    submit(h, TRAIN_VILLAGER_KIND, { siteEid: stable });
    step(h.world);
    expect(readTrainQueue(h.world, h.comps, stable)).toHaveLength(1);
    // No age rows anywhere: nothing was ever refused or promoted.
    expect(readGateRejections(h.world, h.comps, PLAYER_ONE)).toEqual([]);
    expect(readAgeAdvancedEvents(h.world, h.comps, PLAYER_ONE)).toEqual([]);
    expect(populationOf(h.world, h.comps)).toBe(0);
  });
});
