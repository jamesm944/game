/**
 * School system — SPEC §2.3 school lessons / M3-T5 (issue #50).
 *
 * Children attend 9am–3pm when their player owns a finished School
 * (SPEC §2.4 "children School 9am–3pm"; §2.3's CSL model simplified):
 * each CHILD enters class once per day at a hash-staggered minute
 * inside the lesson window (`lessonTickFor` — deterministic, amortized,
 * never a stampede), where a teacher-gated lesson lands:
 *
 *   - TEACHER SELECTION: per player per day, the working-age or ELDER
 *     Pop (teaching IS light duty) with the highest skill level across
 *     all skills, ties by ascending eid. Nobody who knows anything ⇒ no
 *     school that day (the building alone teaches nothing).
 *
 *   - KNOWLEDGE XP: the day's subject rotates through SKILL_SLUGS by
 *     day index (deterministic curriculum). grantKnowledge pays
 *     LESSON_KNOWLEDGE_XP — but only while the child's knowledge stays
 *     under the teacher's ceiling: a level-L teacher teaches subject
 *     levels below min(TEACHER_SUBJECT_CAP, L). SPEC: "teacher skill
 *     gates ~subject level 7" — schooling caps out around level 7 even
 *     under master teachers.
 *
 *   - TRAIT ROLLS ("some traits are School-acquired"): every lesson
 *     rolls a seeded chance scaling with teacher skill; success appends
 *     one conflict-free weighted trait to the child's Traits row.
 *
 *   - GRADUATION: on the exact adult-boundary tick (checked EVERY tick,
 *     not only in-window — births land at arbitrary clock minutes), a
 *     schooled child (≥ GRADUATION_MIN_LESSONS lessons) whose credit is
 *     unpaid always rolls one more bonus trait and flips its digest-
 *     visible Lessons.graduated flag. Graduates are measurably better
 *     than unschooled adults — the golden fixture pins the delta.
 *
 * All randomness flows from dedicated sfc32 sub-streams keyed
 * (seed, eid, dayIndex) — never world.prng.
 */

import {
  lessonsRowOf,
  stampGraduated,
  stampLesson,
} from "../components/lessons";
import { POP_ORIGIN_BIRTH, readIdentity, readTraits } from "../components/pop";
import { createPrng } from "../core/prng";
import {
  TRAIT_DEFINITIONS,
  TRAIT_SLUGS,
  conflictsOf,
  traitCodeOf,
} from "../data/traits";
import { SKILL_SLUGS, xpToReachLevel, type SkillSlug } from "../data/skills";
import { grantKnowledge, skillLevelOf, totalXpOf } from "./skills";
import {
  LIFE_STAGE_CHILD,
  adultTicksOf,
  effectiveAgeOf,
  lifeStageOf,
  normalizeLifecycleConfig,
  dayIndexOf,
  minuteOfDay,
  type LifecycleConfig,
} from "./lifecycle";
import { buildingIdOfCode } from "../../data/definitions";
import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";

// ---- Documented tuning constants ---------------------------------------------

/** Lesson window opens at 09:00 sim-clock (§2.4 children band). */
export const SCHOOL_OPEN_MINUTE = 9 * 60;
/** Lesson window closes at 15:00. */
export const SCHOOL_CLOSE_MINUTE = 15 * 60;

/** Knowledge XP per attended lesson. */
export const LESSON_KNOWLEDGE_XP = 30;

/** Subject ceiling of schooling even under master teachers (§2.3 "~7"). */
export const TEACHER_SUBJECT_CAP = 7;

/** Per-teacher-level chance a lesson also plants a new trait. */
export const TRAIT_ROLL_CHANCE_PER_LEVEL = 0.04;

/** Lessons a child must attend before graduation counts as schooled. */
export const GRADUATION_MIN_LESSONS = 3;

/** Domain constant separating graduation streams from other seed uses. */
const GRADUATION_STREAM_DOMAIN = 0x67726164; // "grad"

// ---- Pure schedule math ----------------------------------------------------------

/** Ticks inside one lesson window under `config`. */
export function lessonWindowTicks(config: LifecycleConfig): number {
  return ((SCHOOL_CLOSE_MINUTE - SCHOOL_OPEN_MINUTE) * config.dayTicks) / 1440;
}

