/**
 * Body component — SPEC §2.5 injuries / M3-T4 (issue #49).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). Body slots between
 * BuildingSite and CarryCapacity.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Body (variable), two count-led segments in one flat integer row:
 *
 *   [stackCount,
 *    partCode₀, severity₀, ticksRemaining₀, … ,
 *    scarCount, scarPartCode₀, scarSeverity₀, …]
 *
 * Hediff-style stacks per SPEC §2.5: one {severity, duration} entry per
 * open wound. `severity` is the LIVE value — impairments ease as it
 * drains; `ticksRemaining` counts down to the recovery window closing.
 * Scars are permanent records written when a wound's recovery window
 * closes while it is still severe (healed-at-full-severity): they never
 * decay and never leave the row.
 *
 * Parts: six canonical slugs with stable u8 codes assigned by ascending
 * slug order (the same doctrine as trait codes). Strike allocation
 * weights live beside them (systems/injuries.ts consumes them).
 *
 * Derived-on-read impairment multipliers ("derived stats, never
 * stored", SPEC §2.5): grouped active severity over each part group
 * scales speed (legs), attack AND work (arms), or everything (head/
 * torso — vitals). Scars never impair; active severity does. Rowless
 * entities derive exactly-neutral multipliers so every legacy call site
 * keeps its pre-M3-T4 arithmetic bit-for-bit.
 */

import type { ComponentRows, World } from "../core/world";

export const BODY = "Body" as const;

/** Variable-length row: count-led injury stacks + count-led scars. */
export const BODY_ARITY = -1;

// ---- Parts ---------------------------------------------------------------------

/** Canonical part slugs, ascending — index IS the stable u8 part code. */
export const BODY_PART_SLUGS = [
  "armL",
  "armR",
  "head",
  "legL",
  "legR",
  "torso",
] as const;

export type BodyPartSlug = (typeof BODY_PART_SLUGS)[number];

function bodyPartCodeOf(slug: BodyPartSlug): number {
  const code = BODY_PART_SLUGS.indexOf(slug);
  if (code === -1) throw new Error(`unknown body part slug: ${slug}`);
  return code;
}

/** Stable u8 codes, ascending-slug order — pinned for digest safety. */
export const BODY_PART_ARM_L = bodyPartCodeOf("armL");
export const BODY_PART_ARM_R = bodyPartCodeOf("armR");
export const BODY_PART_HEAD = bodyPartCodeOf("head");
export const BODY_PART_LEG_L = bodyPartCodeOf("legL");
export const BODY_PART_LEG_R = bodyPartCodeOf("legR");
export const BODY_PART_TORSO = bodyPartCodeOf("torso");

// ---- Documented tuning constants -------------------------------------------------

/**
 * Per-part ACTIVE severity ceiling: incoming wounds clamp so a limb can
 * never hold more than this much open trauma (overflow is discarded —
 * death runs on the whole-body threshold below).
 */
export const PART_INJURY_CAPACITY = 100;

/**
 * Whole-body death threshold: cumulative ACTIVE severity across every
 * part strictly above this kills the Pop (SPEC §2.5 "or kill").
 */
export const DEATH_SEVERITY_THRESHOLD = 100;

/** Max fraction any single impairment group shaves off its stat. */
export const IMPAIRMENT_MAX_PENALTY_PCT = 0.5;

// ---- Component wiring ------------------------------------------------------------

/** Component ids the injury systems read/write. */
export interface BodyComponents {
  readonly bodyId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** Injury stack stride inside the flat row. */
export const INJURY_STACK_STRIDE = 3;
/** Scar entry stride after the stack segment. */
export const SCAR_ENTRY_STRIDE = 2;

/** Attach an empty (healthy) Body row. Call once per entity at spawn. */
export function attachBody(
  world: World,
  comps: Pick<BodyComponents, "bodyId">,
  eid: number,
): void {
  requireRows(world, comps.bodyId).set(eid, [0]);
}

/** Live (mutable) Body row for `eid`, or undefined when rowless. */
export function bodyRowOf(
  world: World,
  comps: Pick<BodyComponents, "bodyId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.bodyId)?.get(eid);
}

// ---- Stack mutation ---------------------------------------------------------------

/**
 * Append one open-wound stack to `partCode`, clamped to the part's
 * remaining capacity headroom (a saturated limb ignores overflow — the
 * whole-body death threshold is the real killer). Returns the severity
 * actually stored. Zero-headroom parts still resolve cleanly (nothing
 * recorded); callers treat that as "no new wound".
 */
export function addInjuryStack(
  world: World,
  comps: Pick<BodyComponents, "bodyId">,
  eid: number,
  partCode: number,
  severity: number,
  durationTicks: number,
): number {
  if (
    !Number.isInteger(severity) ||
    severity < 1 ||
    !Number.isInteger(durationTicks) ||
    durationTicks < 1
  ) {
    throw new Error(
      `injury stack requires positive integer severity/duration, got ${String(severity)}/${String(durationTicks)}`,
    );
  }
  if (
    !Number.isInteger(partCode) ||
    partCode < 0 ||
    partCode >= BODY_PART_SLUGS.length
  ) {
    throw new Error(`unknown body part code: ${String(partCode)}`);
  }
  const row = requireRows(world, comps.bodyId).get(eid);
  if (!row) return 0; // rowless entities cannot be wounded
  const held = groupSeverityFromRow(row, [partCode]);
  const stored = Math.min(severity, PART_INJURY_CAPACITY - held);
  if (stored <= 0) return 0;
  const stackCount = row[0]!;
  row.splice(
    1 + stackCount * INJURY_STACK_STRIDE,
    0,
    partCode,
    stored,
    durationTicks,
  );
  row[0] = stackCount + 1;
  return stored;
}

// ---- Derived read path --------------------------------------------------------------

/** Summed active severity across one set of part codes (pure row math). */
function groupSeverityFromRow(
  row: number[],
  partCodes: readonly number[],
): number {
  let total = 0;
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    const base = 1 + i * INJURY_STACK_STRIDE;
    if (partCodes.includes(row[base]!)) total += row[base + 1]!;
  }
  return total;
}

