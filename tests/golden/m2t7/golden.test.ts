/**
 * M2-T7 golden harness — SPEC §2.5/§2.6/§2.11 building damage &
 * destruction / issue #41.
 *
 * One raid exercises the whole destruction pipeline against pinned
 * digests: a player-0 militia draws ten Forge weapons from the commodity
 * ledger, then razes player 1's pre-damaged lumber camp — the villagers'
 * only NEAR wood drop-off — with a single 24-damage blow at tick 306,
 * exactly while all three wood-gathering villagers walk their first
 * delivery legs toward it. A far second camp (eid 9) keeps the economy
 * alive as the reroute target. Pinned outcomes:
 *
 *   - EQUIPMENT — ten equip commands drain weapons to zero; derived
 *     attack hits 24 (4 base + 10×2), visible in the strike amount.
 *   - DESTRUCTION — the camp dies mid-economy on a deterministic tick:
 *     DEATH event on the owner log, rubble-state entity over the exact
 *     footprint, footprint tiles PASSABLE again, one passabilityVersion
 *     bump, attacker disengaged with no dangling targets.
 *   - REROUTE — all three carriers targeting the dead drop-off abort
 *     once each and replan onto the far surviving camp (nothing is
 *     credited or lost; the wood ledger closes extracted == deposited
 *     + carried == node depletion through run end).
 *   - CONQUEST — the §2.11 counter reads exactly one live military
 *     production building for player 1 (barracks) before AND after the
 *     raid: economic razes never move it.
 *
 * Milestone digests land every 30th tick plus final with a double-run
 * determinism canary. Eid layout is part of the fixture contract:
 * militia 1, villagers 2–4, ledgers 5–6, node 7, lumber-camp 8,
 * town-center 9, barracks 10, rubble 11.
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
  getInventory,
  getResourceNodeRow,
  readActivityQueue,
  spawnCombatUnit,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  getBuildingRow,
  getRubbleRow,
} from "../../../src/sim/components/buildings";
import {
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_DEATH,
  readCombatEvents,
} from "../../../src/sim/components/combat";
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
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
  type GatherDiagnostics,
} from "../../../src/sim/systems/gather";
import {
  createCombatDiagnostics,
  createCombatSystem,
  type CombatDiagnostics,
} from "../../../src/sim/systems/combat";
import {
  createEquipmentDiagnostics,
  createEquipmentSystem,
} from "../../../src/sim/systems/equipment";
import { militaryProductionBuildingsOf } from "../../../src/sim/systems/conquest";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

const RESOURCE_WOOD = 1;
const COMMODITY_WEAPONS = 3;

interface GoldenVillager {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenNode {
  readonly eid: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly resource: string;
  readonly amount: number;
}

interface GoldenBuilding {
  readonly eid: number;
  readonly defId: string;
  readonly tileX: number;
  readonly tileY: number;
  readonly playerId: number;
  /** Stamped battle damage (scenario-editor power for fixtures). */
  readonly hp?: number | undefined;
}

