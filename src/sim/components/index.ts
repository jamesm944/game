/**
 * Component definitions — SPEC §2.1/§2.2/§2.6.
 *
 * Components register through the world ComponentRegistry, whose
 * alphabetical enforcement pins the digest/save iteration order forever
 * (world.ts). Because the registry validates ONE strictly ascending
 * sequence per world, movement + economy + stockpile components
 * register interleaved via defineSimComponents:
 *
 *   ActivityQueue, AgeAdvanced, AgeResearch, AgeState, AssignedNode,
 *   AssignedSite, Building, BuildingSite, CarryCapacity, Combat,
 *   CombatEvents, CommodityStockpile, DropOff, Equipment, GateRejected,
 *   Identity, Inventory, JobCooldown, MealConsumed, MoveTarget, Needs,
 *   Owner, Position, ProductionCycle, ProductionJob, Relationship,
 *   ResearchedTechs, ResourceNode, Rubble, Skills, SocialEvents,
 *   Stockpile, TrainQueue, Traits, UnitTag, Velocity, VictoryCheck
 *
 * Per ADR-0001 the hand-rolled row store is the sanctioned M1 component
 * store — bitecs slots in behind this same registration surface later
 * without touching call sites or fixtures.
 *
 * Movement row layouts (arity is part of the digest contract):
 * - ActivityQueue (variable): encoded activity stream — see activities/.
 * - MoveTarget (2): final destination x,y in float tile coordinates.
 * - Position (2): current x,y float tile coordinates.
 * - UnitTag (3): [baseSpeed tiles/s, turnRate rad/s, radius tiles].
 * - Velocity (8): [headingRad, speedTilesPerSec, stalledTicks,
 *   parkedContactTicks, closeArrivalTicks, avoidSide, avoidTicksLeft,
 *   propagationParked] — motion state + steering FSM bookkeeping.
 * Economy/stockpile layouts live beside their modules (economy.ts,
 * core/stockpile.ts); combat rows beside theirs (combat.ts).
 */

import {
  decodeActivities,
  encodeActivities,
  type Activity,
} from "../activities";
import {
  AGE_COMPONENT_ARITIES,
  AGE_ADVANCED,
  AGE_RESEARCH,
  AGE_STATE,
  GATE_REJECTED,
  type AgeComponents,
} from "./age";
import {
  ASSIGNED_SITE,
  BUILDING,
  BUILDING_COMPONENT_ARITIES,
  BUILDING_SITE,
  RUBBLE,
  TRAIN_QUEUE,
  type BuildingComponents,
} from "./buildings";
import { BODY, BODY_ARITY, type BodyComponents } from "./body";
import {
  COMBAT_COMPONENT_ARITIES,
  COMBAT,
  COMBAT_EVENTS,
  RESEARCHED_TECHS,
  type CombatComponents,
} from "./combat";
import {
  ASSIGNED_NODE,
  CARRY_CAPACITY,
  INVENTORY,
  RESOURCE_NODE,
  type EconomyComponents,
} from "./economy";
import {
  EQUIPMENT_COMPONENT_ARITIES,
  EQUIPMENT,
  type EquipmentComponents,
} from "./equipment";
import {
  type BrainCooldownComponents,
  JOB_COOLDOWN,
  JOB_COOLDOWN_ARITY,
} from "./jobCooldown";
import {
  HOUSEHOLD,
  HOUSEHOLD_ARITY,
  type HouseholdComponents,
} from "./household";
import { attachOwner, OWNER, OWNER_ARITY, type OwnerComponents } from "./owner";
import {
  IDENTITY,
  IDENTITY_ARITY,
  TRAITS,
  TRAITS_ARITY,
  type PopComponents,
} from "./pop";
import {
  attachPopNeeds,
  NEEDS,
  NEEDS_ARITY,
  type NeedsComponents,
} from "./needs";
import {
  attachLessons,
  LESSONS,
  LESSONS_ARITY,
  type LessonComponents,
} from "./lessons";
import {
  attachPopMorale,
  MORALE,
  MORALE_ARITY,
  type MoraleComponents,
} from "./morale";
import {
  RELATIONSHIP,
  RELATIONSHIP_ARITY,
  type RelationshipComponents,
} from "./relationship";
import {
  attachPopSkills,
  SKILLS,
  SKILLS_ARITY,
  type SkillComponents,
} from "./skills";
import {
  SOCIAL_EVENTS,
  SOCIAL_EVENTS_ARITY,
  type SocialEventComponents,
} from "./socialEvents";
import {
  COMMODITY_STOCKPILE,
  DROP_OFF,
  STOCKPILE,
  type StockpileComponents,
} from "../core/stockpile";
import type { VictoryComponents } from "./victory";
import {
  MEAL_CONSUMED,
  PRODUCTION_COMPONENT_ARITIES,
  PRODUCTION_CYCLE,
  PRODUCTION_JOB,
  type ProductionComponents,
} from "./production";
import { defineComponent, spawnEntity, type World } from "../core/world";
import { attachPopIdentity } from "./pop";
import { attachBody } from "./body";
import { VICTORY_CHECK, VICTORY_COMPONENT_ARITIES } from "./victory";

