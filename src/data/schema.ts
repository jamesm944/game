/**
 * Entity-definition schemas — SPEC §3.
 *
 * Zod schemas are the single source of truth; TS types come from
 * z.infer. Definitions live as JSON under
 * src/data/definitions/{units,buildings,techs,recipes}/ and load with
 * the Factorio three-round discipline: parse all → validate all → fail
 * loudly listing every error. M1-T7 added the schemas; M1-T10 lands
 * the first building content (town-center/house/barracks) plus the
 * villager unit they produce and consume.
 */

import { z } from "zod";

export const KIND = z.enum(["unit", "building", "tech", "recipe"]);

/** Gatherable resource slugs usable in drop-off filters (SPEC §2.6). */
export const RESOURCE_SLUGS = ["food", "wood", "gold", "stone"] as const;
export const resourceSlugSchema = z.enum(RESOURCE_SLUGS);

/** Resource costs keyed by gatherable slug (SPEC §2.6). */
const costsSchema = z.record(z.string(), z.number().int().nonnegative());

const commonFields = {
  id: z.string().regex(/^[a-z0-9-]+$/, "stable slug"),
  name: z.string().min(1),
  kind: KIND,
  costs: costsSchema,
  ageGate: z.number().int().min(1).max(4),
  techPrereqs: z.array(z.string()),
};

export const unitSchema = z.object({
  ...commonFields,
  trainTime: z.number().int().positive(),
  hp: z.number().int().positive(),
  /** Cruise speed in tiles per second. */
  speed: z.number().positive(),
  carryCapacity: z.number().int().nonnegative(),
  attack: z.number().int().nonnegative(),
  armorClasses: z.array(z.string()).min(1),
  attackBonuses: z.array(
    z.object({ armorClass: z.string(), mult: z.number().positive() }),
  ),
  sightRadius: z.number().positive(),
  equipmentSlots: z.array(z.string()).default([]),
  /**
   * Banished-style work presentation (SPEC §2.14): activity → baked
   * clip id, e.g. { "gather-wood": "chop", "idle": "idle" }. Optional
   * until the M2 definitions fill it in.
   */
  activityAnims: z.record(z.string(), z.string()).optional(),
  /** Asset-manifest id of the prop shown in-hand during matching activities. */
  toolProp: z.string().optional(),
  /** Asset-manifest id of the visible carried cargo while returning. */
  cargoProp: z.string().optional(),
});

/**
 * Building footprint in whole tiles (SPEC §3): `width × height` tiles
 * starting at the placement origin, growing +x/+y.
 */
export const footprintSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** One trainable unit entry inside a production building's queue config. */
const trainQueueEntrySchema = z.object({ unitId: z.string().min(1) });

/** Production-queue configuration (SPEC §2.13 rally/train UX). */
export const trainQueueSchema = z.object({
  /** Maximum queued entries (AoE2-style finite production bar). */
  capacity: z.number().int().positive(),
  /** Unit definition ids this building may train, in menu order. */
  trainable: z.array(trainQueueEntrySchema).min(1),
});

export const buildingSchema = z.object({
  ...commonFields,
  buildTime: z.number().int().positive(),
  footprint: footprintSchema,
  hp: z.number().int().positive(),
  /** Simultaneous worker seats for production/processing (M4 foremen). */
  workSlots: z.number().int().nonnegative(),
  /** Resource slugs accepted at this drop-off point (SPEC §2.6). */
  dropoffFilters: z.array(resourceSlugSchema),
  /** Labor roles this workplace accepts (M4 delegated management). */
  acceptsRoles: z.array(z.string()),
  sightRadius: z.number().positive(),
  /** Population-cap slots granted on completion (0 = none). */
  populationCap: z.number().int().nonnegative(),
  /** Present only on production buildings (M1: town-center). */
  trainQueue: trainQueueSchema.optional(),
  /** Asset refs per evolution stage (SPEC §3); stub until M2 art tickets. */
  ageStages: z.array(z.string()).optional(),
});

export type BuildingDefinition = z.infer<typeof buildingSchema>;

/** Stat-modifier effect descriptor à la OpenRA conditions (SPEC §3). */
const techEffectSchema = z.object({
  target: z.string().min(1),
  stat: z.string().min(1),
  mult: z.number().positive(),
});

export const techSchema = z.object({
  ...commonFields,
  researchTime: z.number().int().positive(),
  effects: z.array(techEffectSchema).min(1),
});

export type TechDefinition = z.infer<typeof techSchema>;

const recipeIO = z.object({
  defId: z.string().min(1),
  qty: z.number().int().positive(),
});

export const recipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "stable slug"),
  name: z.string().min(1),
  kind: z.literal("recipe"),
  costs: costsSchema,
  ageGate: z.number().int().min(1).max(4),
  techPrereqs: z.array(z.string()),
  buildingId: z.string().min(1),
  inputs: z.array(recipeIO).min(1),
  output: recipeIO,
  ticks: z.number().int().positive(),
  techGate: z.string().optional(),
});

export type RecipeDefinition = z.infer<typeof recipeSchema>;

export type UnitDefinition = z.infer<typeof unitSchema>;
