/**
 * Delegated-management components — SPEC §2.7 / M4-T1 (issue #56).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). The five M4-T1 names slot
 * into that sequence without disturbing any existing neighbor:
 * Equipment < Foreman < GateRejected; Lessons < ManagementSkill <
 * Manager < MealConsumed; Needs < OrderLock < Owner; Stockpile <
 * StrategySliders < TrainQueue.
 *
 * Canonical row layouts (arity is part of the digest contract):
 * - Foreman (2): [foremanPopEid, appointedTick] — attached to a
 *   FINISHED workplace BUILDING. Row present ⇔ a foreman serves there;
 *   dismissal deletes it. The building side is the natural home: the
 *   appointment panel reads exactly this row.
 * - ManagementSkill (1): [totalXp] — one per Pop, created lazily on
 *   first service. XP grows ONLY while serving as foreman/manager;
 *   levels derive on read through the shared DF curve (data/skills.ts),
 *   so no threshold bookkeeping rides the row. Deliberately NOT a
 *   Skills-row entry: appending a slug would shift the school subject
 *   rotation and re-number melee/ranged codes, re-keying every pinned
 *   digest — the isolated row keeps M4 byte-compatible with M3.
 * - Manager (2): [domainCode, appointedTick] — attached to the manager
 *   POP. One manager per (owner, domain), validated by the system.
 * - OrderLock (3): [lockedTick, orderKindCode, activatedFlag] —
 *   attached to a Pop the instant a DIRECT (non-delegated) labor order
 *   employs them; removed when the ordered activity completes or is
 *   cancelled. Delegation never touches locked Pops — the override
 *   rule made state. Transit orders (move/attack) raise activatedFlag
 *   once their activity queue fills: group routes enqueue only after
 *   the leader path applies (ADR-0003 latency window), so an unactivated
 *   lock is a route still in flight, not a finished one.
 * - StrategySliders (variable): [entryCount, w₀, w₁, …] — the player-
 *   set weights a domain manager obeys, entry k applying to that
 *   domain's ascending-eid k-th workplace. Missing entries default to
 *   weight 1 at use; the manager Pop carries the row so dismissing the
 *   manager discards the brief with them.
 *
 * Domains are the SPEC §2.7 five: Food / Wood / Stone·Clay / Metal /
 * Crafted goods, coded 0–4 in that order. Workplace→domain mapping and
 * the per-domain craft skill live beside the codes as pure data.
 */

import { levelOfTotalXp } from "../data/skills";
import type { ComponentRows, World } from "../core/world";

export const FOREMAN = "Foreman" as const;
export const MANAGEMENT_SKILL = "ManagementSkill" as const;
export const MANAGER = "Manager" as const;
export const ORDER_LOCK = "OrderLock" as const;
export const STRATEGY_SLIDERS = "StrategySliders" as const;

/** Row arity per management component — pinned for digest stability. */
export const FOREMAN_ARITY = 2;
export const MANAGEMENT_SKILL_ARITY = 1;
export const MANAGER_ARITY = 2;
export const ORDER_LOCK_ARITY = 3;
export const STRATEGY_SLIDERS_ARITY = -1; // count-led weight vector

/** Component ids the management systems read/write. */
export interface ManagementComponents {
  readonly foremanId: number;
  readonly managementSkillId: number;
  readonly managerId: number;
  readonly orderLockId: number;
  readonly strategySlidersId: number;
}

// ---- Domains (SPEC §2.7) ------------------------------------------------------

export const DOMAIN_FOOD = 0;
export const DOMAIN_WOOD = 1;
export const DOMAIN_STONE_CLAY = 2;
export const DOMAIN_METAL = 3;
export const DOMAIN_CRAFTED = 4;
export const DOMAIN_COUNT = 5;

/** Human-readable domain slugs indexed by domain code. */
export const DOMAIN_NAMES: readonly string[] = [
  "food",
  "wood",
  "stoneClay",
  "metal",
  "crafted",
];

export function requireDomainCode(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code >= DOMAIN_COUNT) {
    throw new Error(`unknown domain code: ${String(code)}`);
  }
  return code;
}

