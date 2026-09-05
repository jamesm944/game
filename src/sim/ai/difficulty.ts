/**
 * AI difficulty knobs — SPEC §2.8 "disclosed knobs" / M4-T6 (issue #61).
 *
 * Difficulty is DATA, never hidden behavior: every level is a plain
 * config object whose three knobs fully describe how the opponent
 * differs, and the HUD renders them verbatim (ui/hud.ts difficulty
 * badge) so nothing about the AI is undisclosed:
 *
 *   - `decisionIntervalTicks` — the §2.8 full planning pass interval.
 *     Easy thinks every 90 ticks (3× the base cadence), normal keeps
 *     the canonical 30, hard re-plans every 15.
 *   - `reactionDelayTicks` — how long an observed stimulus (own
 *     building under attack) must persist before the military manager
 *     rallies a defense. Easy reacts ~2 sim-seconds late; hard
 *    instantly.
 *   - `incomeMultiplier` — the documented AoE2-style cheat: hard
 *     multiplies EVERY gather deposit the AI delivers into its
 *     stockpile by 1.25 (applied at the gather system's credit event,
 *     systems/gather.ts). Deliberate, visible in the badge, and never
 *     applied to the human side.
 *
 * Pure data module: no world access, no clock, no randomness — safe to
 * import from sim code, UI and tests alike.
 */

export type AiDifficultyId = "easy" | "normal" | "hard" | "extreme";

export interface AiDifficultyConfig {
  readonly id: AiDifficultyId;
  /** Full planning-pass interval in ticks (§2.8 baseline = 30). */
  readonly decisionIntervalTicks: number;
  /** Ticks a threat must persist before a defense rally fires. */
  readonly reactionDelayTicks: number;
  /** Disclosed multiplier on AI gather deposits (hard's cheat). */
  readonly incomeMultiplier: number;
}

/** The §2.8 base cadence every interval scales relative to. */
export const AI_BASE_DECISION_INTERVAL_TICKS = 30;

function defineDifficulty(
  id: AiDifficultyId,
  decisionIntervalTicks: number,
  reactionDelayTicks: number,
  incomeMultiplier: number,
): AiDifficultyConfig {
  return {
    id,
    decisionIntervalTicks,
    reactionDelayTicks,
    incomeMultiplier,
  };
}

export const AI_DIFFICULTIES: Readonly<
  Record<AiDifficultyId, AiDifficultyConfig>
> = {
  easy: defineDifficulty("easy", 90, 60, 1),
  normal: defineDifficulty("normal", AI_BASE_DECISION_INTERVAL_TICKS, 20, 1),
  hard: defineDifficulty("hard", 15, 0, 1.25),
  extreme: defineDifficulty("extreme", 10, 0, 1.4),
};

/** Resolve an id (or undefined → normal) to its full config. */
export function aiDifficultyOf(
  id: AiDifficultyId | undefined,
): AiDifficultyConfig {
  return AI_DIFFICULTIES[id ?? "normal"];
}
