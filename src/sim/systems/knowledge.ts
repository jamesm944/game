/**
 * Knowledge generator — SPEC §2.11 Knowledge path / M4-T4.
 *
 * The §2.11 frame's first half for the Knowledge path: everything that
 * EARNS Knowledge Points, credited to the per-player cumulative
 * KnowledgePoints ledger (components/knowledge.ts). The victory
 * evaluator derives the sustained KP/min metric from this digest-
 * visible counter's deltas across the player's own VictoryCheck log,
 * so generator and decision share one source of truth with zero hidden
 * state.
 *
 * Two sources, straight off the §2.11 table:
 *
 *   - SCHOOL OUTPUT: studying children produce KP scaled by teacher
 *     quality — every attended lesson credits the school def's
 *     `victory.knowledgePerLesson` × 1000 × teacherLevel milli-KP via
 *     the {@link KnowledgeSystemHandle.onLesson} observer the session
 *     wires into the school system (the companies-ledger output-
 *     observer pattern, M4-T2). Fires inside the school pass, so the
 *     credit is a deterministic replay event.
 *
 *   - LUMP PER RESEARCHED TECHNOLOGY: completed research appends a
 *     digest-visible AgeAdvanced event (systems/age.ts); this pass
 *     consumes those logs with an incremental cursor per ledger — the
 *     social/morale grudge-pass pattern — and credits
 *     {@link KNOWLEDGE_AWARD_PER_TECH_MILLI} per new event.
 *
 * Determinism: integer milli-units throughout; ascending-ledger
 * iteration; cursors are plain planning state re-derivable from the
 * digest-visible logs after a restore.
 */
import { creditKnowledgePoints } from "../components/knowledge";
import { buildingDefOf } from "../../data/definitions";
import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";

/** Lump KP award (milli-units) per completed researched technology. */
export const KNOWLEDGE_AWARD_PER_TECH_MILLI = 25_000;

/** Stable building id of the School venue (mirrors systems/school.ts). */
export const KNOWLEDGE_SCHOOL_BUILDING_ID = "school";

export interface KnowledgeSystemDeps {
  readonly comps: SimComponents;
}

export interface KnowledgeSystemHandle {
  /** The SimSystem: consumes research logs each step. */
  readonly system: SimSystem;
  /**
   * Lesson observer for createSchoolSystem's hooks: credits the lesson
   * owner teacher-scaled KP for one attended lesson. The school pass
   * supplies its own world, so ordering never drops a credit.
   */
  readonly onLesson: (
    world: World,
    playerId: number,
    teacherLevel: number,
  ) => void;
}

/** Milli-KP credited for one attended lesson under `teacherLevel`. */
export function lessonKnowledgeMilli(teacherLevel: number): number {
  const perLesson = buildingDefOf(KNOWLEDGE_SCHOOL_BUILDING_ID).victory
    ?.knowledgePerLesson;
  if (perLesson === undefined) return 0;
  return perLesson * 1000 * Math.max(0, teacherLevel);
}

/**
 * Build the knowledge generator. Register anywhere after the stockpile
 * ledgers exist; the school hook fires inside the school pass and the
 * research sweep only ever adds to ledger rows.
 */
export function createKnowledgeSystem(
  deps: KnowledgeSystemDeps,
): KnowledgeSystemHandle {
  const { comps } = deps;

  // Incremental AgeAdvanced cursor per player ledger eid — consumed
  // monotonically like the morale/social event passes.
  const processedEventsByLedger = new Map<number, number>();

  const onLesson = (
    world: World,
    playerId: number,
    teacherLevel: number,
  ): void => {
    const milli = lessonKnowledgeMilli(teacherLevel);
    if (milli <= 0) return;
    creditKnowledgePoints(world, comps, playerId, milli);
  };

  const system: SimSystem = (world) => {
    // ---- Research lumps: consume each player's AgeAdvanced log tail.
    // Row layout is [count, tick, ageRank, …] on the ledger entity, so
    // the cursor probe reads one integer per ledger.
    const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
    const eventRows = world.rowsByComponentId.get(comps.ageAdvancedId);
    if (!stockpileRows || !eventRows) return;
    for (const ledgerEid of [...stockpileRows.keys()].sort((a, b) => a - b)) {
      const playerId = stockpileRows.get(ledgerEid)?.[0];
      if (playerId === undefined) continue;
      const total = eventRows.get(ledgerEid)?.[0] ?? 0;
      const processed = processedEventsByLedger.get(ledgerEid) ?? 0;
      if (total <= processed) continue;
      creditKnowledgePoints(
        world,
        comps,
        playerId,
        KNOWLEDGE_AWARD_PER_TECH_MILLI * (total - processed),
      );
      processedEventsByLedger.set(ledgerEid, total);
    }
  };

  return { system, onLesson };
}
