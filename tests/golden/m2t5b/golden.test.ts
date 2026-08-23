/**
 * M2-T5 golden harness B — SPEC §2.5 death cleanup / issue #39.
 *
 * Three villagers gather wood while a commanded militia kills the
 * middle one. The fixture pins the death-cleanup contract: the corpse
 * loses EVERY component row (its AssignedNode work-slot claim dies with
 * it — no orphan claims), the killer's engagement purges to a clean
 * idle, and the surviving gatherers keep their exclusive slots and run
 * unattended deposit cycles through the end of the run. The victim's
 * retaliation pauses (never cancels) its chop; milestone digests land
 * every 30th tick plus final with a double-run determinism canary.
 *
 * Eid layout is part of the fixture contract: villagers 1–3 (player
 * 0), wood node 4, player-0 ledger 5, drop-off 6, player-1 ledger 7,
 * raider militia 8. Commands reference those ids.
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
  getPosition,
  getResourceNodeRow,
  readActivityQueue,
  spawnCombatUnit,
  spawnResourceNode,
  type SimComponents,
} from "../../../src/sim/components";
import { getAssignedNode } from "../../../src/sim/components/economy";
import {
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_DEATH,
  readCombatEvents,
} from "../../../src/sim/components/combat";
import {
  PLAYER_ONE,
  createDropOffPoint,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../../../src/sim/core/stockpile";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createCombatDiagnostics,
  createCombatSystem,
} from "../../../src/sim/systems/combat";

const RESOURCE_WOOD = 1;

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly spawns: readonly { eid: number; x: number; y: number }[];
  readonly node: { tileX: number; tileY: number; amount: number };
  readonly dropOff: { x: number; y: number };
  readonly raider: { eid: number; x: number; y: number };
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
  const spawns = box.spawns.map((entry) => ({
    eid: requiredNumber(entry.eid, "spawn.eid"),
    x: requiredNumber(entry.x, "spawn.x"),
    y: requiredNumber(entry.y, "spawn.y"),
  }));
  const nodeBox = box.node as Record<string, unknown>;
  const dropBox = box.dropOff as Record<string, unknown>;
  const raiderBox = box.raider as Record<string, unknown>;
  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: all M2-T5 commands require data");
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
    node: {
      tileX: requiredNumber(nodeBox.tileX, "node.tileX"),
      tileY: requiredNumber(nodeBox.tileY, "node.tileY"),
      amount: requiredNumber(nodeBox.amount, "node.amount"),
    },
    dropOff: {
      x: requiredNumber(dropBox.x, "dropOff.x"),
      y: requiredNumber(dropBox.y, "dropOff.y"),
    },
    raider: {
      eid: requiredNumber(raiderBox.eid, "raider.eid"),
      x: requiredNumber(raiderBox.x, "raider.x"),
      y: requiredNumber(raiderBox.y, "raider.y"),
    },
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
  /** [eid, x, y] ascending over survivors. */
  readonly survivorPositions: readonly (readonly [number, number, number])[];
  /** AssignedNode claims: [workerEid, nodeEid, slotIndex]. */
  readonly slotClaims: readonly (readonly [number, number, number])[];
  readonly nodeRemaining: number;
  readonly depositedWood: number;
  readonly extractedWood: number;
  readonly carriedWood: number;
  /** Total Attack activities queued anywhere (must end zero). */
  readonly queuedAttackActivities: number;
  /** Combat rows targeting dead/missing entities. */
  readonly danglingTargets: readonly number[];
  /** True when NO component row map holds the victim's eid. */
  readonly victimFullyDespawned: boolean;
  readonly victimDeathEvents: readonly number[];
  readonly p1DamageTakenEvents: number;
  readonly kills: number;
  readonly strikes: number;
  readonly retaliations: number;
  readonly attackCommandsApplied: number;
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
  // Registration order: movement → gather → combat. Later systems must
  // see earlier ones' settled rows for the tick.
  registerSystem(world, createMovementSystem(comps, scheduler));
  const gatherDiagnostics = createGatherDiagnostics();
  registerSystem(
    world,
    createGatherSystem(comps, scheduler, gatherDiagnostics),
  );
  const diagnostics = createCombatDiagnostics();
  registerSystem(world, createCombatSystem(comps, diagnostics));

  // Eid contract: villagers 1–3 first, then node 4, player-0 ledger 5,
  // drop-off 6, player-1 ledger 7, raider 8.
  let nextEid = 1;
  for (const spawn of fixture.spawns) {
    const eid = spawnCombatUnit(
      world,
      comps,
      "villager",
      spawn.x,
      spawn.y,
      PLAYER_ONE,
    );
    if (eid !== spawn.eid || eid !== nextEid++) {
      throw new Error("fixture villager spawn order mismatch");
    }
  }
  const nodeEid = spawnResourceNode(
    world,
    comps,
    fixture.node.tileX,
    fixture.node.tileY,
    RESOURCE_WOOD,
    fixture.node.amount,
  );
  if (nodeEid !== nextEid++) {
    throw new Error("fixture node eid mismatch");
  }
  createPlayerStockpile(world, comps, PLAYER_ONE);
  createDropOffPoint(
    world,
    comps,
    fixture.dropOff.x,
    fixture.dropOff.y,
    PLAYER_ONE,
  );
  createPlayerStockpile(world, comps, 1);
  const raiderEid = spawnCombatUnit(
    world,
    comps,
    "militia",
    fixture.raider.x,
    fixture.raider.y,
    1,
  );
  if (raiderEid !== fixture.raider.eid) {
    throw new Error("fixture raider eid mismatch");
  }

  for (const command of fixture.commands) world.inbox.submit(command);

  const digests: MilestoneDigest[] = [];
  while (world.tick < fixture.ticks) {
    step(world);
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const victimEid = 2;
  let victimFullyDespawned = !world.entities.includes(victimEid);
  for (const rows of world.rowsByComponentId.values()) {
    if (rows.has(victimEid)) victimFullyDespawned = false;
  }

  const survivorPositions: [number, number, number][] = [];
  for (const spawn of fixture.spawns) {
    if (!world.entities.includes(spawn.eid)) continue;
    const pos = getPosition(world, comps, spawn.eid);
    survivorPositions.push([spawn.eid, pos.x, pos.y]);
  }

  const slotClaims: [number, number, number][] = [];
  let queuedAttackActivities = 0;
  const liveSet = new Set(world.entities);
  const danglingTargets: number[] = [];
  for (const eid of world.entities) {
    const assigned = getAssignedNode(world, comps, eid);
    if (assigned) {
      slotClaims.push([eid, assigned.nodeEid, assigned.slotIndex]);
    }
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow && combatRow[3] !== 0 && !liveSet.has(combatRow[3]!)) {
      danglingTargets.push(eid);
    }
    for (const activity of readActivityQueue(world, comps, eid)) {
      if (activity.kind === "attack") queuedAttackActivities += 1;
    }
  }

  const p0Deaths = readCombatEvents(world, comps, PLAYER_ONE)
    .filter((event) => event.kind === COMBAT_EVENT_DEATH)
    .map((event) => event.victimEid);
  const p1Damage = readCombatEvents(world, comps, 1).filter(
    (event) => event.kind === COMBAT_EVENT_DAMAGE,
  ).length;

  const extractedWood =
    gatherDiagnostics.extractedByResource[RESOURCE_WOOD] ?? 0;
  let carriedWood = 0;
  for (const spawn of fixture.spawns) {
    if (!liveSet.has(spawn.eid)) continue;
    const inv = getInventory(world, comps, spawn.eid);
    if (inv && inv.resourceCode === RESOURCE_WOOD) carriedWood += inv.amount;
  }

  return {
    digests,
    finalTick: world.tick,
    survivorPositions,
    slotClaims,
    nodeRemaining: getResourceNodeRow(world, comps, nodeEid)![1]!,
    depositedWood: stockpileAmountsOf(world, comps, PLAYER_ONE)[RESOURCE_WOOD]!,
    extractedWood,
    carriedWood,
    queuedAttackActivities,
    danglingTargets,
    victimFullyDespawned,
    victimDeathEvents: p0Deaths,
    p1DamageTakenEvents: p1Damage,
    kills: diagnostics.kills,
    strikes: diagnostics.strikes,
    retaliations: diagnostics.retaliations,
    attackCommandsApplied: diagnostics.attackCommands,
  };
}