export const ACTIVITY_QUEUE = "ActivityQueue" as const;
export const MOVE_TARGET = "MoveTarget" as const;
export const POSITION = "Position" as const;
export const UNIT_TAG = "UnitTag" as const;
export const VELOCITY = "Velocity" as const;

/** Row arity per movement component — pinned for digest stability. */
export const MOVEMENT_COMPONENT_ARITIES: readonly [string, number][] = [
  [ACTIVITY_QUEUE, -1], // variable-length encoded stream
  [MOVE_TARGET, 2],
  [POSITION, 2],
  [UNIT_TAG, 3],
  [VELOCITY, 8],
];

/** Owner registers between MoveTarget and Position (alphabetical). */
const OWNER_COMPONENT_ARITIES: readonly [string, number][] = [
  [OWNER, OWNER_ARITY],
];

/**
 * Every component family's arities in one table, in canonical registry
 * order — documentation of the digest contract, re-validated by the
 * registry's alphabetical enforcement at registration time. Identity/
 * Traits (pop.ts, M3-T1) register mid-sequence alphabetically:
 * Identity between GateRejected and Inventory, Traits between
 * TrainQueue and UnitTag. Skills (skills.ts, M3-T2) slots between
 * Rubble and Stockpile. JobCooldown (jobCooldown.ts) and Needs
 * (needs.ts, M3-T3) slot alphabetically between Inventory and
 * MealConsumed, and between MoveTarget and Owner, respectively.
 * Body (body.ts, M3-T4) slots before Building ("Bo" < "Bu").
 * Household (household.ts, M3-T5) slots between GateRejected and
 * Identity; Lessons (lessons.ts, M3-T5) between JobCooldown and
 * MealConsumed. Relationship (relationship.ts, M3-T7) slots between
 * ResearchedTechs and ResourceNode; SocialEvents (socialEvents.ts,
 * M3-T7) between Skills and Stockpile. Morale (morale.ts, M3-T9)
 * slots between MealConsumed and MoveTarget.
 */
export const SIM_COMPONENT_ARITIES: readonly [string, number][] = [
  ...MOVEMENT_COMPONENT_ARITIES,
  // M3-T3: Needs registers alphabetically between MoveTarget and Owner.
  [NEEDS, NEEDS_ARITY],
  ...OWNER_COMPONENT_ARITIES,
  ...AGE_COMPONENT_ARITIES,
  // M3-T4: Body registers alphabetically before Building.
  [BODY, BODY_ARITY],
  ...BUILDING_COMPONENT_ARITIES,
  // M3-T5: Household registers alphabetically after GateRejected
  // (which AGE_COMPONENT_ARITIES lists last) and before Identity.
  [HOUSEHOLD, HOUSEHOLD_ARITY],
  ...COMBAT_COMPONENT_ARITIES,
  // M3-T7: Relationship registers alphabetically between ProductionJob
  // (which PRODUCTION_COMPONENT_ARITIES lists last) and ResearchedTechs
  // (which COMBAT_COMPONENT_ARITIES lists).
  [RELATIONSHIP, RELATIONSHIP_ARITY],
  ...EQUIPMENT_COMPONENT_ARITIES,
  // M3-T3: JobCooldown registers alphabetically between Inventory
  // (economy.ts, not tabulated here) and MealConsumed below.
  [JOB_COOLDOWN, JOB_COOLDOWN_ARITY],
  // M3-T5: Lessons registers alphabetically between JobCooldown and
  // MealConsumed.
  [LESSONS, LESSONS_ARITY],
  ...PRODUCTION_COMPONENT_ARITIES,
  // M3-T9: Morale registers alphabetically between MealConsumed
  // (which PRODUCTION_COMPONENT_ARITIES lists first) and MoveTarget
  // (which MOVEMENT_COMPONENT_ARITIES lists).
  [MORALE, MORALE_ARITY],
  [IDENTITY, IDENTITY_ARITY],
  [SKILLS, SKILLS_ARITY],
  // M3-T7: SocialEvents registers alphabetically between Skills and
  // Stockpile (core/stockpile.ts, not tabulated here).
  [SOCIAL_EVENTS, SOCIAL_EVENTS_ARITY],
  [TRAITS, TRAITS_ARITY],
  ...VICTORY_COMPONENT_ARITIES,
];

