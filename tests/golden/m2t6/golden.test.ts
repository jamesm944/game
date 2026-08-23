/**
 * M2-T6 golden harness — SPEC §2.5/§2.13 military slice / issue #40.
 *
 * One run exercises all three ticket features against pinned digests:
 *
 *   1. EQUIPMENT — equip commands consume Forge Weapons/Armor from the
 *      commodity ledger onto the militia (Equipment rows [1,1]); the
 *      debits close the ledger exactly.
 *   2. TRAINING — trainUnit drives the archery-range queue; the archer
 *      spawns as a full combatant (Combat row) on the trainTime
 *      boundary.
 *   3. ATTACK-MOVE — a formation march (leader path + ring slots via
 *      the shared group-route pipeline) acquires an idle scout-cavalry
 *      inside aggro radius EN ROUTE, pauses into Attack heads, kills,
 *      then RESUMES and delivers both units onto their slots.
 *
 * Milestone digests land every 30th tick plus final with a double-run
 * determinism canary. Eid layout is part of the fixture contract:
 * militia 1, scout 2, player ledgers 3–4, town center 5 (pop cap),
 * archery-range 6, trained archer 7.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimCommand } from "../../../src/sim/core/inbox";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
} from "../../../src/sim/core/world";
import {
  defineSimComponents,
  getCombatRow,
  getPosition,
  readActivityQueue,
  readTrainQueue,
  spawnCombatUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  COMBAT_EVENT_DEATH,
  combatDefOf,
  readCombatEvents,
} from "../../../src/sim/components/combat";
import { getEquipmentRow } from "../../../src/sim/components/equipment";
import { setPlayerAgeRank } from "../../../src/sim/components/age";
import {
  PLAYER_ONE,
  commodityAmountsOf,
  createCommodityStockpile,
  createPlayerStockpile,
  depositCommodityIntoStockpile,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import {
  createMovementSystem,
  formationSlotOffset,
} from "../../../src/sim/systems/movement";
import {
  createCombatDiagnostics,
  createCombatSystem,
  type CombatDiagnostics,
} from "../../../src/sim/systems/combat";
import {
  createEquipmentDiagnostics,
  createEquipmentSystem,
} from "../../../src/sim/systems/equipment";
import {
  createTrainingDiagnostics,
  createTrainingSystem,
} from "../../../src/sim/systems/training";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const COMMODITY_WEAPONS = 3;
const COMMODITY_ARMOR = 4;

interface GoldenSpawn {
  readonly eid: number;
  readonly defId: string;
  readonly playerId: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenStockpile {
  readonly playerId: number;
  readonly resources: readonly number[];
  readonly commodities?: Readonly<Record<string, number>> | undefined;
  readonly ageRank?: number | undefined;
}

interface GoldenBuilding {
  readonly defId: string;
  readonly tileX: number;
  readonly tileY: number;
  readonly playerId: number;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly spawns: readonly GoldenSpawn[];
  readonly stockpiles: readonly GoldenStockpile[];
  readonly buildings: readonly GoldenBuilding[];
  readonly commands: readonly SimCommand[];
}

function requiredNumber(value: unknown, where: string): number {
  if (typeof value !== "number") {
    throw new Error(`fixture ${where} must be a number`);
  }
  return value;
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture case.json must be an object");
  }
  const box = raw as Record<string, unknown>;
  if (!Array.isArray(box.spawns) || box.spawns.length === 0) {
    throw new Error("fixture case.json: spawns must be a non-empty array");
  }
  const spawns = box.spawns.map((entry): GoldenSpawn => {
    const spawn = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(spawn.eid, "spawn.eid"),
      defId: String(spawn.defId),
      playerId: requiredNumber(spawn.playerId, "spawn.playerId"),
      x: requiredNumber(spawn.x, "spawn.x"),
      y: requiredNumber(spawn.y, "spawn.y"),
    };
  });
  if (!Array.isArray(box.stockpiles)) {
    throw new Error("fixture case.json: stockpiles must be an array");
  }
  const stockpiles = box.stockpiles.map((entry): GoldenStockpile => {
    const stock = entry as Record<string, unknown>;
    const commodities = stock.commodities as Record<string, number> | undefined;
    return {
      playerId: requiredNumber(stock.playerId, "stockpile.playerId"),
      resources: stock.resources as number[],
      commodities,
      ageRank: typeof stock.ageRank === "number" ? stock.ageRank : undefined,
    };
  });
  if (!Array.isArray(box.buildings)) {
    throw new Error("fixture case.json: buildings must be an array");
  }
  const buildings = box.buildings.map((entry): GoldenBuilding => {
    const building = entry as Record<string, unknown>;
    return {
      defId: String(building.defId),
      tileX: requiredNumber(building.tileX, "building.tileX"),
      tileY: requiredNumber(building.tileY, "building.tileY"),
      playerId: requiredNumber(building.playerId, "building.playerId"),
    };
  });
  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: all M2-T6 commands require data");
    }
    return {
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
      data: command.data as Readonly<Record<string, unknown>>,
    };
  });
  return {
    name: String(box.name),
    seed: requiredNumber(box.seed, "seed"),
    size: requiredNumber(box.size, "size"),
    ticks: requiredNumber(box.ticks, "ticks"),
    milestoneEvery: requiredNumber(box.milestoneEvery, "milestoneEvery"),
    spawns,
    stockpiles,
    buildings,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly finalTick: number;
  /** Combat diagnostics straight from the system. */
  readonly combat: CombatDiagnostics;
  readonly equipmentCommands: number;
  readonly itemsEquipped: number;
  readonly unitsTrained: number;
  /** Trained-archer identity + position presence. */
  readonly archerEid: number;
  readonly archerDefId: string;
  /** Equipment rows: [eid, weapons, armor] for every equipped unit. */
  readonly equipmentRows: readonly (readonly [number, number, number])[];
  /** Final commodity amounts for player one. */
  readonly finalCommodities: readonly number[];
  /** Final resource amounts for player one. */
  readonly finalResources: readonly number[];
  /** Remaining queue depth on every finished building. */
  readonly queueDepths: readonly number[];
  /** Deaths recorded on player two's log: victim eids. */
  readonly p2Deaths: readonly number[];
  /** Dangling combat targets (must end empty). */
  readonly danglingTargets: readonly number[];
  /** Live Attack activities anywhere (must end zero). */
  readonly queuedAttackActivities: number;
  /** [eid, x, y] of the surviving player-one units at the end. */
  readonly finalPositions: readonly (readonly [number, number, number])[];
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: openFieldLayers(fixture.size),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  // Registration order mirrors production main.ts: movement first (the
  // route pipeline lands paths), then combat / training / equipment.
  registerSystem(world, createMovementSystem(comps, scheduler));
  const combatDiag = createCombatDiagnostics();
  registerSystem(world, createCombatSystem(comps, combatDiag, scheduler));
  const trainingDiag = createTrainingDiagnostics();
  registerSystem(world, createTrainingSystem(comps, trainingDiag));
  const equipmentDiag = createEquipmentDiagnostics();
  registerSystem(world, createEquipmentSystem(comps, equipmentDiag));

  // Eid contract: units 1..N, ledgers next, then stamped buildings; the
  // trained archer takes the first eid past those.
  let nextEid = 1;
  for (const spawn of fixture.spawns) {
    const eid = spawnCombatUnit(
      world,
      comps,
      spawn.defId,
      spawn.x,
      spawn.y,
      spawn.playerId,
    );
    if (eid !== spawn.eid || eid !== nextEid++) {
      throw new Error("fixture spawn order mismatch");
    }
  }
  for (const stock of fixture.stockpiles) {
    const eid = createPlayerStockpile(
      world,
      comps,
      stock.playerId,
      stock.resources,
    );
    if (eid !== nextEid++) throw new Error("fixture ledger eid mismatch");
    if (stock.commodities !== undefined) {
      createCommodityStockpile(world, comps, stock.playerId);
      for (const [slug, qty] of Object.entries(stock.commodities)) {
        const code = slug === "weapons" ? COMMODITY_WEAPONS : COMMODITY_ARMOR;
        for (let i = 0; i < qty; i++) {
          depositCommodityIntoStockpile(world, comps, stock.playerId, code, 1);
        }
      }
    }
    if (stock.ageRank !== undefined) {
      setPlayerAgeRank(world, comps, stock.playerId, stock.ageRank);
    }
  }
  const buildingEids: number[] = [];
  for (const building of fixture.buildings) {
    const eid = stampFinishedBuilding(
      world,
      comps,
      building.defId,
      building.tileX,
      building.tileY,
      { playerId: building.playerId },
    );
    if (eid !== nextEid++) throw new Error("fixture building eid mismatch");
    buildingEids.push(eid);
  }
  const archerEid = nextEid; // trained unit spawns right after setup

  for (const command of fixture.commands) world.inbox.submit(command);

  const digests: MilestoneDigest[] = [];
  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const equipmentRows: [number, number, number][] = [];
  const liveSet = new Set(world.entities);
  const danglingTargets: number[] = [];
  let queuedAttackActivities = 0;
  for (const eid of world.entities) {
    const equipment = getEquipmentRow(world, comps, eid);
    if (equipment) equipmentRows.push([eid, equipment[0]!, equipment[1]!]);
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow && combatRow[3] !== 0 && !liveSet.has(combatRow[3]!)) {
      danglingTargets.push(eid);
    }
    for (const activity of readActivityQueue(world, comps, eid)) {
      if (activity.kind === "attack") queuedAttackActivities += 1;
    }
  }

  // Deaths live on the VICTIM owner's log: player two lost the scout.
  const p2Deaths = readCombatEvents(world, comps, 1)
    .filter((event) => event.kind === COMBAT_EVENT_DEATH)
    .map((event) => event.victimEid);

  const finalPositions: [number, number, number][] = [];
  const scriptedSurvivors = fixture.spawns.filter(
    (spawn) => spawn.playerId === PLAYER_ONE && liveSet.has(spawn.eid),
  );
  for (const spawn of scriptedSurvivors) {
    const pos = getPosition(world, comps, spawn.eid);
    finalPositions.push([spawn.eid, pos.x, pos.y]);
  }
  if (liveSet.has(archerEid)) {
    const pos = getPosition(world, comps, archerEid);
    finalPositions.push([archerEid, pos.x, pos.y]);
  }

  const queueDepths = buildingEids.map(
    (eid) => readTrainQueue(world, comps, eid).length,
  );

  return {
    digests,
    finalTick: world.tick,
    combat: combatDiag,
    equipmentCommands: equipmentDiag.commandsApplied,
    itemsEquipped: equipmentDiag.itemsEquipped,
    unitsTrained: trainingDiag.unitsTrained,
    archerEid,
    archerDefId: combatDefOf(world, comps, archerEid)?.id ?? "missing",
    equipmentRows,
    finalCommodities: commodityAmountsOf(world, comps, PLAYER_ONE),
    finalResources: stockpileAmountsOf(world, comps, PLAYER_ONE),
    queueDepths,
    p2Deaths,
    danglingTargets,
    queuedAttackActivities,
    finalPositions,
  };
}

