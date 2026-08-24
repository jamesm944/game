/**
 * Entity-definition schemas — SPEC §3.
 *
 * Zod schemas are the single source of truth; TS types come from
 * z.infer. Definitions live as JSON under
 * src/data/definitions/{units,buildings,techs,recipes}/ and load with
 * the Factorio three-round discipline (see ./load.ts): parse all →
 * validate all → fail loudly listing EVERY error. M2-T1 grew the M1
 * stubs into the full kind set: age gates became the dark|feudal|
 * castle|imperial slug enum, gatherables expanded to the seven §2.6
 * slugs, armor classes got their §2.5 canonical table, and techs gained
 * age advances plus mult/add effect descriptors.
 */

import { z } from "zod";

export const KIND = z.enum(["unit", "building", "tech", "recipe"]);

/** Age names used by every `ageGate` field (SPEC §3). */
export const AGES = ["dark", "feudal", "castle", "imperial"] as const;
export const ageGateSchema = z.enum(AGES);
export type AgeName = (typeof AGES)[number];

/** Numeric rank per age — how sim code compares gates against progress. */
export const AGE_RANK: Readonly<Record<AgeName, number>> = {
  dark: 1,
  feudal: 2,
  castle: 3,
  imperial: 4,
};

/**
 * Gatherable resource slugs (SPEC §2.6): the M1 base four plus the M2
 * Iron/Coal/Clay set. ARRAY ORDER IS THE SIM RESOURCE CODE ORDER —
 * economy.ts pins codes 0–6 against it, so never reorder.
 */
export const RESOURCE_SLUGS = [
  "food",
  "wood",
  "gold",
  "stone",
  "iron",
  "coal",
  "clay",
] as const;
export const resourceSlugSchema = z.enum(RESOURCE_SLUGS);

/**
 * Depth-1 commodities producible by recipes (SPEC §2.6 table). Recipes
 * may reference these as INPUTS in the schema, but v1 content blocks
 * commodity-on-commodity chains (loader round 3 enforces the depth-1
 * hard rule).
 */
export const COMMODITY_SLUGS = [
  "planks",
  "bricks",
  "tools",
  "weapons",
  "armor",
  "meals",
] as const;
export const commoditySlugSchema = z.enum(COMMODITY_SLUGS);

/**
 * Canonical armor classes (SPEC §2.5 counter table): the eight combat
 * classes plus the two soft tags already carried by content. Attack
 * bonuses may ONLY reference these ids — loader round 3 checks refs.
 */
export const ARMOR_CLASSES = [
  "infantry",
  "cavalry",
  "archer",
  "siege",
  "building",
  "ship",
  "monastery",
  "camel",
  "civilian",
  "monk",
] as const;
export type ArmorClass = (typeof ARMOR_CLASSES)[number];

/**
 * Attack reach of default-fisted/melee units in tiles (center-to-center),
 * and the schema default for `range` (SPEC §2.5 / M2-T5).
 */
export const MELEE_RANGE = 0.5;
/** Schema default for `reloadTicks`: 2 s between strikes at 30 Hz. */
export const DEFAULT_RELOAD_TICKS = 60;

/** Resource costs keyed by gatherable slug (SPEC §2.6). */
const costsSchema = z.record(z.string(), z.number().int().nonnegative());

const commonFields = {
  id: z.string().regex(/^[a-z0-9-]+$/, "stable slug"),
  name: z.string().min(1),
  costs: costsSchema,
  ageGate: ageGateSchema,
  techPrereqs: z.array(z.string()),
};

export const unitSchema = z.object({
  ...commonFields,
  kind: z.literal("unit"),
  trainTime: z.number().int().positive(),
  hp: z.number().int().positive(),
  /** Cruise speed in tiles per second. */
  speed: z.number().positive(),
  carryCapacity: z.number().int().nonnegative(),
  attack: z.number().int().nonnegative(),
  /**
   * Attack reach in tiles (center-to-center). Omitted = melee, striking
   * from MELEE_RANGE (0.5); ranged content declares its own range.
   */
  range: z.number().positive().default(MELEE_RANGE),
  /** Ticks between strikes; omitted = DEFAULT_RELOAD_TICKS. */
  reloadTicks: z.number().int().positive().default(DEFAULT_RELOAD_TICKS),
  armorClasses: z.array(z.string()).min(1),
  attackBonuses: z
    .array(z.object({ armorClass: z.string(), mult: z.number().positive() }))
    .default([]),
  sightRadius: z.number().positive(),
  equipmentSlots: z.array(z.string()).default([]),
  /**
   * Banished-style work presentation (SPEC §2.14): activity → baked
   * clip id, e.g. { "gather-wood": "chop", "idle": "idle" }. Optional
   * until the art tickets fill it in.
   */
  activityAnims: z.record(z.string(), z.string()).optional(),
  /** Asset-manifest id of the prop shown in-hand during matching activities. */
  toolProp: z.string().optional(),
  /** Asset-manifest id of the visible carried cargo while returning. */
  cargoProp: z.string().optional(),
});