interface GoldenStockpile {
  readonly playerId: number;
  readonly resources: readonly number[];
  readonly commodities?: Readonly<Record<string, number>> | undefined;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly raider: GoldenVillager;
  readonly villagers: readonly GoldenVillager[];
  readonly nodes: readonly GoldenNode[];
  readonly buildings: readonly GoldenBuilding[];
  readonly stockpiles: readonly GoldenStockpile[];
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
  const raiderBox = box.raider as Record<string, unknown>;
  const raider: GoldenVillager = {
    eid: requiredNumber(raiderBox.eid, "raider.eid"),
    x: requiredNumber(raiderBox.x, "raider.x"),
    y: requiredNumber(raiderBox.y, "raider.y"),
  };
  if (!Array.isArray(box.villagers) || box.villagers.length === 0) {
    throw new Error("fixture case.json: villagers must be non-empty");
  }
  const villagers = box.villagers.map((entry): GoldenVillager => {
    const villager = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(villager.eid, "villager.eid"),
      x: requiredNumber(villager.x, "villager.x"),
      y: requiredNumber(villager.y, "villager.y"),
    };
  });
  if (!Array.isArray(box.nodes) || box.nodes.length === 0) {
    throw new Error("fixture case.json: nodes must be non-empty");
  }
  const nodes = box.nodes.map((entry): GoldenNode => {
    const node = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(node.eid, "node.eid"),
      tileX: requiredNumber(node.tileX, "node.tileX"),
      tileY: requiredNumber(node.tileY, "node.tileY"),
      resource: String(node.resource),
      amount: requiredNumber(node.amount, "node.amount"),
    };
  });
  if (!Array.isArray(box.buildings) || box.buildings.length === 0) {
    throw new Error("fixture case.json: buildings must be non-empty");
  }
  const buildings = box.buildings.map((entry): GoldenBuilding => {
    const building = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(building.eid, "building.eid"),
      defId: String(building.defId),
      tileX: requiredNumber(building.tileX, "building.tileX"),
      tileY: requiredNumber(building.tileY, "building.tileY"),
      playerId: requiredNumber(building.playerId, "building.playerId"),
      hp: typeof building.hp === "number" ? building.hp : undefined,
    };
  });
  if (!Array.isArray(box.stockpiles)) {
    throw new Error("fixture case.json: stockpiles must be an array");
  }
  const stockpiles = box.stockpiles.map((entry): GoldenStockpile => {
    const stock = entry as Record<string, unknown>;
    return {
      playerId: requiredNumber(stock.playerId, "stockpile.playerId"),
      resources: stock.resources as number[],
      commodities: stock.commodities as Record<string, number> | undefined,
    };
  });
  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: all commands require data");
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
    raider,
    villagers,
    nodes,
    buildings,
    stockpiles,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

/** Plain-comparable final state so canaries deep-equal trivially. */
interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly finalTick: number;
  /** Tick the camp's Building row vanished (pinned raze moment). */
  readonly destroyTick: number;
  readonly combat: CombatDiagnostics;
  readonly itemsEquipped: number;
  /** Deaths recorded on player 1's victim log. */
  readonly p1DeathVictims: readonly number[];
  /** Damage events logged against the razed camp. */
  readonly p1CampDamageEvents: number;
  /** Rubble row over the dead camp: [originX, originY, width, height]. */
  readonly campRubble: readonly number[] | undefined;
  readonly campTilesPassable: boolean;
  /** passabilityVersion after setup and at end of run. */
  readonly setupPassabilityVersion: number;
  readonly finalPassabilityVersion: number;
  /** Live military-production counts before the raid / at end of run. */
  readonly p0MilitaryStart: readonly number[];
  readonly p1MilitaryStart: readonly number[];
  readonly p0Military: readonly number[];
  readonly p1Military: readonly number[];
  /** Wood ledger closure inputs. */
  readonly extractedWood: number;
  readonly depositedWood: number;
  readonly carriedWood: number;
  /** Remaining units in the wood node at end of run. */
  readonly nodeRemaining: number;
  readonly destroyedDropoffReroutes: number;
  readonly blockedCarryTicks: number;
  readonly finalResourcesP0: readonly number[];
  readonly finalCommoditiesP0: readonly number[];
  readonly equipmentRows: readonly (readonly [number, number, number])[];
  /** Dangling combat targets (must end empty). */
  readonly danglingTargets: readonly number[];
  /** Live Attack activities anywhere (must end zero after the raze). */
  readonly queuedAttackActivities: number;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

const RESOURCE_CODES: Record<string, number> = {
  food: 0,
  wood: 1,
  gold: 2,
  stone: 3,
  iron: 4,
  coal: 5,
  clay: 6,
};