/**
 * Workplace→domain map over building definition ids. A workplace is a
 * production building (workSlots > 0); the mapping follows each
 * building's PRIMARY OUTPUT so every recipe line belongs to exactly
 * one domain: meals→food, planks→wood, bricks→stone·clay,
 * tools→metal, weapons/armor→crafted. Farm/lumber-camp/mining-camp
 * cluster into their resource domains ahead of their M4 farm-cycle
 * tickets.
 */
const BUILDING_DOMAINS: Readonly<Record<string, number>> = {
  kitchen: DOMAIN_FOOD,
  farm: DOMAIN_FOOD,
  "lumber-camp": DOMAIN_WOOD,
  sawpit: DOMAIN_WOOD,
  kiln: DOMAIN_STONE_CLAY,
  "mining-camp": DOMAIN_METAL,
  smithy: DOMAIN_METAL,
  forge: DOMAIN_CRAFTED,
};

/** Domain of one workplace building definition, or undefined. */
export function domainOfBuildingDef(defId: string): number | undefined {
  return BUILDING_DOMAINS[defId];
}

/**
 * The RELEVANT CRAFT SKILL §2.7 folds into a candidate's rating:
 * raw-resource domains rate gathering, crafted goods rate
 * construction. Skill slugs come from data/skills.ts.
 */
export function craftSkillOfDomain(domain: number): string {
  requireDomainCode(domain);
  return domain === DOMAIN_CRAFTED ? "construction" : "gathering";
}

// ---- Order-lock kinds -----------------------------------------------------------

/**
 * Direct-order kinds the management system recognizes. LABOR orders
 * hold their lock while an assignment row lives (gather/build/produce
 * chains auto-repeat, so the standing order outlives individual chain
 * legs); TRANSIT orders hold it while the activity queue is non-empty.
 */
export const ORDER_KIND_GATHER = 0;
export const ORDER_KIND_BUILD = 1;
export const ORDER_KIND_PRODUCE = 2;
export const ORDER_KIND_MOVE = 3;
export const ORDER_KIND_ATTACK = 4;