/** Cumulative active severity over ALL parts (the death-check input). */
export function cumulativeActiveSeverityFromRow(row: number[]): number {
  let total = 0;
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    total += row[1 + i * INJURY_STACK_STRIDE + 1]!;
  }
  return total;
}

/**
 * One group's impairment multiplier: full capacity of open trauma in
 * the group scales the stat down by IMPAIRMENT_MAX_PENALTY_PCT, linearly.
 */
function groupMultiplierFromRow(
  row: number[],
  partCodes: readonly number[],
): number {
  const fraction = groupSeverityFromRow(row, partCodes) / PART_INJURY_CAPACITY;
  return 1 - Math.min(1, Math.max(0, fraction)) * IMPAIRMENT_MAX_PENALTY_PCT;
}

/** Neutral multipliers for rowless entities — legacy arithmetic exact. */
export const NEUTRAL_IMPAIRMENT: ImpairmentMultipliers = Object.freeze({
  speedMult: 1,
  attackMult: 1,
  workMult: 1,
});

/** Derived-on-read impairment factors for one Body row. */
export interface ImpairmentMultipliers {
  /** Legs (+vitals): movement cruise-speed factor. */
  readonly speedMult: number;
  /** Arms (+vitals): derived attack factor (aim, SPEC §2.5). */
  readonly attackMult: number;
  /** Arms (+vitals): work-rate factor (gather/build). */
  readonly workMult: number;
}

/**
 * Impairment multipliers from a raw row (pure): vitals (head/torso)
 * degrade EVERYTHING, arms degrade aim and work, legs degrade speed.
 */
export function impairmentMultipliersFromRow(
  row: number[] | undefined,
): ImpairmentMultipliers {
  if (!row) return NEUTRAL_IMPAIRMENT;
  const vital = groupMultiplierFromRow(row, [BODY_PART_HEAD, BODY_PART_TORSO]);
  return {
    speedMult:
      vital * groupMultiplierFromRow(row, [BODY_PART_LEG_L, BODY_PART_LEG_R]),
    attackMult:
      vital * groupMultiplierFromRow(row, [BODY_PART_ARM_L, BODY_PART_ARM_R]),
    workMult:
      vital * groupMultiplierFromRow(row, [BODY_PART_ARM_L, BODY_PART_ARM_R]),
  };
}

/**
 * Impairment multipliers for one entity (neutral when rowless or when
 * the caller's component bundle predates Body — lenient `bodyId?`
 * keeps legacy system signatures compiling untouched).
 */
export function injuryImpairmentOf(
  world: World,
  comps: { readonly bodyId?: number | undefined },
  eid: number,
): ImpairmentMultipliers {
  if (typeof comps.bodyId !== "number") return NEUTRAL_IMPAIRMENT;
  return impairmentMultipliersFromRow(
    world.rowsByComponentId.get(comps.bodyId)?.get(eid),
  );
}

// ---- Readouts -----------------------------------------------------------------------

/** One decoded open wound (Pop-card ready). */
export interface InjuryReadout {
  readonly part: BodyPartSlug;
  readonly severity: number;
  readonly ticksRemaining: number;
}

/** One decoded permanent scar (Pop-card ready). */
export interface ScarReadout {
  readonly part: BodyPartSlug;
  readonly severity: number;
}

/** Decoded copy of every open wound on one entity (fresh array). */
export function readInjuries(
  world: World,
  comps: Pick<BodyComponents, "bodyId">,
  eid: number,
): InjuryReadout[] | undefined {
  const row = bodyRowOf(world, comps, eid);
  if (!row) return undefined;
  const out: InjuryReadout[] = [];
  const count = row[0]!;
  for (let i = 0; i < count; i++) {
    const base = 1 + i * INJURY_STACK_STRIDE;
    out.push({
      part: BODY_PART_SLUGS[row[base]!]!,
      severity: row[base + 1]!,
      ticksRemaining: row[base + 2]!,
    });
  }
  return out;
}

/** Decoded copy of every permanent scar on one entity (fresh array). */
export function readScars(
  world: World,
  comps: Pick<BodyComponents, "bodyId">,
  eid: number,
): ScarReadout[] | undefined {
  const row = bodyRowOf(world, comps, eid);
  if (!row) return undefined;
  const stackCount = row[0]!;
  const scarBase = 1 + stackCount * INJURY_STACK_STRIDE;
  const scarCount = row[scarBase]!;
  const out: ScarReadout[] = [];
  for (let i = 0; i < scarCount; i++) {
    const base = scarBase + 1 + i * SCAR_ENTRY_STRIDE;
    out.push({
      part: BODY_PART_SLUGS[row[base]!]!,
      severity: row[base + 1]!,
    });
  }
  return out;
}