function runScenario(fixture: GoldenCase): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: openFieldLayers(fixture.size),
    pathScheduler: scheduler,
  });
  const comps: SimComponents = defineSimComponents(world);
  // Registration order mirrors production main.ts: movement first (the
  // route pipeline lands paths), then gather / combat / equipment.
  registerSystem(world, createMovementSystem(comps, scheduler));
  const gatherDiag: GatherDiagnostics = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, gatherDiag));
  const combatDiag = createCombatDiagnostics();
  registerSystem(world, createCombatSystem(comps, combatDiag, scheduler));
  const equipmentDiag = createEquipmentDiagnostics();
  registerSystem(world, createEquipmentSystem(comps, equipmentDiag));

  // Eid contract: raider 1, villagers 2–4, ledgers 5–6, node 7,
  // stamped buildings 8–10; the rubble entity spawns later as 11.
  let nextEid = 1;
  const raider = spawnCombatUnit(
    world,
    comps,
    "militia",
    fixture.raider.x,
    fixture.raider.y,
    PLAYER_ONE,
  );
  if (raider !== fixture.raider.eid || raider !== nextEid++) {
    throw new Error("fixture raider eid mismatch");
  }
  for (const villager of fixture.villagers) {
    const eid = spawnUnit(world, comps, villager.x, villager.y);
    if (eid !== villager.eid || eid !== nextEid++) {
      throw new Error("fixture villager eid mismatch");
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
        const code = slug === "weapons" ? COMMODITY_WEAPONS : 4;
        for (let i = 0; i < qty; i++) {
          depositCommodityIntoStockpile(world, comps, stock.playerId, code, 1);
        }
      }
    }
  }
  const nodeIds: number[] = [];
  for (const node of fixture.nodes) {
    const eid = spawnResourceNode(
      world,
      comps,
      node.tileX,
      node.tileY,
      RESOURCE_CODES[node.resource]!,
      node.amount,
    );
    if (eid !== node.eid || eid !== nextEid++) {
      throw new Error("fixture node eid mismatch");
    }
    nodeIds.push(eid);
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
    if (eid !== building.eid || eid !== nextEid++) {
      throw new Error("fixture building eid mismatch");
    }
    if (building.hp !== undefined) {
      (getBuildingRow(world, comps, eid) as number[])[4] = building.hp;
    }
    buildingEids.push(eid);
  }

  for (const command of fixture.commands) world.inbox.submit(command);

  const setupPassabilityVersion = scheduler.passabilityVersion;
  const campEid = buildingEids[0]!;
  const p1MilitaryStart = militaryProductionBuildingsOf(world, comps, 1);
  const p0MilitaryStart = militaryProductionBuildingsOf(
    world,
    comps,
    PLAYER_ONE,
  );
  // The rubble entity takes the first eid past the setup spawns.
  const expectedRubbleEid = world.lastAllocatedEid + 1;

  const digests: MilestoneDigest[] = [];
  let destroyTick = -1;
  while (world.tick < fixture.ticks) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue; // held boundary: no double record
    const tick = world.tick;
    if (
      destroyTick < 0 &&
      getBuildingRow(world, comps, campEid) === undefined
    ) {
      destroyTick = tick;
    }
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const liveSet = new Set(world.entities);
  const danglingTargets: number[] = [];
  let queuedAttackActivities = 0;
  for (const eid of world.entities) {
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow && combatRow[3] !== 0 && !liveSet.has(combatRow[3]!)) {
      danglingTargets.push(eid);
    }
    for (const activity of readActivityQueue(world, comps, eid)) {
      if (activity.kind === "attack") queuedAttackActivities += 1;
    }
  }

  const p1DeathVictims = readCombatEvents(world, comps, 1)
    .filter((event) => event.kind === COMBAT_EVENT_DEATH)
    .map((event) => event.victimEid);
  const p1CampDamageEvents = readCombatEvents(world, comps, 1).filter(
    (event) =>
      event.kind === COMBAT_EVENT_DAMAGE && event.victimEid === campEid,
  ).length;

  const campDef = fixture.buildings[0]!;
  const passability = world.layers.derivedPassability;
  const size = world.layers.size;
  let campTilesPassable = true;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (passability[(campDef.tileY + dy) * size + campDef.tileX + dx] !== 1) {
        campTilesPassable = false;
      }
    }
  }

  let carriedWood = 0;
  for (const villager of fixture.villagers) {
    carriedWood += getInventory(world, comps, villager.eid)?.amount ?? 0;
  }

  const equipmentRows: [number, number, number][] = [];
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.equipmentId)?.get(eid);
    if (row) equipmentRows.push([eid, row[0]!, row[1]!]);
  }

  return {
    digests,
    finalTick: world.tick,
    destroyTick,
    combat: combatDiag,
    itemsEquipped: equipmentDiag.itemsEquipped,
    p1DeathVictims,
    p1CampDamageEvents,
    campRubble: getRubbleRow(world, comps, expectedRubbleEid)?.slice(),
    campTilesPassable,
    setupPassabilityVersion,
    finalPassabilityVersion: scheduler.passabilityVersion,
    p0MilitaryStart,
    p1MilitaryStart,
    p0Military: militaryProductionBuildingsOf(world, comps, PLAYER_ONE),
    p1Military: militaryProductionBuildingsOf(world, comps, 1),
    extractedWood: gatherDiag.extractedByResource[RESOURCE_WOOD]!,
    depositedWood: gatherDiag.depositedByResource[RESOURCE_WOOD]!,
    carriedWood,
    nodeRemaining: getResourceNodeRow(world, comps, nodeIds[0]!)![1]!,
    destroyedDropoffReroutes: gatherDiag.destroyedDropoffReroutes,
    blockedCarryTicks: gatherDiag.blockedCarryTicks,
    finalResourcesP0: [...stockpileAmountsOf(world, comps, PLAYER_ONE)],
    finalCommoditiesP0: [...commodityAmountsOf(world, comps, PLAYER_ONE)],
    equipmentRows,
    danglingTargets,
    queuedAttackActivities,
  };
}