/** True when `kind` holds its lock through a live assignment row. */
export function orderKindIsLabor(kind: number): boolean {
  return (
    kind === ORDER_KIND_GATHER ||
    kind === ORDER_KIND_BUILD ||
    kind === ORDER_KIND_PRODUCE
  );
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

// ---- Foreman --------------------------------------------------------------------

/** Attach/replace the Foreman row on a workplace building. */
export function setForemanRow(
  world: World,
  comps: Pick<ManagementComponents, "foremanId">,
  buildingEid: number,
  foremanPopEid: number,
  tick: number,
): void {
  requireRows(world, comps.foremanId).set(buildingEid, [foremanPopEid, tick]);
}

/** Live Foreman row for a workplace, or undefined unappointed. */
export function foremanRowOf(
  world: World,
  comps: Pick<ManagementComponents, "foremanId">,
  buildingEid: number,
): { foremanPopEid: number; appointedTick: number } | undefined {
  const row = world.rowsByComponentId.get(comps.foremanId)?.get(buildingEid);
  if (!row) return undefined;
  return { foremanPopEid: row[0]!, appointedTick: row[1]! };
}

export function clearForemanRow(
  world: World,
  comps: Pick<ManagementComponents, "foremanId">,
  buildingEid: number,
): boolean {
  return (
    world.rowsByComponentId.get(comps.foremanId)?.delete(buildingEid) ?? false
  );
}

// ---- ManagementSkill --------------------------------------------------------------

/** Total management XP of one Pop, or undefined before first service. */
export function managementXpOf(
  world: World,
  comps: Pick<ManagementComponents, "managementSkillId">,
  eid: number,
): number | undefined {
  return world.rowsByComponentId.get(comps.managementSkillId)?.get(eid)?.[0];
}

/** Derived management level through the shared DF curve (rowless ⇒ 0). */
export function managementLevelOf(
  world: World,
  comps: Pick<ManagementComponents, "managementSkillId">,
  eid: number,
): number {
  return levelOfTotalXp(managementXpOf(world, comps, eid) ?? 0);
}

/** Live (mutable) ManagementSkill row for `eid`, creating it when absent. */
export function ensureManagementSkillRow(
  world: World,
  comps: Pick<ManagementComponents, "managementSkillId">,
  eid: number,
): number[] {
  const rows = requireRows(world, comps.managementSkillId);
  let row = rows.get(eid);
  if (!row) {
    row = [0];
    rows.set(eid, row);
  }
  return row;
}

// ---- Manager -----------------------------------------------------------------------

/** Attach/replace the Manager row on a Pop. */
export function setManagerRow(
  world: World,
  comps: Pick<ManagementComponents, "managerId">,
  popEid: number,
  domain: number,
  tick: number,
): void {
  requireDomainCode(domain);
  requireRows(world, comps.managerId).set(popEid, [domain, tick]);
}

/** Live Manager row for a Pop, or undefined. */
export function managerRowOf(
  world: World,
  comps: Pick<ManagementComponents, "managerId">,
  popEid: number,
): { domain: number; appointedTick: number } | undefined {
  const row = world.rowsByComponentId.get(comps.managerId)?.get(popEid);
  if (!row) return undefined;
  return { domain: row[0]!, appointedTick: row[1]! };
}

export function clearManagerRow(
  world: World,
  comps: Pick<ManagementComponents, "managerId">,
  popEid: number,
): boolean {
  return world.rowsByComponentId.get(comps.managerId)?.delete(popEid) ?? false;
}

// ---- OrderLock ------------------------------------------------------------------------

/** Stamp/refresh the direct-order lock on one Pop (unactivated). */
export function stampOrderLock(
  world: World,
  comps: Pick<ManagementComponents, "orderLockId">,
  popEid: number,
  tick: number,
  orderKind: number,
): void {
  requireRows(world, comps.orderLockId).set(popEid, [tick, orderKind, 0]);
}

/** Live OrderLock row for a Pop, or undefined unlocked. */
export interface OrderLockRow {
  readonly lockedTick: number;
  readonly orderKind: number;
  /** 1 once the ordered activity actually entered the Pop's queue. */
  readonly activated: boolean;
}

export function orderLockOf(
  world: World,
  comps: Pick<ManagementComponents, "orderLockId">,
  popEid: number,
): OrderLockRow | undefined {
  const row = world.rowsByComponentId.get(comps.orderLockId)?.get(popEid);
  if (!row) return undefined;
  return {
    lockedTick: row[0]!,
    orderKind: row[1]!,
    activated: row[2] === 1,
  };
}

export function clearOrderLock(
  world: World,
  comps: Pick<ManagementComponents, "orderLockId">,
  popEid: number,
): boolean {
  return (
    world.rowsByComponentId.get(comps.orderLockId)?.delete(popEid) ?? false
  );
}

// ---- StrategySliders ---------------------------------------------------------------------

/** Overwrite one manager's weight vector (values ≥ 0, finite). */
export function setStrategyWeights(
  world: World,
  comps: Pick<ManagementComponents, "strategySlidersId">,
  managerPopEid: number,
  weights: readonly number[],
): void {
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `strategy weights must be finite and non-negative, got ${String(weight)}`,
      );
    }
  }
  requireRows(world, comps.strategySlidersId).set(managerPopEid, [
    weights.length,
    ...weights,
  ]);
}

/**
 * Decoded copy of one manager's weight vector, or undefined when the
 * brief carries none yet (callers default every workplace to 1).
 */
export function strategyWeightsOf(
  world: World,
  comps: Pick<ManagementComponents, "strategySlidersId">,
  managerPopEid: number,
): number[] | undefined {
  const row = world.rowsByComponentId
    .get(comps.strategySlidersId)
    ?.get(managerPopEid);
  if (!row) return undefined;
  return row.slice(1, 1 + row[0]!);
}

export function clearStrategyWeights(
  world: World,
  comps: Pick<ManagementComponents, "strategySlidersId">,
  managerPopEid: number,
): boolean {
  return (
    world.rowsByComponentId
      .get(comps.strategySlidersId)
      ?.delete(managerPopEid) ?? false
  );
}