/** True when `tick`'s sim-clock minute falls inside the lesson band. */
export function isLessonTime(tick: number, config: LifecycleConfig): boolean {
  const minute = minuteOfDay(tick, config);
  return minute >= SCHOOL_OPEN_MINUTE && minute < SCHOOL_CLOSE_MINUTE;
}

/** The subject taught on `dayIndex` (deterministic rotation). */
export function subjectOfDay(dayIndex: number): SkillSlug {
  return SKILL_SLUGS[dayIndex % SKILL_SLUGS.length]!;
}

/**
 * The exact tick CHILD `eid` enters class on `dayIndex`: staggered
 * across the window so a town of pupils trickles into lessons instead
 * of stampeding (the ±90 s jitter posture SPEC §2.4 prescribes for
 * off-work transitions).
 */
export function lessonTickFor(
  eid: number,
  dayIndex: number,
  config: LifecycleConfig,
): number {
  const dayStart = dayIndex * config.dayTicks;
  const openOffset = Math.floor((SCHOOL_OPEN_MINUTE * config.dayTicks) / 1440);
  const span = Math.max(1, Math.floor(lessonWindowTicks(config)));
  const jitter = (eid * 37 + dayIndex) % span;
  return dayStart + openOffset + jitter;
}

/** Every component id the school pass reads or writes. */
export type SchoolSystemComponents = Pick<
  SimComponents,
  | "identityId"
  | "unitTagId"
  | "traitsId"
  | "lessonsId"
  | "skillsId"
  | "buildingId"
  | "ownerId"
>;

/** Stable building id of the school venue (§2.4 venues v1). */
export const SCHOOL_BUILDING_ID = "school";

function requireRows(world: World, componentId: number): Map<number, number[]> {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) throw new Error("unregistered component");
  return rows as Map<number, number[]>;
}

function ownerOfPop(
  world: World,
  comps: Pick<SchoolSystemComponents, "ownerId">,
  eid: number,
): number {
  return requireRows(world, comps.ownerId).get(eid)?.[0] ?? 0;
}

/**
 * True when `playerId` owns at least one finished School — the §2.3
 * gate for whether lessons happen at all.
 */
export function hasFinishedSchool(
  world: World,
  comps: Pick<SchoolSystemComponents, "buildingId">,
  playerId: number,
): boolean {
  for (const row of requireRows(world, comps.buildingId).values()) {
    if (row[0] !== playerId) continue;
    if (buildingIdOfCode(row[1]!) === SCHOOL_BUILDING_ID) return true;
  }
  return false;
}

/** Highest skill level of one Pop — its teaching qualification. */
function bestSkillLevelOf(
  world: World,
  comps: SchoolSystemComponents,
  eid: number,
): number {
  let level = 0;
  for (const slug of SKILL_SLUGS) {
    level = Math.max(level, skillLevelOf(world, comps, eid, slug) ?? 0);
  }
  return level;
}

/**
 * The teacher on duty for `playerId` today: the working-age or elder
 * Pop with the highest single skill level, ascending-eid tiebreak.
 * Undefined when nobody knows anything (no school today).
 */
export function teacherOnDuty(
  world: World,
  comps: SchoolSystemComponents,
  playerId: number,
  config: LifecycleConfig,
): number | undefined {
  let best: number | undefined;
  let bestLevel = 0;
  for (const eid of [...requireRows(world, comps.identityId).keys()].sort(
    (a, b) => a - b,
  )) {
    if (!requireRows(world, comps.unitTagId).has(eid)) continue;
    if (ownerOfPop(world, comps, eid) !== playerId) continue;
    // Teaching IS elder light duty; children are pupils, not teachers.
    const stage = lifeStageOf(world, comps, eid, config);
    if (stage === undefined || stage === LIFE_STAGE_CHILD) continue;
    const level = bestSkillLevelOf(world, comps, eid);
    if (level > bestLevel) {
      bestLevel = level;
      best = eid;
    }
  }
  return bestLevel > 0 ? best : undefined;
}

