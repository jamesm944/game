/**
 * Production system — SPEC §2.6 depth-1 commodity chains / M2-T3.
 *
 * Finished production buildings (sawpit/kiln/smithy/forge/kitchen) run
 * DF-raws-style recipe cycles entirely inside step():
 *
 *   produce command → crafters claim ≤ workSlots slots (derived state,
 *   ascending-eid priority — the gather-node pattern) → walk to the
 *   footprint approach band → cycle START consumes the FULL input list
 *   from the owner's stockpile ledgers atomically (only when every
 *   input is available AND a slotted crafter stands in range; else the
 *   building stalls politely, counted in diagnostics, never throwing)
 *   → remainingTicks counts down only while staffed → on the completion
 *   tick outputs credit to the commodity ledger and an immediate
 *   restart attempt keeps saturated buildings on an exact `ticks`
 *   cadence.
 *
 * Inputs/outputs route by slug family: gatherables debit/credit the
 * Stockpile rows, commodities the sibling CommodityStockpile rows
 * (core/stockpile.ts). Depth-1 content is loader-enforced (recipes take
 * gatherable inputs only), but the IO here stays slug-generic so a
 * future relaxed-depth flip needs no system change.
 *
 * techGate/ageGate respect runs through an injectable predicate seam:
 * the DEFAULT predicate consults the owner's live AgeState row (M2-T4)
 * so gated recipes stall politely until their age arrives; tests pin a
 * closed injected gate blocks starts, and pre-M2 worlds with no age
 * rows keep the everything-unlocked legacy behavior.
 *
 * Meals additionally append digest-visible MealConsumed event rows on
 * completion (SPEC §2.6 morale/work-speed buffs) — the M3 needs system
 * will read that log instead of re-deriving history.
 */

import {
  cancelActivities,
  enqueueActivity,
  moveActivity,
  peekActivity,
} from "../activities";
import {
  readActivityQueue,
  setMoveTarget,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { clearAssignedNode } from "../components/economy";
import {
  clearAssignedSite,
  getBuildingRow,
  type FootprintRect,
} from "../components/buildings";
import {
  appendMealConsumedEvent,
  assignProductionJob,
  clearProductionJob,
  getProductionCycleRow,
  setProductionCycleRow,
} from "../components/production";
import {
  buildingDefOf,
  buildingIdOfCode,
  recipeCodeOf,
  recipeDefOf,
  recipeIdOfCode,
  recipesForBuilding,
} from "../../data/definitions";
import {
  COMMODITY_SLUGS,
  RESOURCE_SLUGS,
  type RecipeDefinition,
} from "../../data/schema";
import {
  canDebitLedgerSlugs,
  debitLedgerSlugs,
  depositCommodityIntoStockpile,
  depositIntoStockpile,
} from "../core/stockpile";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";
import { rectDistanceSq, approachPoint } from "./construction";
import { resetSteeringBookkeeping } from "./movement";
import { isDefAgeUnlocked } from "./age";

/** Command kind owned by this system. */
export const PRODUCE_KIND = "produce";

/**
 * Distance from a producer's FOOTPRINT EDGE within which a slotted
 * crafter counts as staffing the building (mirrors construction's
 * working contract: adjacency, not center radius).
 */
export const PRODUCTION_WORK_RANGE_TILES = 2.5;

/** Perimeter door margin for crafters walking to a workshop. */
const APPROACH_MARGIN_TILES = 0.75;

export interface ProductionDiagnostics {
  /** produce commands applied. */
  commandsApplied: number;
  /** Cycles started (inputs consumed at start). */
  cyclesStarted: number;
  /** Cycles completed (outputs credited on their pinned tick). */
  cyclesCompleted: number;
  /** Output units credited, indexed by resource/commodity code. */
  producedByResource: number[];
  producedByCommodity: number[];
  /** Input units consumed at cycle starts, indexed likewise. */
  consumedByResource: number[];
  consumedByCommodity: number[];
  /** Ticks some idle building had inputs but NO staffed crafter… */
  stalledMissingWorkerTicks: number;
  /** …or staffed crafters but an incomplete input list. */
  stalledMissingInputTicks: number;
  /** Ticks a gate-closed recipe could not start. */
  gateBlockedTicks: number;
}

export function createProductionDiagnostics(): ProductionDiagnostics {
  return {
    commandsApplied: 0,
    cyclesStarted: 0,
    cyclesCompleted: 0,
    producedByResource: new Array<number>(RESOURCE_SLUGS.length).fill(0),
    producedByCommodity: new Array<number>(COMMODITY_SLUGS.length).fill(0),
    consumedByResource: new Array<number>(RESOURCE_SLUGS.length).fill(0),
    consumedByCommodity: new Array<number>(COMMODITY_SLUGS.length).fill(0),
    stalledMissingInputTicks: 0,
    stalledMissingWorkerTicks: 0,
    gateBlockedTicks: 0,
  };
}

/**
 * Unlock seam for techGate/age gates. When no predicate is injected,
 * the system falls back to the owner's live age state (M2-T4): recipes
 * whose ageGate outranks the owner stall politely until researched up.
 */
export interface ProductionGates {
  /** Return false to block cycle STARTS of that recipe. */
  readonly isRecipeUnlocked?: (recipe: RecipeDefinition) => boolean;
}

// ---- Command parsing ------------------------------------------------------------

function parseProduceData(data: Readonly<Record<string, unknown>>): {
  entityIds: number[];
  buildingEid: number;
  recipeId?: string;
} {
  const rawIds = data.entityIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error("produce requires a non-empty entityIds array");
  }
  const entityIds: number[] = [];
  for (const id of rawIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `produce entityIds entries must be positive integers, got ${String(id)}`,
      );
    }
    if (!entityIds.includes(id)) entityIds.push(id);
  }
  entityIds.sort((a, b) => a - b);
  const buildingEid = data.buildingEid;
  if (
    typeof buildingEid !== "number" ||
    !Number.isInteger(buildingEid) ||
    buildingEid < 1
  ) {
    throw new Error(
      `produce buildingEid must be a positive integer, got ${String(buildingEid)}`,
    );
  }
  let recipeId: string | undefined;
  if (data.recipeId !== undefined) {
    if (typeof data.recipeId !== "string" || data.recipeId.length === 0) {
      throw new Error("produce recipeId must be a non-empty string");
    }
    recipeId = data.recipeId;
  }
  return recipeId === undefined
    ? { entityIds, buildingEid }
    : { entityIds, buildingEid, recipeId };
}