export interface MovementComponents {
  readonly activityQueueId: number;
  readonly moveTargetId: number;
  readonly positionId: number;
  readonly unitTagId: number;
  readonly velocityId: number;
}

/** Every component id the M1/M2 sim reads/writes. */
export interface SimComponents
  extends
    MovementComponents,
    OwnerComponents,
    AgeComponents,
    EconomyComponents,
    StockpileComponents,
    BuildingComponents,
    BodyComponents,
    CombatComponents,
    EquipmentComponents,
    HouseholdComponents,
    ProductionComponents,
    BrainCooldownComponents,
    LessonComponents,
    NeedsComponents,
    MoraleComponents,
    PopComponents,
    RelationshipComponents,
    SkillComponents,
    SocialEventComponents,
    VictoryComponents {}

/**
 * Register ALL sim components in one strictly alphabetical sequence —
 * the registry re-validates order and would throw on any regression.
 * The single canonical entry point for production worlds AND fixtures.
 */
export function defineSimComponents(world: World): SimComponents {
  return {
    activityQueueId: defineComponent(world, ACTIVITY_QUEUE),
    ageAdvancedId: defineComponent(world, AGE_ADVANCED),
    ageResearchId: defineComponent(world, AGE_RESEARCH),
    ageStateId: defineComponent(world, AGE_STATE),
    assignedNodeId: defineComponent(world, ASSIGNED_NODE),
    assignedSiteId: defineComponent(world, ASSIGNED_SITE),
    bodyId: defineComponent(world, BODY),
    buildingId: defineComponent(world, BUILDING),
    buildingSiteId: defineComponent(world, BUILDING_SITE),
    carryCapacityId: defineComponent(world, CARRY_CAPACITY),
    combatId: defineComponent(world, COMBAT),
    combatEventsId: defineComponent(world, COMBAT_EVENTS),
    commodityStockpileId: defineComponent(world, COMMODITY_STOCKPILE),
    dropoffId: defineComponent(world, DROP_OFF),
    equipmentId: defineComponent(world, EQUIPMENT),
    gateRejectedId: defineComponent(world, GATE_REJECTED),
    // M3-T5: Household registers alphabetically between GateRejected
    // and Identity.
    householdId: defineComponent(world, HOUSEHOLD),
    identityId: defineComponent(world, IDENTITY),
    inventoryId: defineComponent(world, INVENTORY),
    jobCooldownId: defineComponent(world, JOB_COOLDOWN),
    // M3-T5: Lessons registers alphabetically between JobCooldown and
    // MealConsumed.
    lessonsId: defineComponent(world, LESSONS),
    mealConsumedId: defineComponent(world, MEAL_CONSUMED),
    // M3-T9: Morale registers alphabetically between MealConsumed and
    // MoveTarget.
    moraleId: defineComponent(world, MORALE),
    moveTargetId: defineComponent(world, MOVE_TARGET),
    needsId: defineComponent(world, NEEDS),
    ownerId: defineComponent(world, OWNER),
    positionId: defineComponent(world, POSITION),
    productionCycleId: defineComponent(world, PRODUCTION_CYCLE),
    productionJobId: defineComponent(world, PRODUCTION_JOB),
    // M3-T7: Relationship registers alphabetically before ResearchedTechs
    // ("Rel" < "Res") and after ProductionJob.
    relationshipId: defineComponent(world, RELATIONSHIP),
    researchedTechsId: defineComponent(world, RESEARCHED_TECHS),
    resourceNodeId: defineComponent(world, RESOURCE_NODE),
    rubbleId: defineComponent(world, RUBBLE),
    skillsId: defineComponent(world, SKILLS),
    // M3-T7: SocialEvents registers alphabetically between Skills and
    // Stockpile.
    socialEventsId: defineComponent(world, SOCIAL_EVENTS),
    stockpileId: defineComponent(world, STOCKPILE),
    trainQueueId: defineComponent(world, TRAIN_QUEUE),
    traitsId: defineComponent(world, TRAITS),
    unitTagId: defineComponent(world, UNIT_TAG),
    velocityId: defineComponent(world, VELOCITY),
    victoryCheckId: defineComponent(world, VICTORY_CHECK),
  };
}

/**
 * Legacy movement-only alias. Registers the full set (the registry has
 * no partial sequences) and returns it — structurally a superset of
 * MovementComponents, so existing call sites keep compiling unchanged.
 */
