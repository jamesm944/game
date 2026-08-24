/**
 * Household tests — SPEC §2.3 family/household / M3-T5 (issue #50).
 *
 * Pinned here:
 * - family formation needs BOTH surplus legs: a finished house with
 *   spare capacity AND a food surplus — the housing-shortage fixture
 *   (no standing house) and the food-poverty fixture each form nothing;
 * - formation determinism: ascending-eid pairing, digest-visible
 *   Household rows, Identity.familyId stamped on both partners;
 * - seeded daily birth rolls: newborns are CHILDREN (POP_ORIGIN_BIRTH)
 *   linked to both parents through the family row, food debited, home
 *   capacity respected, and the whole arc replays byte-identically.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readIdentity,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { readHousehold } from "../src/sim/components/household";
import { POP_ORIGIN_BIRTH } from "../src/sim/components/pop";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  computeWorldDigest,
  type World,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import {
  BIRTH_FOOD_COST,
  FOOD_SURPLUS_FOR_HOUSEHOLD,
  createHouseholdDiagnostics,
  createHouseholdsSystem,
} from "../src/sim/systems/households";
import {
  LIFE_STAGE_CHILD,
  lifeStageOf,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "../src/sim/systems/lifecycle";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

/** Compressed clock: 600-tick days. */
const CFG: LifecycleConfig = normalizeLifecycleConfig({
  dayTicks: 600,
  adultAgeDays: 1,
  elderAgeDays: 4,
  lifespanDays: 5,
});

interface Scenario {
  readonly world: World;
  readonly comps: SimComponents;
  readonly diagnostics: ReturnType<typeof createHouseholdDiagnostics>;
}

function scenario(
  seed: number,
  options: {
    readonly houses?: number;
    readonly school?: boolean;
    readonly food?: number;
  } = {},
): Scenario {
  const size = 24;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
  });
  const comps = defineSimComponents(world);
  const diagnostics = createHouseholdDiagnostics();
  registerSystem(world, createHouseholdsSystem(comps, CFG, diagnostics));

  createPlayerStockpile(world, comps, PLAYER_ONE, [
    options.food ?? 400,
    100,
    0,
    0,
    0,
    0,
    0,
  ]);
  for (let i = 0; i < (options.houses ?? 1); i++) {
    stampFinishedBuilding(world, comps, "house", 5 + i * 3, 5, {
      playerId: PLAYER_ONE,
    });
  }
  if (options.school === true) {
    stampFinishedBuilding(world, comps, "school", 14, 5, {
      playerId: PLAYER_ONE,
    });
  }
  return { world, comps, diagnostics };
}

function couple(scene: Scenario): { head: number; partner: number } {
  // Passable tiles clear of every stamped footprint (houses sit at
  // x=5..6 and x=8..9, school at x=14).
  const head = spawnUnit(scene.world, scene.comps, 6.5, 8.5, {
    identity: true,
  });
  const partner = spawnUnit(scene.world, scene.comps, 7.5, 9.5, {
    identity: true,
  });
  return { head, partner };
}

function stepToDayBoundary(scene: Scenario, day: number): void {
  while (scene.world.tick < day * CFG.dayTicks) step(scene.world);
}

function householdRows(
  scene: Scenario,
): { famEid: number; fields: NonNullable<ReturnType<typeof readHousehold>> }[] {
  const rows = scene.world.rowsByComponentId.get(scene.comps.householdId)!;
  return [...rows.keys()]
    .sort((a, b) => a - b)
    .map((famEid) => ({
      famEid,
      fields: readHousehold(scene.world, scene.comps, famEid)!,
    }));
}

function stockpileAmountOfFood(scene: Scenario): number {
  return stockpileAmountsOf(scene.world, scene.comps, PLAYER_ONE)[0]!;
}

// ---- Formation -----------------------------------------------------------------