interface Crafter {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  readonly velRow: number[] | undefined;
}

function slugIndexIn(
  slugs: readonly string[],
  slug: string,
): number | undefined {
  const index = slugs.indexOf(slug);
  return index >= 0 ? index : undefined;
}

// ---- The system -----------------------------------------------------------------

/**
 * Build the production SimSystem. Register AFTER construction so only
 * finished buildings ever carry cycle rows; movement steers the walk
 * legs this system plans.
 */
export function createProductionSystem(
  comps: SimComponents,
  diagnostics: ProductionDiagnostics = createProductionDiagnostics(),
  gates: ProductionGates = {},
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    // ---- 1) Commands consumed exactly on their target tick boundary;
    // shared inbox stream → dispatch only our kind.
    for (const command of commands) {
      if (command.kind !== PRODUCE_KIND) continue;
      if (!command.data) throw new Error("produce requires command data");
      applyProduceCommand(world, comps, diagnostics, command.data);
    }

    // ---- 2) Staffing claims per building, ascending eid. Claims derive
    // ONLY from the ProductionJob row set (travelers keep their slot),
    // mirroring gather's derived-state discipline.
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const velRows = world.rowsByComponentId.get(comps.velocityId);
    const tagRows = world.rowsByComponentId.get(comps.unitTagId);
    const jobRows = world.rowsByComponentId.get(comps.productionJobId);
    if (!jobRows) throw new Error("unregistered ProductionJob component");

    const craftersByBuilding = new Map<number, Crafter[]>();
    for (const eid of world.entities) {
      const jobRow = jobRows.get(eid);
      if (!jobRow) continue;
      const posRow = posRows?.get(eid);
      const tagRow = tagRows?.get(eid);
      if (!posRow || !tagRow) continue; // not a live unit
      const entry: Crafter = {
        eid,
        x: posRow[0]!,
        y: posRow[1]!,
        velRow: velRows?.get(eid),
      };
      const list = craftersByBuilding.get(jobRow[0]!);
      if (list) list.push(entry);
      else craftersByBuilding.set(jobRow[0]!, [entry]);
    }

    const rangeSq = PRODUCTION_WORK_RANGE_TILES * PRODUCTION_WORK_RANGE_TILES;
    /** Per-building staffed verdict feeding phase 3. */
    const staffedByBuilding = new Map<number, boolean>();

    for (const [buildingEid, group] of craftersByBuilding) {
      const buildingRow = getBuildingRow(world, comps, buildingEid);
      const buildingPos = posRows?.get(buildingEid);
      if (!buildingRow || !buildingPos) {
        // Building vanished underneath its crafters: release them all.
        for (const crafter of group) {
          clearProductionJob(world, comps, crafter.eid);
        }
        continue;
      }
      const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
      const width = def.footprint.width;
      const height = def.footprint.height;
      const rect: FootprintRect = {
        x: buildingPos[0]! - width / 2,
        y: buildingPos[1]! - height / 2,
        width,
        height,
      };

      let staffed = false;
      for (let i = 0; i < group.length; i++) {
        const crafter = group[i]!;
        const slotIndex = i < Math.max(0, def.workSlots) ? i : -1;
        // The claim write is digest-visible only when it changes.
        const jobRow = jobRows.get(crafter.eid)!;
        if (jobRow[1] !== slotIndex) jobRow[1] = slotIndex;
        const inRange = rectDistanceSq(crafter.x, crafter.y, rect) <= rangeSq;
        if (slotIndex >= 0 && inRange) staffed = true;

        // Planning pass: fill empty queues with a walk to the nearest
        // perimeter door; in-range crafters stand (no queue churn).
        const queue = readActivityQueue(world, comps, crafter.eid);
        if (peekActivity(queue) !== undefined) continue;
        if (inRange) continue;
        const door = approachPoint(
          world,
          rect,
          APPROACH_MARGIN_TILES,
          crafter.x,
          crafter.y,
        );
        enqueueActivity(queue, moveActivity([door.x, door.y]));
        writeActivityQueue(world, comps, crafter.eid, queue);
        setMoveTarget(world, comps, crafter.eid, door.x, door.y);
        if (crafter.velRow) resetSteeringBookkeeping(crafter.velRow);
      }
      staffedByBuilding.set(buildingEid, staffed);
    }

    // ---- 3) Cycle advancement per producing building, ascending eid.
    const cycleRows = world.rowsByComponentId.get(comps.productionCycleId);
    if (!cycleRows) throw new Error("unregistered ProductionCycle component");

    for (const eid of [...cycleRows.keys()].sort((a, b) => a - b)) {
      const row = cycleRows.get(eid);
      if (!row) continue;
      const playerId = row[0]!;
      const recipe = recipeDefOf(recipeIdOfCode(row[1]!));
      const staffed = staffedByBuilding.get(eid) ?? false;
      const unlocked =
        gates.isRecipeUnlocked?.(recipe) ??
        isDefAgeUnlocked(world, comps, playerId, recipe.ageGate);

      // Idle → try starting (also fires on the completion tick right
      // after a finish below, keeping saturated lines on an exact
      // `recipe.ticks` cadence).
      if (row[2] === 0) {
        if (!unlocked) {
          diagnostics.gateBlockedTicks += 1;
          continue;
        }
        if (!staffed) {
          diagnostics.stalledMissingWorkerTicks += 1;
          continue;
        }
        if (!canDebitLedgerSlugs(world, comps, playerId, recipe.inputs)) {
          diagnostics.stalledMissingInputTicks += 1;
          continue;
        }
        startCycle(world, comps, diagnostics, eid, row, recipe);
        continue;
      }

      // In flight → advance one tick, but only while staffed; the
      // frozen remainingTicks are digest-visible stall evidence.
      if (!staffed) {
        diagnostics.stalledMissingWorkerTicks += 1;
        continue;
      }
      row[2] = row[2]! - 1;
      if (row[2] === 0)
        completeCycle(world, comps, diagnostics, eid, row, recipe);

      // Completion-tick restart attempt (inputs may have just freed up
      // or the previous check passed before the outputs landed).
      if (row[2] === 0 && unlocked) {
        if (canDebitLedgerSlugs(world, comps, playerId, recipe.inputs)) {
          startCycle(world, comps, diagnostics, eid, row, recipe);
        } else {
          diagnostics.stalledMissingInputTicks += 1;
        }
      }
    }
  };
}

