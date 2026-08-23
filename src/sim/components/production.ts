/**
 * Production component definitions — SPEC §2.6 depth-1 chains / M2-T3.
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/building sets; registration is one strictly
 * alphabetical sequence (components/index.ts defineSimComponents),
 * pinning digest/save iteration order forever (world.ts).
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - ProductionCycle (3): [ownerPlayerId, recipeCode, remainingTicks] —
 *   attached to FINISHED production buildings. recipeCode is the stable
 *   numeric code over the loaded recipe set (data/definitions.ts,
 *   ascending slug); remainingTicks > 0 marks a cycle IN FLIGHT whose
 *   inputs were already consumed at start, 0 marks idle/stalled.
 * - ProductionJob (2): [buildingEid, claimedSlotIndex] — mirrors
 *   AssignedNode; a crafter's live production assignment. Slot −1 marks
 *   an overflow worker beyond the building's workSlots cap. Claims are
 *   DERIVED STATE recomputed every tick from this row set alone with
 *   ascending-eid priority — same discipline as gather slots.
 * - MealConsumed (variable): [entryCount, tick₀, qty₀, …] — append-only
 *   morale-stub event log on kitchens (SPEC §2.6: meals feed Pop needs;
 *   the consuming system arrives M3 and reads these rows instead of
 *   re-deriving history). Every completed meals batch appends one entry
 *   inside step(), so the events ride golden digests like any state.
 */

import type { ComponentRows, World } from "../core/world";

export const MEAL_CONSUMED = "MealConsumed" as const;
export const PRODUCTION_CYCLE = "ProductionCycle" as const;
export const PRODUCTION_JOB = "ProductionJob" as const;

/** Row arity per production component — pinned for digest stability. */
export const PRODUCTION_COMPONENT_ARITIES: readonly [string, number][] = [
  [MEAL_CONSUMED, -1], // variable-length event log
  [PRODUCTION_CYCLE, 3],
  [PRODUCTION_JOB, 2],
];

/** Component ids the production system reads/writes. */
export interface ProductionComponents {
  readonly mealConsumedId: number;
  readonly productionCycleId: number;
  readonly productionJobId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- ProductionCycle ------------------------------------------------------------

/** Live ProductionCycle row for `eid`, or undefined when not a producer. */
export function getProductionCycleRow(
  world: World,
  comps: Pick<ProductionComponents, "productionCycleId">,
  eid: number,
): readonly number[] | undefined {
  return world.rowsByComponentId.get(comps.productionCycleId)?.get(eid);
}

/**
 * Create or overwrite one building's cycle row. `remainingTicks` of 0
 * means idle; callers starting a cycle write the full duration after
 * consuming inputs so the sunk cost is digest-visible immediately.
 */
export function setProductionCycleRow(
  world: World,
  comps: Pick<ProductionComponents, "productionCycleId">,
  eid: number,
  playerId: number,
  recipeCode: number,
  remainingTicks: number,
): void {
  requireRows(world, comps.productionCycleId).set(eid, [
    playerId,
    recipeCode,
    remainingTicks,
  ]);
}

// ---- ProductionJob ---------------------------------------------------------------

/**
 * Assign one crafter to a production building (replacing any prior
 * assignment). The claimed slot resolves during the next production-
 * system tick (ascending-eid priority); −1 marks overflow until then.
 */
export function assignProductionJob(
  world: World,
  comps: Pick<ProductionComponents, "productionJobId">,
  workerEid: number,
  buildingEid: number,
): void {
  if (!Number.isInteger(buildingEid) || buildingEid < 1) {
    throw new Error(
      `production building entity id must be a positive integer, got ${String(buildingEid)}`,
    );
  }
  requireRows(world, comps.productionJobId).set(workerEid, [buildingEid, -1]);
}

/** Live {buildingEid, slotIndex} for one crafter, or undefined. */
export function getProductionJob(
  world: World,
  comps: Pick<ProductionComponents, "productionJobId">,
  workerEid: number,
): { buildingEid: number; slotIndex: number } | undefined {
  const row = world.rowsByComponentId
    .get(comps.productionJobId)
    ?.get(workerEid);
  if (!row) return undefined;
  return { buildingEid: row[0]!, slotIndex: row[1]! };
}

/** Release the crafter's assignment (row disappears from digests). */
export function clearProductionJob(
  world: World,
  comps: Pick<ProductionComponents, "productionJobId">,
  workerEid: number,
): boolean {
  return (
    world.rowsByComponentId.get(comps.productionJobId)?.delete(workerEid) ??
    false
  );
}

// ---- MealConsumed ------------------------------------------------------------------

/** One digest-visible meal-consumption event (morale stub, M2-T3). */
export interface MealConsumedEvent {
  readonly tick: number;
  readonly qty: number;
}

/**
 * Append one mealConsumed entry to `eid`'s event log. Variable rows
 * encode [count, tick₀, qty₀, …] exactly like TrainQueue — systems only
 * ever append inside step(), so replays see every event.
 */
export function appendMealConsumedEvent(
  world: World,
  comps: Pick<ProductionComponents, "mealConsumedId">,
  eid: number,
  event: MealConsumedEvent,
): void {
  const row = requireRows(world, comps.mealConsumedId).get(eid);
  const count = row?.[0] ?? 0;
  const next = row ? [...row] : [0];
  next.push(event.tick, event.qty);
  next[0] = count + 1;
  requireRows(world, comps.mealConsumedId).set(eid, next);
}

/** Decoded copy of one entity's meal events (fresh array each call). */
export function readMealConsumedEvents(
  world: World,
  comps: Pick<ProductionComponents, "mealConsumedId">,
  eid: number,
): MealConsumedEvent[] {
  const row = world.rowsByComponentId.get(comps.mealConsumedId)?.get(eid);
  if (!row) return [];
  const events: MealConsumedEvent[] = [];
  for (let i = 0; i < row[0]!; i++) {
    events.push({ tick: row[1 + i * 2]!, qty: row[2 + i * 2]! });
  }
  return events;
}
