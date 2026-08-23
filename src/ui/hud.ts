/**
 * Topbar — SPEC §2.13/§2.6 (M1-T8 chrome, M1-T9 resource readout,
 * M2-T2 full gatherable set, M2-T4 age badge).
 *
 * Line 1: seed · tick · fps, with the current-age icon-text badge
 * (roman rank + age name) beside it. Line 2: live stockpile counts per
 * gatherable resource — all SEVEN §2.6 slugs (food · wood · gold ·
 * stone · iron · coal · clay) — polled from the sim snapshot each
 * rendered frame. The numbers come straight from the Stockpile
 * component rows — the exact rows golden digests hash — so the topbar
 * cannot drift from the simulation.
 */

import { RESOURCE_NAMES } from "../sim/components/economy";

export interface TopbarHandle {
  update(tick: number, fpsText: string, stockText?: string): void;
  /** Repaint the current-age badge (hidden until a rank exists). */
  updateAge(rank: number | undefined): void;
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

export function createTopbar(seed: number): TopbarHandle {
  const bar = document.createElement("div");
  bar.id = "topbar";
  const text = document.createElement("span");
  text.id = "topbar-status";
  const ageBadge = document.createElement("span");
  ageBadge.id = "topbar-age";
  const resources = document.createElement("div");
  resources.id = "topbar-resources";
  bar.append(text, ageBadge, resources);
  document.body.appendChild(bar);

  let lastStatus = "";
  let lastResources = "";
  let lastAge = "";

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