/**
 * One child's seeded lesson stream — pure function of
 * (seed, eid, dayIndex), fresh per lesson, shared-stream-free.
 */
export function lessonRandom(
  seed: number,
  eid: number,
  dayIndex: number,
  domain: number,
): Pick<ReturnType<typeof createPrng>, "nextFloat"> {
  const salt = (seed ^ Math.imul(dayIndex + 1, 0x85ebca6b)) >>> 0;
  return createPrng((((salt ^ eid) >>> 0) ^ domain) >>> 0 || 1);
}

const LESSON_ROLL_DOMAIN = 0x6c657373; // "less"
const TRAIT_PICK_DOMAIN = 0x74726169; // "trai"

/**
 * Append one conflict-free weighted trait to `eid`'s Traits row using
 * `random`, excluding everything the Pop already carries (and their
 * conflicts). Returns the new slug, or undefined when the pool runs
 * dry. The row stays ascending-code sorted (digest contract).
 */
export function applyBonusTrait(
  world: World,
  comps: Pick<SchoolSystemComponents, "traitsId">,
  eid: number,
  random: Pick<ReturnType<typeof createPrng>, "nextFloat">,
): string | undefined {
  const live = requireRows(world, comps.traitsId).get(eid);
  if (!live) return undefined;
  const existing = readTraits(world, comps, eid) ?? [];
  const excluded = new Set<string>(existing);
  for (const slug of existing) {
    for (const conflict of conflictsOf(slug)) excluded.add(conflict);
  }
  const eligible = TRAIT_SLUGS.filter((slug) => !excluded.has(slug));
  if (eligible.length === 0) return undefined;
  let totalWeight = 0;
  for (const slug of eligible) {
    totalWeight += TRAIT_DEFINITIONS.get(slug)!.commonality;
  }
  let rollValue = random.nextFloat() * totalWeight;
  let picked: string | undefined;
  for (const slug of eligible) {
    rollValue -= TRAIT_DEFINITIONS.get(slug)!.commonality;
    if (rollValue < 0) {
      picked = slug;
      break;
    }
  }
  if (picked === undefined) picked = eligible[eligible.length - 1]!;
  const code = traitCodeOf(picked);
  let insertAt = live.length;
  for (let i = 1; i < live.length; i++) {
    if (live[i]! > code) {
      insertAt = i;
      break;
    }
  }
  live.splice(insertAt, 0, code);
  return picked;
}

/**
 * Roll a graduation bonus trait for `eid` — guaranteed for schooled
 * graduates, keyed (seed, eid) under the graduation domain. Returns
 * the slug or undefined when the Pop is rowless or the pool is dry.
 */
export function rollGraduationTrait(
  world: World,
  comps: SchoolSystemComponents,
  eid: number,
): string | undefined {
  if (!readIdentity(world, comps, eid)) return undefined;
  const random = createPrng(
    (((world.seed ^ Math.imul(eid, 0x27220a95)) >>> 0) ^
      GRADUATION_STREAM_DOMAIN) >>>
      0 || 1,
  );
  return applyBonusTrait(world, comps, eid, random);
}

// ---- Diagnostics -------------------------------------------------------------

/** Test/telemetry counters — deliberately NOT part of the digest. */
export interface SchoolDiagnostics {
  /** Lessons delivered (attendance stamps). */
  lessonsTaught: number;
  /** Knowledge XP granted across all lessons. */
  knowledgeGranted: number;
  /** Bonus traits planted mid-schooling. */
  traitsPlanted: number;
  /** Children paid their graduation bonus trait. */
  graduatesCredited: number;
}

