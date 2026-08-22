/**
 * Gather-loop unit coverage — M1-T9 (SPEC §2.6).
 *
 * Hand-built open-grass worlds isolate each mechanic: work-slot
 * exclusivity under contention (12 workers → 8 slots + 4 overflow),
 * overflow milling on the outer holding ring, exact integer carry
 * math against node depletion, cheapest-drop-off selection with an
 * unreachable candidate walled off entirely, uncontended auto-repeat
 * resuming the identical slot across deliveries, the resource
 * conservation ledger across a full deplete→partial-deliver→release
 * lifecycle, command validation, and the digest wire format for the
 * new activity kinds.
 */

import { describe, expect, it } from "vitest";
import {
  decodeActivities,
  encodeActivities,
  gatherActivity,
  deliverActivity,
} from "../src/sim/activities";
import {
  defineSimComponents,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  getAssignedNode,
  getInventory,
  getResourceNodeRow,
  RESOURCE_GOLD,
  RESOURCE_WOOD,
} from "../src/sim/components/economy";
import {
  createPlayerStockpile,
  createDropOffPoint,
  PLAYER_ONE,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createGatherDiagnostics,
  createGatherSystem,
  type GatherDiagnostics,
} from "../src/sim/systems/gather";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  buildLayers,
  TERRAIN_GRASS,
  TERRAIN_WATER,
} from "../src/sim/world/layers";
import { issueGather } from "../src/ui/orders";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

// ---- Harness -----------------------------------------------------------------

interface WorldSpec {
  readonly size?: number | undefined;
  /** Water tiles painted before layers derive passability. */
  readonly waterTiles?: readonly (readonly [number, number])[];
  readonly unitSpots?: readonly { x: number; y: number }[];
  readonly nodes?: readonly {
    tileX: number;
    tileY: number;
    resource?: number;
    amount?: number;
    workSlots?: number;
  }[];
  readonly dropOffs?: readonly { x: number; y: number }[];
}

interface GatherWorld {
  readonly world: World;
  readonly comps: SimComponents;
  readonly diagnostics: GatherDiagnostics;
  readonly stockpileId: number;
  readonly dropOffIds: number[];
  readonly nodeIds: number[];
  readonly unitIds: number[];
}

const SEED = 20260917;

function buildGatherWorld(spec: WorldSpec): GatherWorld {
  const size = spec.size ?? 24;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  for (const [x, y] of spec.waterTiles ?? [])
    terrainType[y * size + x] = TERRAIN_WATER;
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(SEED, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));
  const diagnostics = createGatherDiagnostics();
  registerSystem(world, createGatherSystem(comps, scheduler, diagnostics));

  const stockpileId = createPlayerStockpile(world, comps, PLAYER_ONE);
  const dropOffIds = (spec.dropOffs ?? [{ x: 2.5, y: 2.5 }]).map((d) =>
    createDropOffPoint(world, comps, d.x, d.y),
  );
  const nodeIds = (spec.nodes ?? []).map((n) =>
    spawnResourceNode(
      world,
      comps,
      n.tileX,
      n.tileY,
      n.resource ?? RESOURCE_WOOD,
      n.amount ?? 500,
      n.workSlots === undefined ? {} : { workSlots: n.workSlots },
    ),
  );
  const unitIds = (spec.unitSpots ?? []).map((u) =>
    spawnUnit(world, comps, u.x, u.y),
  );
  return {
    world,
    comps,
    diagnostics,
    stockpileId,
    dropOffIds,
    nodeIds,
    unitIds,
  };
}

/** Submit a gather order exactly like the UI issuer does. */
function issueGatherAt(
  world: World,
  entityIds: readonly number[],
  nodeId: number,
): void {
  issueGather(world.inbox, world.tick, entityIds, nodeId);
}

function runTicks(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(world);
}

/** Step until `predicate` holds or `maxTicks` elapse (returns success). */
function runUntil(
  world: World,
  maxTicks: number,
  predicate: () => boolean,
): boolean {
  while (world.tick < maxTicks) {
    step(world);
    if (predicate()) return true;
  }
  return predicate();
}

function slotClaimsByNode(
  world: World,
  comps: SimComponents,
  nodeEid: number,
): Map<number, number> {
  const claims = new Map<number, number>(); // eid → slotIndex
  for (const eid of world.entities) {
    const assigned = getAssignedNode(world, comps, eid);
    if (assigned?.nodeEid !== nodeEid) continue;
    claims.set(eid, assigned.slotIndex);
  }
  return claims;
}

// ---- Work-slot exclusivity -----------------------------------------------------

