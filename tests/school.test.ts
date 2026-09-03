/**
 * School tests — SPEC §2.3 school lessons / M3-T5 (issue #50).
 *
 * Pinned here:
 * - lesson-window math on the canonical clock (9am–3pm band);
 * - the double gate: NO finished School ⇒ no lessons even with a
 *   skilled teacher; a School with nobody who knows anything ⇒ still
 *   no lessons;
 * - teacher-gated knowledge XP (attendance credit, subject rotation,
 *   ceiling at min(TEACHER_SUBJECT_CAP, teacher level));
 * - graduation: schooled children crossing the adult boundary roll one
 *   guaranteed bonus trait exactly once; truants graduate empty.
 */
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  readTraits,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { POP_ORIGIN_BIRTH } from "../src/sim/components/pop";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { awardPractice, totalXpOf } from "../src/sim/systems/skills";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  normalizeLifecycleConfig,
  type LifecycleConfig,
} from "../src/sim/systems/lifecycle";
import {
  LESSON_KNOWLEDGE_XP,
  SCHOOL_CLOSE_MINUTE,
  SCHOOL_OPEN_MINUTE,
  createSchoolDiagnostics,
  createSchoolSystem,
  isLessonTime,
  lessonTickFor,
  subjectOfDay,
} from "../src/sim/systems/school";
import { xpToReachLevel, SKILL_SLUGS } from "../src/sim/data/skills";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

/**
 * Compressed clock with a FOUR-day childhood: pupils sit days 0–3
 * (four lessons), graduate at the exact adult boundary on day 4.
 */
const CFG: LifecycleConfig = normalizeLifecycleConfig({
  dayTicks: 600,
  adultAgeDays: 4,
  elderAgeDays: 5,
  lifespanDays: 6,
});

interface SchoolScene {
  readonly world: World;
  readonly comps: SimComponents;
  readonly diagnostics: ReturnType<typeof createSchoolDiagnostics>;
}

function schoolScene(
  seed: number,
  options: { readonly school?: boolean } = {},
): SchoolScene {
  const size = 24;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
  });
  const comps = defineSimComponents(world);
  const diagnostics = createSchoolDiagnostics();
  registerSystem(world, createSchoolSystem(comps, CFG, diagnostics));
  createPlayerStockpile(world, comps, PLAYER_ONE);
  if (options.school !== false) {
    stampFinishedBuilding(world, comps, "school", 5, 5, {
      playerId: PLAYER_ONE,
    });
  }
  return { world, comps, diagnostics };
}

/** A newborn pupil plus a skilled teacher, both arriving at tick 0. */
function pupilAndTeacher(
  scene: SchoolScene,
  teacherLevel = 1,
): { pupil: number; teacher: number } {
  const pupil = spawnUnit(scene.world, scene.comps, 9.5, 9.5, {
    identity: true,
    origin: POP_ORIGIN_BIRTH,
  });
  const teacher = spawnUnit(scene.world, scene.comps, 10.5, 10.5, {
    identity: true,
  });
  // 3× overshoot pins the teacher's MINIMUM level regardless of the
  // seeded xpGain-mult traits (slow-learner bottoms out at ×0.8).
  awardPractice(
    scene.world,
    scene.comps,
    teacher,
    "gathering",
    xpToReachLevel(teacherLevel) * 3,
  );
  return { pupil, teacher };
}

describe("lesson window math", () => {
  it("opens at 09:00 and closes at 15:00 sim-clock", () => {
    const zeroOffset = { ...DEFAULT_LIFECYCLE_CONFIG, clockOffsetMinutes: 0 };
    expect(isLessonTime(SCHOOL_OPEN_MINUTE * 10 - 1, zeroOffset)).toBe(false);
    expect(isLessonTime(SCHOOL_OPEN_MINUTE * 10, zeroOffset)).toBe(true);
    expect(isLessonTime(SCHOOL_CLOSE_MINUTE * 10 - 1, zeroOffset)).toBe(true);
    expect(isLessonTime(SCHOOL_CLOSE_MINUTE * 10, zeroOffset)).toBe(false);

    // With canonical 7:00 AM boot (420m offset):
    // tick 0 (07:00 AM) is before school opens (09:00 AM)
    expect(isLessonTime(0, DEFAULT_LIFECYCLE_CONFIG)).toBe(false);
    // tick 1200 (120 min elapsed -> 09:00 AM) school opens
    expect(isLessonTime(1200, DEFAULT_LIFECYCLE_CONFIG)).toBe(true);
  });

  it("rotates subjects by day and staggers pupils inside the window", () => {
    expect(subjectOfDay(0)).toBe(SKILL_SLUGS[0]);
    expect(subjectOfDay(1)).toBe(SKILL_SLUGS[1]);
    expect(subjectOfDay(SKILL_SLUGS.length)).toBe(SKILL_SLUGS[0]);
    for (let eid = 1; eid < 40; eid++) {
      for (let day = 0; day < 3; day++) {
        const tick = lessonTickFor(eid, day, CFG);
        expect(tick).toBeGreaterThanOrEqual(day * CFG.dayTicks);
        expect(tick).toBeLessThan((day + 1) * CFG.dayTicks);
      }
    }
  });
});