describe("household formation", () => {
  it("pairs two fed adults once housing stands, stamping both Identities", () => {
    const scene = scenario(31, { houses: 1, food: 300 });
    const { head, partner } = couple(scene);

    stepToDayBoundary(scene, 1); // first daily pass

    const families = householdRows(scene);
    expect(families.length).toBe(1);
    const { famEid, fields } = families[0]!;
    expect(fields.playerId).toBe(PLAYER_ONE);
    expect(new Set([fields.headEid, fields.partnerEid])).toEqual(
      new Set([head, partner]),
    );
    expect(fields.birthCount).toBe(0);
    // Formed ON the day-1 boundary, so the first roll is day 2's.
    expect(fields.nextBirthRollTick).toBe(2 * CFG.dayTicks);
    expect(readIdentity(scene.world, scene.comps, head)!.familyId).toBe(famEid);
    expect(readIdentity(scene.world, scene.comps, partner)!.familyId).toBe(
      famEid,
    );
    expect(scene.diagnostics.familiesFormed).toBe(1);
  });

  it("housing shortage: no house standing means no family forms", () => {
    const scene = scenario(37, { houses: 0, food: 300 });
    couple(scene);
    stepToDayBoundary(scene, 3);
    expect(householdRows(scene)).toEqual([]);
    expect(scene.diagnostics.familiesFormed).toBe(0);
  });

  it("food poverty: below the surplus line no family forms either", () => {
    const scene = scenario(41, {
      houses: 1,
      food: FOOD_SURPLUS_FOR_HOUSEHOLD - 1,
    });
    couple(scene);
    stepToDayBoundary(scene, 3);
    expect(householdRows(scene)).toEqual([]);
  });

  it("children and elders never form new families", () => {
    const scene = scenario(43, { houses: 2, food: 600 });
    // Two natural-born children arrive MID-DAY after the day-1
    // boundary; even at the day-2 pass they are still under the adult
    // threshold (elapsed < one compressed day).
    stepToDayBoundary(scene, 1);
    for (let i = 0; i < CFG.dayTicks / 2; i++) step(scene.world);
    spawnUnit(scene.world, scene.comps, 6.5, 8.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    spawnUnit(scene.world, scene.comps, 7.5, 9.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    stepToDayBoundary(scene, 2);
    expect(householdRows(scene)).toEqual([]);
    expect(scene.diagnostics.familiesFormed).toBe(0);
  });
});

// ---- Births ---------------------------------------------------------------------

describe("seeded daily birth rolls", () => {
  it("births children into the family, debits food and respects beds", () => {
    const scene = scenario(20260826, { houses: 1, food: 600 });
    couple(scene);

    stepToDayBoundary(scene, 1); // formation consumes this pass
    expect(scene.diagnostics.birthsRolled).toBe(0);

    stepToDayBoundary(scene, 2); // first seeded roll
    const birthsAfterDay2 = scene.diagnostics.birthsRolled;
    expect(birthsAfterDay2).toBeGreaterThanOrEqual(1); // seed chosen to birth

    // Every newborn is a CHILD linked to the family that bore it.
    for (const eid of scene.world.entities) {
      const identity = readIdentity(scene.world, scene.comps, eid);
      if (!identity || identity.familyId === -1) continue;
      if (identity.origin !== POP_ORIGIN_BIRTH) continue;
      expect(lifeStageOf(scene.world, scene.comps, eid, CFG)).toBe(
        LIFE_STAGE_CHILD,
      );
      const fam = readHousehold(scene.world, scene.comps, identity.familyId)!;
      expect([fam.headEid, fam.partnerEid].includes(eid)).toBe(false);
    }

    // A second roll may add more; food tracks births exactly either way.
    stepToDayBoundary(scene, 3);
    const totalBirths = scene.diagnostics.birthsRolled;
    expect(totalBirths).toBeGreaterThanOrEqual(birthsAfterDay2);
    expect(600 - stockpileAmountOfFood(scene)).toBe(
      totalBirths * BIRTH_FOOD_COST,
    );
    // And nobody sleeps on the street: occupancy ≤ the house cap.
    for (const { fields } of householdRows(scene)) {
      expect(fields.birthCount + 2).toBeLessThanOrEqual(5); // house cap
    }
  });

  it("replays byte-identically under the same seed", () => {
    const run = (seed: number): string => {
      const scene = scenario(seed, { houses: 1, food: 600 });
      couple(scene);
      stepToDayBoundary(scene, 4);
      return computeWorldDigest(scene.world);
    };
    expect(run(20260826)).toBe(run(20260826));
  });
});