/** Debit the full input list atomically and open the cycle. */
function startCycle(
  world: World,
  comps: SimComponents,
  diagnostics: ProductionDiagnostics,
  eid: number,
  row: number[],
  recipe: RecipeDefinition,
): void {
  debitLedgerSlugs(
    world,
    comps,
    row[0]!,
    recipe.inputs,
    `${recipe.id} production`,
  );
  for (const input of recipe.inputs) {
    const resourceCode = slugIndexIn(RESOURCE_SLUGS, input.defId);
    if (resourceCode !== undefined) {
      diagnostics.consumedByResource[resourceCode]! += input.qty;
    } else {
      const commodityCode = slugIndexIn(COMMODITY_SLUGS, input.defId)!;
      diagnostics.consumedByCommodity[commodityCode]! += input.qty;
    }
  }
  row[2] = recipe.ticks;
  diagnostics.cyclesStarted += 1;
}

/** Credit outputs (and meal events) on the completion tick. */
function completeCycle(
  world: World,
  comps: SimComponents,
  diagnostics: ProductionDiagnostics,
  eid: number,
  row: number[],
  recipe: RecipeDefinition,
): void {
  const { defId, qty } = recipe.output;
  const resourceCode = slugIndexIn(RESOURCE_SLUGS, defId);
  if (resourceCode !== undefined) {
    depositIntoStockpile(world, comps, row[0]!, resourceCode, qty);
    diagnostics.producedByResource[resourceCode]! += qty;
  } else {
    const commodityCode = slugIndexIn(COMMODITY_SLUGS, defId)!;
    depositCommodityIntoStockpile(world, comps, row[0]!, commodityCode, qty);
    diagnostics.producedByCommodity[commodityCode]! += qty;
    // Morale stub (SPEC §2.6 meals → M3 needs system): append a digest-
    // visible mealConsumed event instead of touching absent Pop rows.
    if (defId === "meals") {
      appendMealConsumedEvent(world, comps, eid, {
        tick: world.tick,
        qty,
      });
    }
  }
  diagnostics.cyclesCompleted += 1;
}