describe("school gates", () => {
  it("no school standing ⇒ no lessons even with a skilled teacher", () => {
    const scene = schoolScene(53, { school: false });
    pupilAndTeacher(scene, 3);
    for (let i = 0; i < 4 * CFG.dayTicks; i++) step(scene.world);
    // Nobody ever attended (rows stay zeroed), no knowledge granted.
    expect(scene.diagnostics.lessonsTaught).toBe(0);
    expect(scene.diagnostics.knowledgeGranted).toBe(0);
  });

  it("school but nobody who knows anything ⇒ still no lessons", () => {
    const scene = schoolScene(59, { school: true });
    const pupil = spawnUnit(scene.world, scene.comps, 9.5, 9.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    // Second child-as-teacher? No — an unskilled ADULT is present.
    spawnUnit(scene.world, scene.comps, 10.5, 10.5, { identity: true });
    void pupil;
    for (let i = 0; i < 4 * CFG.dayTicks; i++) step(scene.world);
    expect(scene.diagnostics.lessonsTaught).toBe(0);
  });
});

describe("teacher-gated lessons", () => {
  it("pupils accrue attendance and knowledge under a teacher", () => {
    const scene = schoolScene(61, { school: true });
    const { pupil } = pupilAndTeacher(scene, 2);

    // Five days: the pupil sits class on days 0–3 and graduates on day 4.
    for (let i = 0; i < 5 * CFG.dayTicks; i++) step(scene.world);

    expect(scene.diagnostics.lessonsTaught).toBeGreaterThanOrEqual(3);
    expect(scene.diagnostics.knowledgeGranted).toBe(
      scene.diagnostics.lessonsTaught * LESSON_KNOWLEDGE_XP,
    );
    // Knowledge landed in the rotating subjects the pupil sat through.
    let anySubjectTaught = false;
    for (const slug of SKILL_SLUGS) {
      const xp = totalXpOf(scene.world, scene.comps, pupil, slug) ?? 0;
      expect(xp % LESSON_KNOWLEDGE_XP).toBe(0);
      if (xp > 0) anySubjectTaught = true;
    }
    expect(anySubjectTaught).toBe(true);
  });

  it("the teacher's own level caps what the subject can reach", () => {
    const scene = schoolScene(67, { school: true });
    const { pupil } = pupilAndTeacher(scene, 1);
    // Flood the pupil's construction far past ANY teacher ceiling
    // (2400+ XP ≥ the 2100 a level-7 teacher could teach toward), then
    // sit them in class for days.
    awardPractice(scene.world, scene.comps, pupil, "construction", 3000);
    const before = totalXpOf(scene.world, scene.comps, pupil, "construction")!;
    for (let i = 0; i < 5 * CFG.dayTicks; i++) step(scene.world);

    // Teaching demonstrably happened…
    expect(scene.diagnostics.lessonsTaught).toBeGreaterThanOrEqual(3);
    // …but day 0 (and any construction day) granted the covered pupil
    // NOTHING: the §2.3 "~level 7" gate in miniature.
    const after = totalXpOf(scene.world, scene.comps, pupil, "construction");
    expect(after).toBe(before);
    // While other subjects did grow.
    expect(scene.diagnostics.knowledgeGranted).toBeGreaterThan(0);
  });
});

describe("graduation", () => {
  it("schooled graduates roll a bonus trait exactly once", () => {
    const scene = schoolScene(71, { school: true });
    const { pupil } = pupilAndTeacher(scene, 3);
    const traitsBefore = (readTraits(scene.world, scene.comps, pupil) ?? [])
      .length;

    for (let i = 0; i < 6 * CFG.dayTicks; i++) step(scene.world);

    expect(scene.diagnostics.graduatesCredited).toBe(1);
    const traitsAfter = readTraits(scene.world, scene.comps, pupil)!;
    expect(traitsAfter.length).toBeGreaterThan(traitsBefore);
  });

  it("truants cross the boundary without any graduation gain", () => {
    // School stands, but nobody teaches AND the child never attends:
    // the exact adult boundary passes with zero credit.
    const scene = schoolScene(73, { school: false });
    const truant = spawnUnit(scene.world, scene.comps, 9.5, 9.5, {
      identity: true,
      origin: POP_ORIGIN_BIRTH,
    });
    const before = readTraits(scene.world, scene.comps, truant)!;
    for (let i = 0; i < 6 * CFG.dayTicks; i++) step(scene.world);
    expect(scene.diagnostics.graduatesCredited).toBe(0);
    expect(readTraits(scene.world, scene.comps, truant)).toEqual(before);
  });
});