installSimPurityShims();

describe("golden harness m2t6", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1)! !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("closes the equipment, training and combat ledgers exactly", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);

    // Equipment: two commands consumed one weapon + one armor onto the
    // militia…
    expect(run.equipmentCommands).toBe(2);
    expect(run.itemsEquipped).toBe(2);
    expect(run.equipmentRows).toEqual([
      [1, 1, 1], // the militia marches with full Forge gear
    ]);
    // …and the ledger closed: seeded 2 weapons / 1 armor minus equips.
    expect(run.finalCommodities[COMMODITY_WEAPONS]).toBe(1);
    expect(run.finalCommodities[COMMODITY_ARMOR]).toBe(0);
    // Archer costs escrowed at enqueue: wood 25, gold 45.
    expect(run.finalResources[1]).toBe(200 - 25);
    expect(run.finalResources[2]).toBe(200 - 45);

    // Training: exactly one archer through the range queue, now empty
    // (both finished buildings report zero-depth queues).
    expect(run.unitsTrained).toBe(1);
    expect(run.archerDefId).toBe("archer");
    expect(run.queueDepths).toEqual([0, 0]);

    // Attack-move: acquired en route, fought, killed, resumed.
    expect(run.combat.attackMoveCommands).toBe(1);
    expect(run.combat.kills).toBe(1);
    expect(run.combat.retaliations).toBe(1);
    expect(run.p2Deaths).toEqual([2]);
    expect(run.combat.aggroAcquisitions).toBeGreaterThanOrEqual(1);
    expect(run.combat.aggroAcquisitions).toBeLessThanOrEqual(2);
    expect(run.danglingTargets).toEqual([]);
    expect(run.queuedAttackActivities).toBe(0);
  });

  it("delivers both marchers onto their formation slots", () => {
    const run = runScenario(fixture);

    const positions = new Map<number, readonly [number, number]>(
      run.finalPositions.map(
        ([eid, x, y]): [number, readonly [number, number]] => [eid, [x, y]],
      ),
    );
    // Arrival tolerance mirrors the movement layer's waypoint reach.
    const TOLERANCE = 0.35;
    // Militia leads slot 0: the commanded destination.
    const militia = positions.get(1)!;
    expect(Math.abs(militia[0] - 20.5)).toBeLessThan(TOLERANCE);
    expect(Math.abs(militia[1] - 11.5)).toBeLessThan(TOLERANCE);
    // The trained archer takes ring slot 1 around that destination.
    const archer = positions.get(run.archerEid)!;
    const offset = formationSlotOffset(1);
    expect(Math.abs(archer[0] - (20.5 + offset.dx))).toBeLessThan(TOLERANCE);
    expect(Math.abs(archer[1] - (11.5 + offset.dy))).toBeLessThan(TOLERANCE);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(60);
  });
});