/** Apply one produce order: validate, select recipe, attach crafters. */
function applyProduceCommand(
  world: World,
  comps: SimComponents,
  diagnostics: ProductionDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseProduceData(data);
  const buildingRow = getBuildingRow(world, comps, parsed.buildingEid);
  if (!buildingRow) {
    throw new Error(
      `produce targets entity ${String(parsed.buildingEid)}, which has no finished Building row`,
    );
  }
  const defId = buildingIdOfCode(buildingRow[1]!);
  const options = recipesForBuilding(defId);
  if (options.length === 0) {
    throw new Error(`building ${defId} has no recipes to produce`);
  }
  const selected = parsed.recipeId
    ? options.find((recipe) => recipe.id === parsed.recipeId)
    : options[0];
  if (!selected) {
    throw new Error(
      `building ${defId} has no recipe ${JSON.stringify(parsed.recipeId)} (known: ${options.map((r) => r.id).join(", ")})`,
    );
  }
  const code = recipeCodeOf(selected.id);

  const existing = getProductionCycleRow(world, comps, parsed.buildingEid);
  if (existing && existing[2]! > 0 && existing[1] !== code) {
    throw new Error(
      `produce cannot switch ${defId} to ${selected.id} mid-cycle (${String(existing[2])} ticks remaining)`,
    );
  }
  if (!existing || existing[1] !== code) {
    setProductionCycleRow(
      world,
      comps,
      parsed.buildingEid,
      buildingRow[0]!,
      code,
      existing?.[2] ?? 0,
    );
  }

  const posRows = world.rowsByComponentId.get(comps.positionId);
  const velRows = world.rowsByComponentId.get(comps.velocityId);
  const tagRows = world.rowsByComponentId.get(comps.unitTagId);
  for (const eid of parsed.entityIds) {
    const posRow = posRows?.get(eid);
    const velRow = velRows?.get(eid);
    const tagRow = tagRows?.get(eid);
    if (!posRow || !velRow || !tagRow) continue; // not a live unit
    // Re-tasking replaces any prior job (AoE2 order semantics), exactly
    // like gather/build assignments.
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    writeActivityQueue(world, comps, eid, queue);
    assignProductionJob(world, comps, eid, parsed.buildingEid);
    resetSteeringBookkeeping(velRow);
  }
  diagnostics.commandsApplied += 1;
}
