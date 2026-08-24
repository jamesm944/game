/**
 * Topbar — SPEC §2.13/§2.6 (M1-T8 chrome, M1-T9 resource readout,
 * M2-T2 full gatherable set, M2-T4 age badge) + the M4-T6 AI difficulty
 * badge (§2.8 "disclosed knobs").
 *
 * Line 1: seed · tick · fps, with the current-age icon-text badge
 * (roman rank + age name) and the AI difficulty badge beside it. Line
 * 2: live stockpile counts per gatherable resource — all SEVEN §2.6
 * slugs (food · wood · gold · stone · iron · coal · clay) — polled from
 * the sim snapshot each rendered frame. The numbers come straight from
 * the Stockpile component rows — the exact rows golden digests hash —
 * so the topbar cannot drift from the simulation.
 */

import { RESOURCE_NAMES } from "../sim/components/economy";
import {
  AI_DIFFICULTIES,
  type AiDifficultyConfig,
  type AiDifficultyId,
} from "../sim/ai/difficulty";

export interface TopbarHandle {
  update(tick: number, fpsText: string, stockText?: string): void;
  /** Repaint the current-age badge (hidden until a rank exists). */
  updateAge(rank: number | undefined): void;
  /** Repaint the AI difficulty badge (discloses every active knob). */
  updateDifficulty(id: AiDifficultyId): void;
}

/** Roman rank numerals — AoE2-style age badge prefix. */
const AGE_NUMERALS = ["I", "II", "III", "IV"] as const;
const AGE_BADGE_NAMES = [
  "Dark Age",
  "Feudal Age",
  "Castle Age",
  "Imperial Age",
] as const;

/**
 * Icon-text for one age rank, e.g. `II · Feudal Age`. Undefined ranks
 * render as the dark-age default (the ladder's bottom rung); out-of-
 * ladder ranks degrade to their numeral.
 */
export function formatAgeBadge(rank: number | undefined): string {
  const index = Math.max(
    0,
    Math.min(AGE_BADGE_NAMES.length - 1, (rank ?? 1) - 1),
  );
  return `${AGE_NUMERALS[index]} · ${AGE_BADGE_NAMES[index]}`;
}

const capitalize = (id: AiDifficultyId): string =>
  id.charAt(0).toUpperCase() + id.slice(1);

/**
 * Human disclosure fragment for one knob vs the normal preset:
 * `÷3` for a three-times-larger interval, `×2` for a twice-as-fast
 * one, `instant` for a zero delay, and "" when it matches normal.
 */
function knobFragment(label: string, value: number, base: number): string {
  if (value === base) return "";
  if (value === 0) return `${label} instant`;
  const ratio = value / base;
  // Ratios ≥ 1 read naturally as divisors (90-tick decisions = ÷3,
  // "three times slower"); sub-1 ratios as multipliers (15 ticks = ×2).
  return ratio > 1
    ? `${label} ÷${Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(1)}`
    : `${label} ×${Number.isInteger(1 / ratio) ? String(1 / ratio) : (1 / ratio).toFixed(1)}`;
}

/**
 * The §2.8 disclosure line for one difficulty preset: the label plus
 * EVERY knob that deviates from normal — decision-interval scale,
 * reaction-latency scale and (hard only) the income multiplier cheat.
 * Normal renders as just `AI Normal`. Data-driven from
 * AI_DIFFICULTIES so a future preset cannot dodge disclosure.
 */
export function formatDifficultyBadge(id: AiDifficultyId): string {
  const config: AiDifficultyConfig = AI_DIFFICULTIES[id];
  const base = AI_DIFFICULTIES.normal;
  const parts: string[] = [];
  const interval = knobFragment(
    "decisions",
    config.decisionIntervalTicks,
    base.decisionIntervalTicks,
  );
  if (interval !== "") parts.push(interval);
  const reaction = knobFragment(
    "reactions",
    config.reactionDelayTicks,
    base.reactionDelayTicks,
  );
  if (reaction !== "") parts.push(reaction);
  if (config.incomeMultiplier !== base.incomeMultiplier) {
    parts.push(`income ×${String(config.incomeMultiplier)}`);
  }
  return parts.length === 0
    ? `AI ${capitalize(id)}`
    : `AI ${capitalize(id)} · ${parts.join(" · ")}`;
}

export function createTopbar(seed: number): TopbarHandle {
  const bar = document.createElement("div");
  bar.id = "topbar";
  const text = document.createElement("span");
  text.id = "topbar-status";
  const ageBadge = document.createElement("span");
  ageBadge.id = "topbar-age";
  const difficultyBadge = document.createElement("span");
  difficultyBadge.id = "topbar-difficulty";
  const resources = document.createElement("div");
  resources.id = "topbar-resources";
  bar.append(text, ageBadge, difficultyBadge, resources);
  document.body.appendChild(bar);

  let lastStatus = "";
  let lastResources = "";
  let lastAge = "";
  let lastDifficulty = "";

  return {
    update(tick: number, fpsText: string, stockText?: string): void {
      const nextStatus = `seed ${String(seed)} · tick ${String(tick)} · ${fpsText} fps`;
      if (nextStatus !== lastStatus) {
        lastStatus = nextStatus;
        text.textContent = nextStatus;
      }
      if (stockText !== undefined && stockText !== lastResources) {
        lastResources = stockText;
        resources.textContent = stockText;
      }
    },
    updateAge(rank: number | undefined): void {
      const nextAge = formatAgeBadge(rank);
      if (nextAge === lastAge) return;
      lastAge = nextAge;
      ageBadge.textContent = nextAge;
      ageBadge.dataset.ageRank = String(rank ?? 0);
    },
    updateDifficulty(id: AiDifficultyId): void {
      const nextDifficulty = formatDifficultyBadge(id);
      if (nextDifficulty === lastDifficulty) return;
      lastDifficulty = nextDifficulty;
      difficultyBadge.textContent = nextDifficulty;
      difficultyBadge.dataset.difficulty = id;
    },
  };
}

/**
 * Format a stockpile snapshot row as the canonical topbar line over all
 * seven §2.6 gatherables, e.g. `food 12 · wood 340 · gold 0 · stone 0 ·
 * iron 5 · coal 3 · clay 8`. Missing/short rows render their zeros —
 * pass `[]` for the pre-stockpile default line.
 */
export function formatStockpileLine(amounts: readonly number[]): string {
  const parts: string[] = [];
  for (let code = 0; code < RESOURCE_NAMES.length; code++) {
    parts.push(`${RESOURCE_NAMES[code]!} ${String(amounts[code] ?? 0)}`);
  }
  return parts.join(" · ");
}
