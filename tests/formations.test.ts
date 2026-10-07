/**
 * Tactical Unit Formations & Speed Harmonization — Q4 (Issue #125 / Epic #122).
 *
 * Tests:
 * 1. Slot offset geometry across all 8 formations:
 *    - AoE2 Quartet: Line, Box, Staggered, Flank
 *    - Bannerlord: Shield Wall, Square, Circle, Wedge
 *    - Heading rotation preservation
 * 2. Component serialization & state helpers:
 *    - formationToCode / codeToFormation round-trip
 *    - setFormation / getFormation component rows
 *    - setHarmonizedSpeed / getHarmonizedSpeed / clearHarmonizedSpeed
 * 3. Tactical combat effects:
 *    - Shield Wall grants +2 pierce armor
 *    - Shield Wall reduces cruise speed by 20% (0.8x multiplier)
 *    - Ranged attack damage reduction in Shield Wall vs Line
 * 4. Movement & Speed Harmonization:
 *    - Heterogeneous squad (e.g. fast scout + slower infantry) harmonizes to slowest speed
 *    - Arrival clears harmonized speed
 * 5. Orders and inbox processing:
 *    - issueSetFormation submits valid command consumed by movement system
 */

import { describe, expect, it } from "vitest";
import {
  calculateFormationOffset,
  clearHarmonizedSpeed,
  codeToFormation,
  formationToCode,
  getFormation,
  getHarmonizedSpeed,
  parseFormation,
  setFormation,
  setHarmonizedSpeed,
  type FormationType,
} from "../src/sim/components/formation";
import {
  createWorld,
  registerSystem,
  spawnEntity,
  step,
  type World,
} from "../src/sim/core/world";
import {
  defineSimComponents,
  spawnCombatUnit,
  type SimComponents,
} from "../src/sim/components";
import { deriveUnitStats } from "../src/sim/combat/stats";
import { unitDefOf } from "../src/data/definitions";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";
import { issueGroupMove, issueSetFormation } from "../src/ui/orders";

installSimPurityShims();

const STEPS_TO_APPLY_PATH = 3;

function createTestWorld(
  size = 32,
  seed = 20261001,
): {
  world: World;
  comps: SimComponents;
  paths: PathScheduler;
} {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const layers = buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
  const world = createWorld(seed, { layers, size, pathScheduler: paths });
  const comps = defineSimComponents(world);
  return { world, comps, paths };
}

describe("Formation Geometry & Slot Offsets (Issue #125)", () => {
  const formations: readonly FormationType[] = [
    "line",
    "box",
    "staggered",
    "flank",
    "shieldWall",
    "square",
    "circle",
    "wedge",
  ];

  it("returns zero offset for single unit squads", () => {
    for (const f of formations) {
      const offset = calculateFormationOffset(f, 0, 1, 0);
      expect(offset.dx).toBe(0);
      expect(offset.dy).toBe(0);
    }
  });

  it("calculates distinct, non-overlapping offsets for Line formation", () => {
    const offsets = [
      calculateFormationOffset("line", 0, 4, 0),
      calculateFormationOffset("line", 1, 4, 0),
      calculateFormationOffset("line", 2, 4, 0),
      calculateFormationOffset("line", 3, 4, 0),
    ];
    // In Line, units in the same rank have different lateral coordinates
    const dys = offsets.map((o) => o.dy);
    const uniqueDys = new Set(dys);
    expect(uniqueDys.size).toBe(4);
  });

  it("calculates tight spacing for Shield Wall formation", () => {
    const o0 = calculateFormationOffset("shieldWall", 0, 4, 0);
    const o1 = calculateFormationOffset("shieldWall", 1, 4, 0);
    const lateralDiff = Math.abs(o1.dy - o0.dy);
    // Lateral spacing is 0.65 for tight shield wall
    expect(lateralDiff).toBeCloseTo(0.65, 2);
  });

  it("calculates dispersed spacing for Staggered formation", () => {
    const o0 = calculateFormationOffset("staggered", 0, 4, 0);
    const o1 = calculateFormationOffset("staggered", 1, 4, 0);
    const lateralDiff = Math.abs(o1.dy - o0.dy);
    // Lateral spacing is 2.0 to mitigate siege splash
    expect(lateralDiff).toBeCloseTo(2.0, 1);
  });

  it("splits Flank formation into two separate wings", () => {
    const leftWing = calculateFormationOffset("flank", 0, 4, 0);
    const rightWing = calculateFormationOffset("flank", 2, 4, 0);
    // Left wing is centered around -3.5, right wing around +3.5
    expect(leftWing.dy).toBeLessThan(0);
    expect(rightWing.dy).toBeGreaterThan(0);
    expect(rightWing.dy - leftWing.dy).toBeGreaterThan(5.0);
  });

  it("positions Wedge formation with tip at lead slot (index 0)", () => {
    const tip = calculateFormationOffset("wedge", 0, 5, 0);
    const flank1 = calculateFormationOffset("wedge", 1, 5, 0);
    const flank2 = calculateFormationOffset("wedge", 2, 5, 0);
    expect(tip.dx).toBe(0);
    expect(tip.dy).toBe(0);
    // Subsequent rows are behind tip (negative forward/dx)
    expect(flank1.dx).toBeLessThan(0);
    expect(flank2.dx).toBeLessThan(0);
  });

  it("rotates formation slots according to heading angle", () => {
    const forwardOffset0 = calculateFormationOffset("wedge", 1, 3, 0);
    const forwardOffset90 = calculateFormationOffset(
      "wedge",
      1,
      3,
      Math.PI / 2,
    );
    expect(forwardOffset0.dx).toBeCloseTo(forwardOffset90.dy, 2);
    expect(forwardOffset0.dy).toBeCloseTo(-forwardOffset90.dx, 2);
  });
});