installSimPurityShims();

describe("golden harness m2t7", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("razes the camp through the full destruction pipeline", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);

    // Equipment: ten weapons drained onto the raider (attack 24).
    expect(run.itemsEquipped).toBe(10);
    expect(run.equipmentRows).toEqual([[1, 10, 0]]);
    expect(run.finalCommoditiesP0[COMMODITY_WEAPONS]).toBe(0);

    // Destruction: one strike at tick 300 — the raid lands inside every
    // carrier's first delivery leg (they depart t≈300), so the reroute
    // path is exercised deterministically below.
    expect(run.combat.attackCommands).toBe(1);
    expect(run.combat.buildingsDestroyed).toBe(1);
    expect(run.combat.kills).toBe(0);
    expect(run.p1DeathVictims).toEqual([8]);
    expect(run.p1CampDamageEvents).toBe(1);
    // Rubble state entity over the exact footprint on a fresh id…
    expect(run.campRubble).toEqual([24, 18, 2, 2]);
    // …tiles freed, exactly one version bump beyond setup, and the
    // attacker disengaged with no dangling references anywhere.
    expect(run.campTilesPassable).toBe(true);
    expect(run.finalPassabilityVersion).toBe(run.setupPassabilityVersion + 1);
    expect(run.danglingTargets).toEqual([]);
    expect(run.queuedAttackActivities).toBe(0);
  });

  it("reroutes gatherers and keeps the wood ledger closed", () => {
    const run = runScenario(fixture);

    // Two carriers were mid-delivery toward the camp when it died
    // (each aborts exactly once); the third filled up after the raze
    // and planned straight onto the survivor.
    expect(run.destroyedDropoffReroutes).toBe(2);
    expect(run.blockedCarryTicks).toBe(0);
    // The wood ledger closes across the raze: extracted == deposited +
    // carried == node depletion. Nothing vanished, deposits continued
    // through the surviving drop-off for the rest of the run.
    expect(run.extractedWood).toBe(run.depositedWood + run.carriedWood);
    expect(4000 - run.nodeRemaining).toBe(run.extractedWood);
    expect(run.depositedWood).toBeGreaterThanOrEqual(30);
  });

  it("counts conquest capacity independently of economic razes", () => {
    const run = runScenario(fixture);

    // Player 0 owns no military production; player 1's barracks stands
    // untouched by an economic-building raid — before and after — so
    // the §2.11 conquest metric never moved.
    expect(run.p0MilitaryStart).toEqual([]);
    expect(run.p1MilitaryStart).toEqual([10]);
    expect(run.p0Military).toEqual([]);
    expect(run.p1Military).toEqual([10]);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(60);
  });
});
