/**
 * Lessons component — SPEC §2.3 school / M3-T5 (issue #50).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). Lessons slots between
 * JobCooldown and MealConsumed.
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Lessons (3): [attendedCount, lastLessonTick, graduated].
 *
 * One row per named Pop, attached wherever Identity attaches. The
 * school system (systems/school.ts) stamps attendance once per lesson
 * window: attendedCount is the graduation credit ("some traits are
 * School-acquired", SPEC §2.3 — children with enough lessons roll a
 * bonus trait on reaching adulthood), lastLessonTick pins the cadence,
 * and graduated flips once the adult-boundary credit has been paid so
 * the exact-once discipline survives any tick alignment. Knowledge XP
 * itself lands in the Skills rows via grantKnowledge — this component
 * tracks schooling, not learning.
 */

import type { ComponentRows, World } from "../core/world";

export const LESSONS = "Lessons" as const;

/** Row arity per lessons component — pinned for digest stability. */
export const LESSONS_ARITY = 3;

/** Component id the school system reads/writes. */
export interface LessonComponents {
  readonly lessonsId: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/**
 * Attach a zeroed Lessons row to one Pop (lastLessonTick −1 = never,
 * graduated 0). Call exactly once per entity alongside
 * attachPopIdentity; re-attaching wipes the school record.
 */
export function attachLessons(
  world: World,
  comps: Pick<LessonComponents, "lessonsId">,
  eid: number,
): void {
  requireRows(world, comps.lessonsId).set(eid, [0, -1, 0]);
}

/** Live (mutable) Lessons row for `eid`, or undefined before attachment. */
export function lessonsRowOf(
  world: World,
  comps: Pick<LessonComponents, "lessonsId">,
  eid: number,
): number[] | undefined {
  return world.rowsByComponentId.get(comps.lessonsId)?.get(eid);
}

/** Decoded school record, or undefined rowless. */
export interface LessonRecord {
  readonly attendedCount: number;
  readonly lastLessonTick: number;
  /** 1 once the graduation credit (bonus trait roll) has been paid. */
  readonly graduated: number;
}

export function readLessons(
  world: World,
  comps: Pick<LessonComponents, "lessonsId">,
  eid: number,
): LessonRecord | undefined {
  const row = lessonsRowOf(world, comps, eid);
  if (!row) return undefined;
  return {
    attendedCount: row[0]!,
    lastLessonTick: row[1]!,
    graduated: row[2] ?? 0,
  };
}

/** Record one attended lesson (count += 1, lastLessonTick = tick). */
export function stampLesson(
  world: World,
  comps: Pick<LessonComponents, "lessonsId">,
  eid: number,
  tick: number,
): boolean {
  const row = lessonsRowOf(world, comps, eid);
  if (!row) return false;
  row[0] = row[0]! + 1;
  row[1] = tick;
  return true;
}

/**
 * Pay the graduation credit exactly once: flips `graduated` and returns
 * true only on the first call (the bonus trait rolls then).
 */
export function stampGraduated(
  world: World,
  comps: Pick<LessonComponents, "lessonsId">,
  eid: number,
): boolean {
  const row = lessonsRowOf(world, comps, eid);
  if (!row || row[2] === 1) return false;
  row[2] = 1;
  return true;
}