export function defineMovementComponents(world: World): SimComponents {
  return defineSimComponents(world);
}

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

export function getPosition(
  world: World,
  comps: MovementComponents,
  eid: number,
): { x: number; y: number } {
  const row = requireRow(world, comps.positionId, eid, POSITION);
  return { x: row[0]!, y: row[1]! };
}

export function setPosition(
  world: World,
  comps: MovementComponents,
  eid: number,
  x: number,
  y: number,
): void {
  const row = requireRow(world, comps.positionId, eid, POSITION);
  row[0] = x;
  row[1] = y;
}

export function getVelocityRow(
  world: World,
  comps: MovementComponents,
  eid: number,
): number[] {
  return requireRow(world, comps.velocityId, eid, VELOCITY);
}

export function getUnitTagRow(
  world: World,
  comps: MovementComponents,
  eid: number,
): number[] {
  return requireRow(world, comps.unitTagId, eid, UNIT_TAG);
}

/** Final destination of the active order (MoveTarget row). */
export function getMoveTarget(
  world: World,
  comps: MovementComponents,
  eid: number,
): { x: number; y: number } | undefined {
  const row = world.rowsByComponentId.get(comps.moveTargetId)?.get(eid);
  if (!row) return undefined;
  return { x: row[0]!, y: row[1]! };
}

export function setMoveTarget(
  world: World,
  comps: MovementComponents,
  eid: number,
  x: number,
  y: number,
): void {
  requireRow(world, comps.moveTargetId, eid, MOVE_TARGET);
  setComponentValuesById(world, comps.moveTargetId, eid, [x, y]);
}

/** Decoded activity queue for one entity (fresh copy each call). */
export function readActivityQueue(
  world: World,
  comps: MovementComponents,
  eid: number,
): Activity[] {
  const row = world.rowsByComponentId.get(comps.activityQueueId)?.get(eid);
  if (!row) return [];
  return decodeActivities(row);
}

export function writeActivityQueue(
  world: World,
  comps: MovementComponents,
  eid: number,
  queue: readonly Activity[],
): void {
  requireRow(world, comps.activityQueueId, eid, ACTIVITY_QUEUE);
  setComponentValuesById(
    world,
    comps.activityQueueId,
    eid,
    encodeActivities(queue),
  );
}

function setComponentValuesById(
  world: World,
  componentId: number,
  eid: number,
  values: readonly number[],
): void {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows)
    throw new Error(`unregistered component id: ${String(componentId)}`);
  rows.set(eid, [...values]);
}

export interface SpawnUnitOptions {
  /** Base cruise speed in tiles per second (M1 default 1.0). */
  readonly baseSpeed?: number | undefined;
  /** Individual turn rate in rad/s; defaults to a seed+eid hash in [5.5, 8.5]. */
  readonly turnRate?: number | undefined;
  /** Body radius in tiles used by separation/push-apart. */
  readonly radius?: number | undefined;
  /**
   * Owning player (M2-T9). Non-zero owners stamp an explicit Owner row
   * so two-player worlds can attribute population; player zero stays
   * rowless (the documented legacy default) and every existing fixture
   * digest is untouched.
   */
  readonly ownerId?: number | undefined;
  /**
   * Attach Identity + Traits + Skills + Needs + Lessons rows (M3-T1/T2/
   * T3/T5): named Pops with seeded conflict-free trait rolls, a novice
   * skill sheet, full needs meters and a blank school record on their
   * own (seed, eid) streams. Wired at the villager spawn sites —
   * training completions, AI bootstrap and skirmish starts; movement-
   * only fixtures stay rowless.
   */
  readonly identity?: boolean | undefined;
  /**
   * Lifecycle origin stamped into the Identity row (M3-T5): the default
   * POP_ORIGIN_ARRIVAL enters the Pop as a working adult; households.ts
   * births pass POP_ORIGIN_BIRTH so the child→adult→elder arc runs from
   * birthTick.
   */
  readonly origin?: number | undefined;
  /**
   * Attach a Body row (M3-T4): the six-part wound model that combat
   * strikes allocate against. Deliberately opt-in — golden fixtures
   * that pin pre-M3-T4 digests keep spawning bodyless Pops.
   */
  readonly body?: boolean | undefined;
  /**
   * Attach a Morale row (M3-T9): the routing state that combat morale
   * shocks drive (break → flee → rally). Opt-in like `body` — golden
   * fixtures pinning pre-M3-T9 digests stay byte-identical. Meaningful
   * only alongside a Needs row: the meter it reads lives there.
   */
  readonly morale?: boolean | undefined;
}