installSimPurityShims();

describe("golden harness m2t5b", () => {
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

  it("cleans the corpse up completely and keeps the loop running", () => {
    const run = runScenario(fixture);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.attackCommandsApplied).toBe(1);

    // The duel: militia lands blow 7 on the 25-hp villager (4 damage
    // each); the villager's sixth retaliation landed before death.
    expect(run.kills).toBe(1);
    expect(run.strikes).toBe(13);
    expect(run.retaliations).toBe(1);
    expect(run.p1DamageTakenEvents).toBe(6);

    // Death cleanup acceptance criteria:
    expect(run.victimFullyDespawned).toBe(true);
    expect(run.victimDeathEvents).toEqual([2]);
    expect(run.danglingTargets).toEqual([]);
    expect(run.queuedAttackActivities).toBe(0);

    // No orphan slot claims: exactly the two survivors hold claims on
    // the wood node, exclusively slotted inside the 8-slot budget.
    expect(run.slotClaims.every(([, nodeEid]) => nodeEid === 4)).toBe(true);
    const slots = run.slotClaims.map(([, , slot]) => slot);
    expect(new Set(slots).size).toBe(slots.length);
    for (const slot of slots) {
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(8);
    }
    expect(run.survivorPositions.map(([eid]) => eid)).toEqual([1, 3]);

    // The gather loop survived the fight and closed its ledger:
    // extracted == deposited + still-carried, and the node shrank by
    // exactly the extraction total.
    expect(run.depositedWood).toBeGreaterThan(0);
    expect(run.extractedWood).toBe(run.depositedWood + run.carriedWood);
    expect(run.nodeRemaining).toBe(400 - run.extractedWood);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(20);
  });
});
