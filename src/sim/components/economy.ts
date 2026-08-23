/**
 * Economy component definitions — SPEC §2.6 / M1-T9.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement set; registration is one strictly alphabetical sequence
 * (components/index.ts defineSimComponents), pinning digest/save
 * iteration order forever (world.ts).
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - AssignedNode (2): [nodeEntityId, claimedSlotIndex] — slot −1 marks
 *   an overflow worker milling in the outer holding ring.
 * - CarryCapacity (1): [maxUnitsOfOneResource].
 * - Inventory (2): [resourceCode, carriedAmount] — a worker carries at
 *   most ONE resource kind at a time (AoE2-faithful).
 * - ResourceNode (3): [resourceCode, remainingUnits, workSlotCount] —
 *   attached to cell-occupying gatherable entities (trees/berries/…).
 *   M1 nodes are data-only occupancy: they do NOT mutate derived
 *   passability, so no passabilityVersion churn rides node depletion.
 */

import { spawnEntity, type ComponentRows, type World } from "../core/world";

export const ASSIGNED_NODE = "AssignedNode" as const;
export const CARRY_CAPACITY = "CarryCapacity" as const;
export const INVENTORY = "Inventory" as const;
export const RESOURCE_NODE = "ResourceNode" as const;

/**
 * Gatherable resource codes — stable u8 enum values baked into rows and
 * fixtures, never reordered. Order mirrors RESOURCE_SLUGS in
 * data/schema.ts (SPEC §2.6: the base four plus the M2 Iron/Coal/Clay
 * set as codes 4–6).
 */
export const RESOURCE_FOOD = 0;
export const RESOURCE_WOOD = 1;
export const RESOURCE_GOLD = 2;
export const RESOURCE_STONE = 3;
export const RESOURCE_IRON = 4;
export const RESOURCE_COAL = 5;
export const RESOURCE_CLAY = 6;
/** Active resource count (the full §2.6 gatherable set). */
export const RESOURCE_COUNT = 7;

/** Human-readable resource names indexed by resource code. */
export const RESOURCE_NAMES: readonly string[] = [
  "food",
  "wood",
  "gold",
  "stone",
  "iron",
  "coal",
  "clay",
];

export function requireResourceCode(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code >= RESOURCE_COUNT) {
    throw new Error(`unknown resource code: ${String(code)}`);
  }
  return code;
}

/** Row arity per economy component — pinned for digest stability. */
export const ECONOMY_COMPONENT_ARITIES: readonly [string, number][] = [
  [ASSIGNED_NODE, 2],
  [CARRY_CAPACITY, 1],
  [INVENTORY, 2],
  [RESOURCE_NODE, 3],
];

/** Component ids the economy systems read/write. */
export interface EconomyComponents {
  readonly assignedNodeId: number;
  readonly carryCapacityId: number;
  readonly inventoryId: number;
  readonly resourceNodeId: number;
}

/** Work slots claimable around one resource node (SPEC §2.6). */
export const WORK_SLOTS_PER_NODE = 8;

function requireRow(
  world: World,
  componentId: number,
  eid: number,
  label: string,
): number[] {
  const values = world.rowsByComponentId.get(componentId)?.get(eid);
  if (!values) {
    throw new Error(`entity ${String(eid)} has no ${label} row`);
  }
  return values;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows)
    throw new Error(`unregistered component id: ${String(componentId)}`);
  return rows;
}

// ---- Resource nodes ---------------------------------------------------------

export interface SpawnResourceNodeOptions {
  /** Claimable work slots; defaults to WORK_SLOTS_PER_NODE. */
  readonly workSlots?: number | undefined;
}

/**
 * Spawn one cell-occupying resource node centered on tile
 * (`tileX`, `tileY`). The node carries a Position row (tile center) so
 * systems can recover its tile; the tile itself stays walkable in M1 —
 * villagers stand on adjacent work slots by convention only.
 */