/** Default M1 unit speed — SPEC ticket: 1.0 tile/sec constant. */
export const DEFAULT_UNIT_SPEED = 1.0;

/** Turn-rate personality band ported from the validated prototype feel. */
export const TURN_RATE_MIN = 5.5;
export const TURN_RATE_VARIANCE = 3.0; // → individual rates in [5.5, 8.5]

const TURN_RATE_HASH_MULTIPLIER = 0x9e3779b9;

function defaultTurnRate(seed: number, eid: number): number {
  // Pure function of (seed, eid): no shared-stream coupling at spawn.
  let z = (seed ^ Math.imul(eid, TURN_RATE_HASH_MULTIPLIER)) >>> 0 || 0x1;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  const unit = ((z ^ (z >>> 15)) >>> 0) / 0x100000000;
  return TURN_RATE_MIN + unit * TURN_RATE_VARIANCE;
}

/** Spawn one movable Pop with every movement component attached. */
export function spawnUnit(
  world: World,
  comps: MovementComponents &
    Partial<Pick<OwnerComponents, "ownerId">> &
    Partial<
      Pick<PopComponents, "identityId" | "traitsId"> &
        Pick<SkillComponents, "skillsId"> &
        Pick<NeedsComponents, "needsId"> &
        Pick<LessonComponents, "lessonsId"> &
        Pick<BodyComponents, "bodyId"> &
        Pick<MoraleComponents, "moraleId">
    >,
  x: number,
  y: number,
  options: SpawnUnitOptions = {},
): number {
  const eid = spawnEntity(world);
  const rows = (id: number, values: number[]): void => {
    setComponentValuesById(world, id, eid, values);
  };
  rows(comps.positionId, [x, y]);
  // heading east (0 rad), idle; FSM counters zeroed; no committed side.
  rows(comps.velocityId, [0, 0, 0, 0, 0, 0, 0, 0]);
  rows(comps.unitTagId, [
    options.baseSpeed ?? DEFAULT_UNIT_SPEED,
    options.turnRate ?? defaultTurnRate(world.seed, eid),
    options.radius ?? DEFAULT_UNIT_RADIUS,
  ]);
  rows(comps.moveTargetId, [x, y]);
  rows(comps.activityQueueId, encodeActivities([]));
  if (options.ownerId !== undefined && comps.ownerId !== undefined) {
    attachOwner(world, comps as OwnerComponents, eid, options.ownerId);
  }
  if (
    options.identity === true &&
    comps.identityId !== undefined &&
    comps.traitsId !== undefined
  ) {
    attachPopIdentity(
      world,
      comps as Pick<PopComponents, "identityId" | "traitsId">,
      eid,
      {
        origin: options.origin,
      },
    );
    if (typeof comps.skillsId === "number") {
      // M3-T2: every named Pop carries a (novice) skill sheet; work and
      // combat awards grow it, the rare-tick rust pass decays it.
      attachPopSkills(world, comps as SkillComponents, eid);
    }
    if (typeof comps.needsId === "number") {
      // M3-T3: every named Pop carries full food/rest/morale meters;
      // the rare-tick decay pass and eat chains own them from here.
      attachPopNeeds(world, comps as NeedsComponents, eid);
    }
    if (typeof comps.lessonsId === "number") {
      // M3-T5: every named Pop carries a blank school record; the
      // lesson windows stamp attendance for graduation credit.
      attachLessons(world, comps as LessonComponents, eid);
    }
    if (options.body === true && typeof comps.bodyId === "number") {
      // M3-T4: the six-part wound model combat strikes allocate
      // against; empty at spawn, healed/scarring/deadly over time.
      attachBody(world, comps as BodyComponents, eid);
    }
    if (options.morale === true && typeof comps.moraleId === "number") {
      // M3-T9: the routing state combat morale shocks drive; steady at
      // spawn, broken into flight by systems/morale.ts.
      attachPopMorale(world, comps as MoraleComponents, eid);
    }
  }
  // Fog dirty mark (SPEC §2.9): stamped into its owner's sight planes
  // at the next tick-boundary flush.
  world.visibility.markDirty("spawned", eid);
  return eid;
}

/** Default body radius in tiles (units keep ≥ 0.5-tile clearance). */
export const DEFAULT_UNIT_RADIUS = 0.25;

export * from "./economy";
export * from "./owner";
export * from "./age";
export * from "./body";
export * from "./buildings";
export * from "./combat";
export * from "./equipment";
export * from "./household";
export * from "./jobCooldown";
export * from "./lessons";
export * from "./morale";
export * from "./needs";
export * from "./production";
export * from "./pop";
export * from "./skills";