describe("work-slot claiming", () => {
  it("caps 12 contending workers at 8 exclusive slots plus 4 overflow", () => {
    const { world, comps, nodeIds, unitIds } = buildGatherWorld({
      unitSpots: Array.from({ length: 12 }, (_, i) => ({ x: i + 6.5, y: 6.5 })),
      nodes: [{ tileX: 12, tileY: 12 }],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);
    runTicks(world, 3);

    const claims = slotClaimsByNode(world, comps, nodeIds[0]!);
    expect(claims.size).toBe(12);
    const slotted = [...claims.entries()].filter(([, slot]) => slot >= 0);
    const overflow = [...claims.entries()].filter(([, slot]) => slot < 0);
    // Exactly 8 distinct slots, claimed once each, indices 0..7.
    expect(new Set(slotted.map(([, slot]) => slot))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    expect(slotted.length).toBe(8);
    // Overflow mills instead of piling onto a slot.
    expect(overflow.length).toBe(4);
    // Ascending-eid priority: the four highest eids lose the race.
    expect(overflow.map(([eid]) => eid)).toEqual(unitIds.slice(8));
  });

  it("reassigns deterministically when workers move between nodes", () => {
    const { world, comps, nodeIds, unitIds } = buildGatherWorld({
      unitSpots: Array.from({ length: 12 }, (_, i) => ({ x: i + 6.5, y: 6.5 })),
      nodes: [
        { tileX: 12, tileY: 12 },
        { tileX: 18, tileY: 18 },
      ],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);
    runTicks(world, 2);
    // Re-send the last four ascending workers to the second node.
    issueGatherAt(world, unitIds.slice(8), nodeIds[1]!);
    runTicks(world, 2);

    const first = slotClaimsByNode(world, comps, nodeIds[0]!);
    const second = slotClaimsByNode(world, comps, nodeIds[1]!);
    expect(first.size).toBe(8);
    expect(new Set(first.values())).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(second.size).toBe(4);
    expect(new Set(second.values())).toEqual(new Set([0, 1, 2, 3]));
    expect([...first.keys(), ...second.keys()].sort((a, b) => a - b)).toEqual(
      unitIds,
    );
  });

  it("mills overflow workers on the outer holding ring", () => {
    const { world, comps, nodeIds, unitIds } = buildGatherWorld({
      unitSpots: Array.from({ length: 12 }, (_, i) => ({ x: i + 6.5, y: 6.5 })),
      nodes: [{ tileX: 12, tileY: 12 }],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);
    // Longest spawn→slot walk ≈ 8 tiles; let everyone settle into work
    // or holding before asserting geometry.
    runTicks(world, 450);

    const claims = slotClaimsByNode(world, comps, nodeIds[0]!);
    const nodePos = { x: 12.5, y: 12.5 };
    const positionRows = world.rowsByComponentId.get(comps.positionId);
    for (const [eid, slot] of claims) {
      const pos = positionRows?.get(eid);
      expect(pos).toBeDefined();
      const distance = Math.hypot(pos![0]! - nodePos.x, pos![1]! - nodePos.y);
      if (slot >= 0) {
        // Slotted workers stand on adjacent tile centers (1–√2 tiles
        // out) plus crowd-shove slack.
        expect(distance).toBeLessThanOrEqual(1.6);
      } else {
        // Ring 2 holding radius is 1.8 tiles; settled overflow sits
        // beyond the inner ring but within crowding slack of its point.
        expect(distance).toBeGreaterThanOrEqual(1.5);
        expect(distance).toBeLessThanOrEqual(2.9);
      }
    }
  });
});

// ---- Carry math ---------------------------------------------------------------

describe("carry capacity and extraction", () => {
  it("extracts exact integers: inventory mirrors node depletion", () => {
    const { world, comps, nodeIds, unitIds, diagnostics } = buildGatherWorld({
      unitSpots: [{ x: 11.5, y: 12.5 }], // exactly on the west work slot
      nodes: [{ tileX: 12, tileY: 12, amount: 50 }],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);

    const ok = runUntil(
      world,
      400,
      () => diagnostics.extractedByResource[RESOURCE_WOOD]! >= 3,
    );
    expect(ok).toBe(true);

    const inv = getInventory(world, comps, unitIds[0]!)!;
    expect(inv.resourceCode).toBe(RESOURCE_WOOD);
    expect(inv.amount).toBe(diagnostics.extractedByResource[RESOURCE_WOOD]);
    expect(inv.amount).toBeGreaterThanOrEqual(3);
    const remaining = getResourceNodeRow(world, comps, nodeIds[0]!)![1]!;
    expect(remaining).toBe(
      50 - diagnostics.extractedByResource[RESOURCE_WOOD]!,
    );
    // Extraction happens in whole ticksPerUnit intervals — nothing partial.
    expect(Number.isInteger(inv.amount)).toBe(true);
  });

  it("stops at carry capacity, delivers, and repeats unattended", () => {
    const { world, comps, nodeIds, unitIds, diagnostics, dropOffIds } =
      buildGatherWorld({
        unitSpots: [{ x: 11.5, y: 12.5 }],
        nodes: [{ tileX: 12, tileY: 12, amount: 100 }],
        dropOffs: [{ x: 10.5, y: 10.5 }],
      });
    issueGatherAt(world, unitIds, nodeIds[0]!);

    let observedMaxCarry = 0;
    const ok = runUntil(world, 1800, () => {
      const amount = getInventory(world, comps, unitIds[0]!)!.amount;
      observedMaxCarry = Math.max(observedMaxCarry, amount);
      return (
        diagnostics.deliveriesByDropOff.length > 0 &&
        diagnostics.deliveriesByDropOff.reduce((a, b) => a + b!, 0) >= 2
      );
    });
    expect(ok).toBe(true);
    expect(observedMaxCarry).toBeLessThanOrEqual(10);
    expect(stockpileAmountsOf(world, comps, PLAYER_ONE)[RESOURCE_WOOD]).toBe(
      diagnostics.depositedByResource[RESOURCE_WOOD],
    );
    expect(getResourceNodeRow(world, comps, nodeIds[0]!)![1]!).toBe(
      100 - diagnostics.extractedByResource[RESOURCE_WOOD]!,
    );
    // Auto-repeat keeps working without further orders.
    expect(getAssignedNode(world, comps, unitIds[0]!)).toBeDefined();
    expect(dropOffIds.length).toBeGreaterThan(0);
  });
});

// ---- Drop-off choice ------------------------------------------------------------

describe("cheapest known drop-off point", () => {
  function walledWorld(gap: boolean): GatherWorld {
    const waterTiles: [number, number][] = [];
    for (let y = 0; y < 24; y++) {
      if (gap && (y === 20 || y === 21)) continue;
      waterTiles.push([14, y]);
    }
    return buildGatherWorld({
      size: 24,
      waterTiles,
      unitSpots: [
        { x: 9.5, y: 9.5 },
        { x: 10.5, y: 9.5 },
      ],
      nodes: [{ tileX: 8, tileY: 8, amount: 200 }],
      // Near drop-off west of the wall; far one east (rank 1).
      dropOffs: [
        { x: 10.5, y: 10.5 },
        { x: 20.5, y: 10.5 },
      ],
    });
  }

  it("skips unreachable drop-off points entirely", () => {
    const gathered = walledWorld(false); // sealed wall: east point unreachable
    issueGatherAt(gathered.world, gathered.unitIds, gathered.nodeIds[0]!);
    const ok = runUntil(
      gathered.world,
      1500,
      () =>
        gathered.diagnostics.deliveriesByDropOff.reduce((a, b) => a + b!, 0) >=
        2,
    );
    expect(ok).toBe(true);
    expect(gathered.diagnostics.deliveriesByDropOff[0]!).toBeGreaterThanOrEqual(
      2,
    );
    expect(gathered.diagnostics.deliveriesByDropOff[1] ?? 0).toBe(0);
  });

  it("prefers the strictly cheaper route when both are reachable", () => {
    const open = walledWorld(true); // southern gap keeps the far point reachable
    issueGatherAt(open.world, open.unitIds, open.nodeIds[0]!);
    const ok = runUntil(
      open.world,
      1500,
      () =>
        open.diagnostics.deliveriesByDropOff.reduce((a, b) => a + b!, 0) >= 2,
    );
    expect(ok).toBe(true);
    expect(open.diagnostics.deliveriesByDropOff[0]!).toBeGreaterThanOrEqual(2);
    // The eastern point is reachable but never wins on cost.
    expect(open.diagnostics.deliveriesByDropOff[1] ?? 0).toBe(0);
  });
});

// ---- Auto-repeat ------------------------------------------------------------------

describe("auto-repeat", () => {
  it("resumes the identical slot after every delivery cycle", () => {
    const { world, comps, nodeIds, unitIds, diagnostics } = buildGatherWorld({
      unitSpots: [{ x: 11.5, y: 12.5 }],
      nodes: [{ tileX: 12, tileY: 12, amount: 300 }],
      dropOffs: [{ x: 10.5, y: 10.5 }],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);

    const observedSlots = new Set<number>();
    runUntil(world, 2200, () => {
      const assigned = getAssignedNode(world, comps, unitIds[0]!);
      if (assigned) observedSlots.add(assigned.slotIndex);
      return diagnostics.deliveriesByDropOff.reduce((a, b) => a + b!, 0) >= 2;
    });
    expect(observedSlots.size).toBe(1);
    // A lone worker always takes enumeration rank 0 — the north
    // neighbor — and every auto-repeat re-claims exactly that slot.
    expect([...observedSlots][0]).toBe(0);
  });
});

// ---- Conservation ledger ----------------------------------------------------------

describe("resource conservation (SPEC §7 property)", () => {
  it("conserves every unit across deplete → partial-deliver → release", () => {
    const { world, comps, nodeIds, unitIds, diagnostics } = buildGatherWorld({
      unitSpots: [{ x: 11.5, y: 12.5 }],
      nodes: [{ tileX: 12, tileY: 12, amount: 37 }], // odd amount forces partials
      dropOffs: [{ x: 10.5, y: 10.5 }],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);

    // The node fully depletes and the worker finishes its final delivery.
    const ok = runUntil(world, 2600, () => {
      const assigned = getAssignedNode(world, comps, unitIds[0]!);
      const inv = getInventory(world, comps, unitIds[0]!);
      return assigned === undefined && (inv?.amount ?? 0) === 0;
    });
    expect(ok).toBe(true);

    const extracted = diagnostics.extractedByResource[RESOURCE_WOOD]!;
    const deposited = diagnostics.depositedByResource[RESOURCE_WOOD]!;
    const carried = getInventory(world, comps, unitIds[0]!)!.amount;
    const remainingTotal = getResourceNodeRow(world, comps, nodeIds[0]!)![1]!;
    expect(extracted).toBe(37);
    expect(remainingTotal).toBe(0);
    // Ledger closes exactly: extracted == deposited + still-carried.
    expect(extracted).toBe(deposited + carried);
    // Deposits landed in the player's stockpile verbatim.
    expect(stockpileAmountsOf(world, comps, PLAYER_ONE)[RESOURCE_WOOD]).toBe(
      deposited,
    );
    // Released workers idle cleanly with empty queues.
    const queueRow = world.rowsByComponentId
      .get(comps.activityQueueId)
      ?.get(unitIds[0]!);
    expect(queueRow).toBeDefined();
    expect(queueRow).toEqual([0]);
  });
});

// ---- Command validation ------------------------------------------------------------

describe("gather command validation", () => {
  it("rejects unknown node targets loudly inside step()", () => {
    const { world, unitIds } = buildGatherWorld({
      unitSpots: [{ x: 5.5, y: 5.5 }],
    });
    issueGather(world.inbox, world.tick, unitIds, 999);
    expect(() => step(world)).toThrow(/no ResourceNode row/);
  });

  it("rejects empty selections and malformed node ids at issue time", () => {
    const { world } = buildGatherWorld({ unitSpots: [{ x: 5.5, y: 5.5 }] });
    expect(() => issueGather(world.inbox, world.tick, [], 1)).toThrow(
      /at least one entity/,
    );
    expect(() => issueGather(world.inbox, world.tick, [1], Number.NaN)).toThrow(
      /positive integer/,
    );
  });

  it("refuses mixed-resource carries instead of voiding goods", () => {
    const { world, comps, unitIds, nodeIds } = buildGatherWorld({
      unitSpots: [{ x: 11.5, y: 12.5 }],
      nodes: [
        { tileX: 12, tileY: 12, resource: RESOURCE_WOOD },
        { tileX: 18, tileY: 18, resource: RESOURCE_GOLD, amount: 50 },
      ],
    });
    issueGatherAt(world, unitIds, nodeIds[0]!);
    runTicks(world, 120); // accumulate some gold-free wood carry
    const carried = getInventory(world, comps, unitIds[0]!)!;
    expect(carried.amount).toBeGreaterThan(0);
    // Switching the SAME carrier to a gold node while carrying wood throws.
    issueGatherAt(world, unitIds, nodeIds[1]!);
    expect(() => step(world)).toThrow(/carries resource/);
  });
});

// ---- Activity wire format ------------------------------------------------------------

describe("gather/deliver activity encoding", () => {
  it("round-trips gather and deliver heads through the numeric stream", () => {
    const queue = [gatherActivity(30, 7), deliverActivity(42)];
    const decoded = decodeActivities(encodeActivities(queue));
    expect(decoded).toEqual(queue);
  });

  it("rejects malformed payloads loudly", () => {
    expect(() => gatherActivity(30, 30)).toThrow(/elapsed ticks/);
    expect(() => deliverActivity(0)).toThrow(/positive integer/);
    // Well-formed framing around an unknown kind code: 1 entry, kind 99,
    // payload length 1.
    expect(() => decodeActivities([1, 99, 1, 5])).toThrow(
      /unknown activity kind/,
    );
  });
});