export type UnitDefinition = z.infer<typeof unitSchema>;

/**
 * Building footprint in whole tiles (SPEC §3): `width × height` tiles
 * starting at the placement origin, growing +x/+y.
 */
export const footprintSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * §2.11 victory-path role carried by a building definition (M4-T4). All
 * thresholds/rates live in Entity-definition JSON (SPEC §2.11), so the
 * completing-act buildings declare their sustain gate here and the
 * generator buildings their yield — the evaluators read these tables,
 * never hardcoded numbers.
 */
export const victoryRoleSchema = z
  .object({
    /** Which §2.11 path this building serves. */
    path: z.enum(["knowledge", "culture"]),
    /**
     * Completing-act buildings only: minimum sustained metric per sim
     * minute that must hold for holdTicks to win the path.
     */
    sustainPerMin: z.number().int().positive().optional(),
    /** Completing-act buildings only: required sustained hold, in ticks. */
    holdTicks: z.number().int().positive().optional(),
    /** School generator: knowledge points credited per lesson × teacher level. */
    knowledgePerLesson: z.number().int().nonnegative().optional(),
    /** Monument generator: ongoing prestige income per sim minute. */
    prestigePerMin: z.number().int().nonnegative().optional(),
    /** Monument generator: festival resource costs (gatherable slugs). */
    festivalCosts: costsSchema.optional(),
    /** Monument generator: prestige burst credited when a festival is hosted. */
    festivalPrestige: z.number().int().nonnegative().optional(),
  })
  .superRefine((role, ctx) => {
    const sustaining = role.sustainPerMin !== undefined;
    const timed = role.holdTicks !== undefined;
    if (sustaining !== timed) {
      ctx.addIssue({
        code: "custom",
        message: "victory roles declare sustainPerMin and holdTicks together",
        path: ["sustainPerMin"],
      });
    }
  });

export type VictoryRole = z.infer<typeof victoryRoleSchema>;

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
  kind: z.literal("building"),
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
  /**
   * §2.11 victory-path role (M4-T4): generator yields on Schools and
   * Monuments, sustain gate + hold timer on the Grand Academy/Grand
   * Monument completing acts. Absent everywhere else.
   */
  victory: victoryRoleSchema.optional(),
  /** Asset refs per evolution stage (SPEC §3); stub until M2 art tickets. */
  ageStages: z.array(z.string()).optional(),
});

export type BuildingDefinition = z.infer<typeof buildingSchema>;

/**
 * Stat-modifier effect descriptor à la OpenRA conditions (SPEC §3).
 * Exactly one of `add` (flat delta, integer) or `mult` (strictly
 * positive multiplier) per effect. Targets follow `<selector>` grammar:
 * `class:<armorClass>`, `unit:<defId>`, or freeform activity/economy
 * selectors like `activity:gather-wood` — round 3 validates the typed
 * prefixes.
 */
export const techEffectSchema = z
  .object({
    target: z.string().min(1),
    stat: z.string().min(1),
    op: z.enum(["add", "mult"]).default("mult"),
    /** Flat delta when op="add" (integer); multiplier when op="mult" (>0). */
    value: z.number(),
  })
  .superRefine((effect, ctx) => {
    if (effect.op === "add" && !Number.isInteger(effect.value)) {
      ctx.addIssue({
        code: "custom",
        message: "add effects require an integer value",
        path: ["value"],
      });
    }
    if (effect.op === "mult" && effect.value <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "mult effects require a strictly positive value",
        path: ["value"],
      });
    }
  });

export type TechEffect = z.infer<typeof techEffectSchema>;

export const techSchema = z.object({
  ...commonFields,
  kind: z.literal("tech"),
  researchTime: z.number().int().positive(),
  effects: z.array(techEffectSchema).default([]),
  /** Age techs declare which age rank they grant (2=feudal…4=imperial). */
  ageAdvance: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
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
  ageGate: ageGateSchema,
  techPrereqs: z.array(z.string()),
  buildingId: z.string().min(1),
  inputs: z.array(recipeIO).min(1),
  output: recipeIO,
  ticks: z.number().int().positive(),
  techGate: z.string().optional(),
});

export type RecipeDefinition = z.infer<typeof recipeSchema>;