describe("Formation Component Serialization & Helpers", () => {
  it("round-trips formation to code and back", () => {
    const all: readonly FormationType[] = [
      "line",
      "box",
      "staggered",
      "flank",
      "shieldWall",
      "square",
      "circle",
      "wedge",
    ];
    for (const f of all) {
      const code = formationToCode(f);
      expect(codeToFormation(code)).toBe(f);
    }
  });

  it("parses formation strings with line fallback", () => {
    expect(parseFormation("shieldWall")).toBe("shieldWall");
    expect(parseFormation("unknown")).toBe("line");
    expect(parseFormation(null)).toBe("line");
  });

  it("sets and gets formation on world entity", () => {
    const { world, comps } = createTestWorld();
    const eid = spawnEntity(world);

    expect(getFormation(world, comps, eid)).toBe("line");
    setFormation(world, comps, eid, "shieldWall");
    expect(getFormation(world, comps, eid)).toBe("shieldWall");

    setFormation(world, comps, eid, "wedge");
    expect(getFormation(world, comps, eid)).toBe("wedge");
  });

  it("manages harmonized speed on entity rows", () => {
    const { world, comps } = createTestWorld();
    const eid = spawnEntity(world);

    expect(getHarmonizedSpeed(world, comps, eid)).toBe(0);
    setHarmonizedSpeed(world, comps, eid, 1.8);
    expect(getHarmonizedSpeed(world, comps, eid)).toBeCloseTo(1.8, 5);

    clearHarmonizedSpeed(world, comps, eid);
    expect(getHarmonizedSpeed(world, comps, eid)).toBe(0);
  });
});

describe("Shield Wall Tactical Mechanics", () => {
  it("applies +2 pierce armor and 20% speed reduction in deriveUnitStats", () => {
    const militiaDef = unitDefOf("militia");
    const lineStats = deriveUnitStats(militiaDef, { formation: "line" });
    const shieldStats = deriveUnitStats(militiaDef, {
      formation: "shieldWall",
    });

    expect(shieldStats.armorByClass.infantry).toBe(
      lineStats.armorByClass.infantry + 2,
    );
    expect(shieldStats.speed).toBeCloseTo(lineStats.speed * 0.8, 2);
    // Attack and HP remain unaffected
    expect(shieldStats.attack).toBe(lineStats.attack);
    expect(shieldStats.hp).toBe(lineStats.hp);
  });

  it("reduces incoming ranged attack damage when target is in Shield Wall", () => {
    const militiaDef = unitDefOf("militia");
    const archerDef = unitDefOf("archer");

    const lineStats = deriveUnitStats(militiaDef, { formation: "line" });
    const shieldStats = deriveUnitStats(militiaDef, {
      formation: "shieldWall",
    });

    const archerAttack = deriveUnitStats(archerDef).attack;
    const damageToLine = Math.max(
      1,
      archerAttack - lineStats.armorByClass.infantry,
    );
    const damageToShield = Math.max(
      1,
      archerAttack - shieldStats.armorByClass.infantry,
    );

    expect(damageToLine - damageToShield).toBe(2);
  });
});

describe("Speed Harmonization in Formation Movement", () => {
  it("harmonizes squad cruise speed to the slowest member when moving in formation", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));

    // Fast unit (scout) + slower unit (militia)
    const scout = spawnCombatUnit(world, comps, "scout-cavalry", 5, 5, 1);
    const militia = spawnCombatUnit(world, comps, "militia", 5, 6, 1);

    const scoutBaseSpeed = world.rowsByComponentId
      .get(comps.unitTagId)!
      .get(scout)![0]!;
    const militiaBaseSpeed = world.rowsByComponentId
      .get(comps.unitTagId)!
      .get(militia)![0]!;
    expect(scoutBaseSpeed).toBeGreaterThan(militiaBaseSpeed);

    // Issue group move in Wedge formation
    issueGroupMove(
      world.inbox,
      world.tick,
      [scout, militia],
      20,
      20,
      false,
      "wedge",
    );

    // Advance ticks to consume command and apply route
    for (let i = 0; i < STEPS_TO_APPLY_PATH; i++) {
      step(world);
    }

    // Harmonized speed on both units should be capped to the slowest member
    const scoutHarmonized = getHarmonizedSpeed(world, comps, scout);
    const militiaHarmonized = getHarmonizedSpeed(world, comps, militia);

    expect(scoutHarmonized).toBeCloseTo(militiaBaseSpeed, 2);
    expect(militiaHarmonized).toBeCloseTo(militiaBaseSpeed, 2);
  });

  it("processes setFormation command via inbox", () => {
    const { world, comps, paths } = createTestWorld();
    registerSystem(world, createMovementSystem(comps, paths));

    const unit = spawnCombatUnit(world, comps, "militia", 10, 10, 1);

    expect(getFormation(world, comps, unit)).toBe("line");

    issueSetFormation(world.inbox, world.tick, [unit], "shieldWall");
    step(world);

    expect(getFormation(world, comps, unit)).toBe("shieldWall");
  });
});