export function createSchoolDiagnostics(): SchoolDiagnostics {
  return {
    lessonsTaught: 0,
    knowledgeGranted: 0,
    traitsPlanted: 0,
    graduatesCredited: 0,
  };
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the school SimSystem. Register after skills (knowledge grants
 * fold into the same rows the rust pass reads) and after lifecycle
 * helpers exist — it reads derived stages only, so ordering is soft.
 * Cheap early-out when no Lessons rows exist at all (legacy worlds).
 */
export function createSchoolSystem(
  comps: SchoolSystemComponents,
  config: LifecycleConfig,
  diagnostics: SchoolDiagnostics = createSchoolDiagnostics(),
): SimSystem {
  const normalized = normalizeLifecycleConfig(config);
  const adultTicks = adultTicksOf(normalized);
  return (world: World): void => {
    const lessons = requireRows(world, comps.lessonsId);
    if (lessons.size === 0) return;
    const tick = world.tick;
    const dayIndex = dayIndexOf(tick, normalized);

    // ---- Pass A: graduation sweep (every tick) ------------------------
    // Births land at arbitrary clock minutes, so the adult boundary can
    // fall outside the lesson window; the sweep catches every crossing.
    for (const eid of [...lessons.keys()].sort((a, b) => a - b)) {
      const row = lessonsRowOf(world, comps, eid)!;
      if (row[2] === 1) continue; // credit already paid
      const identity = readIdentity(world, comps, eid);
      if (!identity || identity.origin !== POP_ORIGIN_BIRTH) continue;
      const age = effectiveAgeOf(world, comps, eid, normalized)!;
      if (age !== adultTicks) continue; // not today's exact boundary
      if (row[0]! < GRADUATION_MIN_LESSONS) continue; // truanted out
      if (!stampGraduated(world, comps, eid)) continue;
      const slug = rollGraduationTrait(world, comps, eid);
      if (slug !== undefined) diagnostics.graduatesCredited += 1;
    }

    // ---- Pass B: lessons during the window ------------------------------
    if (!isLessonTime(tick, normalized)) return;
    const subject = subjectOfDay(dayIndex);

    // Teachers (and school presence) resolve lazily per player and
    // memoize for the tick.
    const teachersByPlayer = new Map<number, number | undefined>();

    for (const eid of [...lessons.keys()].sort((a, b) => a - b)) {
      const classTick = lessonTickFor(eid, dayIndex, normalized);
      if (tick !== classTick) continue; // exactly-once staggered cadence

      const row = lessonsRowOf(world, comps, eid)!;
      if (row[1]! >= classTick && row[0]! > 0) continue; // already sat today
      const identity = readIdentity(world, comps, eid);
      if (!identity) continue;
      if (lifeStageOf(world, comps, eid, normalized) !== LIFE_STAGE_CHILD) {
        continue; // graduates work; adults don't sit in class
      }

      const playerId = ownerOfPop(world, comps, eid);
      if (!teachersByPlayer.has(playerId)) {
        // SPEC §2.3: lessons need a School standing AND a teacher who
        // knows something — neither the building alone nor skill alone
        // teaches.
        teachersByPlayer.set(
          playerId,
          hasFinishedSchool(world, comps, playerId)
            ? teacherOnDuty(world, comps, playerId, normalized)
            : undefined,
        );
      }
      const teacherEid = teachersByPlayer.get(playerId);
      if (teacherEid === undefined) continue; // no school or no teacher
      const teacherLevel = bestSkillLevelOf(world, comps, teacherEid);

      // Attendance credit lands regardless of subject headroom.
      stampLesson(world, comps, eid, tick);
      diagnostics.lessonsTaught += 1;

      // Knowledge XP gated by the teacher's subject ceiling.
      const ceiling = Math.min(TEACHER_SUBJECT_CAP, teacherLevel);
      const knownXp = totalXpOf(world, comps, eid, subject) ?? 0;
      if (ceiling > 0 && knownXp < xpToReachLevel(ceiling)) {
        grantKnowledge(world, comps, eid, subject, LESSON_KNOWLEDGE_XP);
        diagnostics.knowledgeGranted += LESSON_KNOWLEDGE_XP;
      }

      // Trait roll: chance scales with teacher quality.
      const chance = Math.min(1, TRAIT_ROLL_CHANCE_PER_LEVEL * teacherLevel);
      if (
        lessonRandom(
          world.seed,
          eid,
          dayIndex,
          LESSON_ROLL_DOMAIN,
        ).nextFloat() < chance
      ) {
        const slug = applyBonusTrait(
          world,
          comps,
          eid,
          lessonRandom(world.seed, eid, dayIndex + 7919, TRAIT_PICK_DOMAIN),
        );
        if (slug !== undefined) diagnostics.traitsPlanted += 1;
      }
    }
  };
}
