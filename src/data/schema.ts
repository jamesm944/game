/**
 * Entity-definition schemas — SPEC §3.
 *
 * Zod schemas are the single source of truth; TS types come from
 * z.infer. Definitions live as JSON under
 * src/data/definitions/{units,buildings,techs,recipes}/ and load with
 * the Factorio three-round discipline: parse all → validate all → fail
 * loudly listing every error. M1-T7 adds the SCHEMA ONLY — definition
 * content lands with the M2 data tickets.
 */

import { z } from "zod";

export const KIND = z.enum(["unit", "building", "tech", "recipe"]);

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

export type UnitDefinition = z.infer<typeof unitSchema>;