export function spawnResourceNode(
  world: World,
  econ: EconomyComponents & { positionId: number },
  tileX: number,
  tileY: number,
  resourceCode: number,
  amount: number,
  options: SpawnResourceNodeOptions = {},
): number {
  if (!Number.isInteger(tileX) || !Number.isInteger(tileY)) {
    throw new Error(
      `resource node tile must be integer coordinates, got (${String(tileX)}, ${String(tileY)})`,
    );
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(
      `resource node amount must be a positive integer, got ${String(amount)}`,
    );
  }
  const workSlots = options.workSlots ?? WORK_SLOTS_PER_NODE;
  if (!Number.isInteger(workSlots) || workSlots < 0) {
    throw new Error(
      `resource node work slots must be a non-negative integer, got ${String(workSlots)}`,
    );
  }
  requireResourceCode(resourceCode);
  const eid = spawnEntity(world);
  requireRows(world, econ.positionId).set(eid, [tileX + 0.5, tileY + 0.5]);
  requireRows(world, econ.resourceNodeId).set(eid, [
    resourceCode,
    amount,
    workSlots,
  ]);
  return eid;
}

/** Live resource-node row for `eid`, or undefined when not a node. */
export function getResourceNodeRow(
  world: World,
  econ: EconomyComponents,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(econ.resourceNodeId)?.get(eid);
}

// ---- Carry capacity + inventory ---------------------------------------------

/** Default villager carry capacity (AoE2 baseline, SPEC §2.6). */
export const DEFAULT_CARRY_CAPACITY = 10;

/** Attach the default carry capacity row when absent. Idempotent. */
export function ensureCarryCapacity(
  world: World,
  econ: EconomyComponents,
  eid: number,
  capacity: number = DEFAULT_CARRY_CAPACITY,
): void {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(
      `carry capacity must be a positive integer, got ${String(capacity)}`,
    );
  }
  const rows = requireRows(world, econ.carryCapacityId);
  if (!rows.has(eid)) rows.set(eid, [capacity]);
}

export function getCarryCapacity(
  world: World,
  econ: EconomyComponents,
  eid: number,
): number {
  return requireRow(world, econ.carryCapacityId, eid, CARRY_CAPACITY)[0]!;
}

/** Carried {resourceCode, amount}, or undefined without an Inventory row. */
export function getInventory(
  world: World,
  econ: EconomyComponents,
  eid: number,
): { resourceCode: number; amount: number } | undefined {
  const row = world.rowsByComponentId.get(econ.inventoryId)?.get(eid);
  if (!row) return undefined;
  return { resourceCode: row[0]!, amount: row[1]! };
}

/** Attach an Inventory row when absent (keeps any existing load). */
export function ensureInventory(
  world: World,
  econ: EconomyComponents,
  eid: number,
  resourceCode: number,
): void {
  const rows = requireRows(world, econ.inventoryId);
  if (!rows.has(eid)) rows.set(eid, [requireResourceCode(resourceCode), 0]);
}

/** Overwrite one worker's carried load (amount ≥ 0, integer). */
export function setInventory(
  world: World,
  econ: EconomyComponents,
  eid: number,
  resourceCode: number,
  amount: number,
): void {
  requireResourceCode(resourceCode);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(
      `carried amount must be a non-negative integer, got ${String(amount)}`,
    );
  }
  const row = requireRow(world, econ.inventoryId, eid, INVENTORY);
  row[0] = resourceCode;
  row[1] = amount;
}

// ---- Node assignment --------------------------------------------------------

/**
 * Assign `workerEid` to gather from `nodeEid`. The claimed slot index
 * resolves during the next gather-system tick (ascending-eid priority);
 * −1 marks overflow until then.
 */
export function assignNode(
  world: World,
  econ: EconomyComponents,
  workerEid: number,
  nodeEid: number,
): void {
  if (!Number.isInteger(nodeEid) || nodeEid < 1) {
    throw new Error(
      `assigned node entity id must be a positive integer, got ${String(nodeEid)}`,
    );
  }
  const rows = requireRows(world, econ.assignedNodeId);
  rows.set(workerEid, [nodeEid, -1]);
}

export function getAssignedNode(
  world: World,
  econ: EconomyComponents,
  workerEid: number,
): { nodeEid: number; slotIndex: number } | undefined {
  const row = world.rowsByComponentId.get(econ.assignedNodeId)?.get(workerEid);
  if (!row) return undefined;
  return { nodeEid: row[0]!, slotIndex: row[1]! };
}

/** Release the worker's assignment (row disappears from digests). */
export function clearAssignedNode(
  world: World,
  econ: EconomyComponents,
  workerEid: number,
): boolean {
  const rows = world.rowsByComponentId.get(econ.assignedNodeId);
  return rows?.delete(workerEid) ?? false;
}
