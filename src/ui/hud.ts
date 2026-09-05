/**
 * Topbar — SPEC §2.13/§2.6 / V13 (Part of #88, #92).
 *
 * Age of Empires 2 Definitive Edition quality resource bar:
 * - Color-coded SVG icons for all 7 gatherable resources + population.
 * - Horizontal compact bar fitting 1280px+ with clear tabular numbers.
 * - Prominent center-aligned Age badge with distinct color styling per age:
 *   Dark (Slate) → Feudal (Brown) → Castle (Crimson) → Imperial (Gold).
 * - Polished dark stone gradient header background with subtle amber border.
 * - Dev stats (seed, tick, fps) moved to a collapsible toggle on the right.
 * - AI difficulty disclosure badge on the right.
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

export interface AgeBadgeStyle {
  readonly background: string;
  readonly borderColor: string;
  readonly color: string;
}

/** Get background and border colors for a specific age rank. */
export function ageBadgeStyle(rank: number | undefined): AgeBadgeStyle {
  const r = rank ?? 1;
  switch (r) {
    case 1:
      // Dark Age: Slate
      return {
        background: "linear-gradient(135deg, #1e293b, #0f172a)",
        borderColor: "#475569",
        color: "#94a3b8",
      };
    case 2:
      // Feudal Age: Warm Wood / Bronze
      return {
        background: "linear-gradient(135deg, #78350f, #451a03)",
        borderColor: "#b45309",
        color: "#fed7aa",
      };
    case 3:
      // Castle Age: Crimson / Burgundy
      return {
        background: "linear-gradient(135deg, #881337, #4c0519)",
        borderColor: "#e11d48",
        color: "#fecdd3",
      };
    case 4:
    default:
      // Imperial Age: Royal Gold
      return {
        background: "linear-gradient(135deg, #854d0e, #713f12)",
        borderColor: "#eab308",
        color: "#fef08a",
      };
  }
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

export interface ParsedResourceItem {
  readonly name: string;
  readonly value: string;
}

/** Parse raw stockpile + pop text line into structured items. */
export function parseStockpileLine(stockText: string): ParsedResourceItem[] {
  if (!stockText) return [];
  const tokens = stockText.split(" · ");
  const items: ParsedResourceItem[] = [];
  for (const token of tokens) {
    const space = token.indexOf(" ");
    if (space === -1) continue;
    const name = token.slice(0, space).trim();
    const value = token.slice(space + 1).trim();
    items.push({ name, value });
  }
  return items;
}

/** In-house CC0 SVG silhouettes for all 7 resources and population. */
export function resourceIconSvg(name: string): string {
  switch (name.toLowerCase()) {
    case "food":
      // Wheat Sheaf
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#f59e0b">
        <path d="M10 2c-1.5 2-1.5 5 0 7 1.5-2 1.5-5 0-7zm-3 4c-1.8 1.5-2.2 4.5-.8 6.5 2-1 2.5-4 .8-6.5zm6 0c-1.7 2.5-1.2 5.5.8 6.5 1.4-2 1-5-.8-6.5zm-5 6c-1.8 1.5-2.2 4.5-.8 6.5 2-1 2.5-4 .8-6.5zm4 0c-1.7 2.5-1.2 5.5.8 6.5 1.4-2 1-5-.8-6.5z"/>
        <path d="M10 9v9" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`;
    case "wood":
      // Tree / Timber
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#b45309">
        <path d="M10 2L3 13h4l-2 4h10l-2-4h4L10 2z"/>
      </svg>`;
    case "gold":
      // Gold Bullion
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#fbbf24">
        <path d="M3 13l3-6h8l3 6H3zm2 4l2-2h6l2 2H5z"/>
        <path d="M4 14h12v2H4z"/>
      </svg>`;
    case "stone":
      // Stone Block
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#94a3b8">
        <rect x="2" y="4" width="7" height="5" rx="1"/>
        <rect x="11" y="4" width="7" height="5" rx="1"/>
        <rect x="2" y="11" width="16" height="5" rx="1"/>
        <line x1="10" y1="11" x2="10" y2="16" stroke="rgb(16 20 28)" stroke-width="1.5"/>
      </svg>`;
    case "iron":
      // Anvil / Metal
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#cbd5e1">
        <path d="M2 6h15l1 3h-4v2c1 2 2 3 4 4v1H2v-1c2-1 3-2 4-4V9H5L2 6z"/>
      </svg>`;
    case "coal":
      // Coal Lump
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#64748b">
        <polygon points="10,2 17,7 15,16 5,16 3,7"/>
        <polyline points="3,7 10,12 17,7" stroke="#334155" stroke-width="1.2"/>
        <line x1="10" y1="12" x2="10" y2="18" stroke="#334155" stroke-width="1.2"/>
      </svg>`;
    case "clay":
      // Clay Amphora / Jar
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#ea580c">
        <path d="M6 3h8v2H6zM5 7c0-1 1-2 2-2h6c1 0 2 1 2 2 0 3-1 7-2 9H7C6 14 5 10 5 7z"/>
        <path d="M4 8c-1 0-2 1-2 2s1 2 2 2M16 8c1 0 2 1 2 2s-1 2-2 2" stroke="#ea580c" stroke-width="1.2"/>
      </svg>`;
    case "pop":
    default:
      // Population Helmet
      return `<svg viewBox="0 0 20 20" width="15" height="15" fill="#38bdf8">
        <circle cx="10" cy="6" r="4"/>
        <path d="M3 18c0-3.5 3-6 7-6s7 2.5 7 6H3z"/>
      </svg>`;
  }
}

export function createTopbar(seed: number): TopbarHandle {
  const bar = document.createElement("div");
  bar.id = "topbar";
  bar.className = "topbar";

  // Left: Resource items
  const resources = document.createElement("div");
  resources.id = "topbar-resources";
  resources.className = "topbar-resources";

  // Center: Prominent Age Badge
  const centerCol = document.createElement("div");
  centerCol.className = "topbar-center";
  const ageBadge = document.createElement("span");
  ageBadge.id = "topbar-age";
  ageBadge.className = "topbar-age-badge";
  centerCol.appendChild(ageBadge);

  // Right: Difficulty + Dev status collapsible
  const rightCol = document.createElement("div");
  rightCol.className = "topbar-right";

  const difficultyBadge = document.createElement("span");
  difficultyBadge.id = "topbar-difficulty";
  difficultyBadge.className = "topbar-difficulty";

  const devToggle = document.createElement("button");
  devToggle.id = "topbar-dev-toggle";
  devToggle.className = "topbar-dev-toggle";
  devToggle.type = "button";
  devToggle.title = "Toggle developer stats";
  devToggle.textContent = "DEV";

  const devOverlay = document.createElement("div");
  devOverlay.id = "topbar-dev-overlay";
  devOverlay.className = "topbar-dev-overlay";
  devOverlay.style.display = "none";

  const text = document.createElement("span");
  text.id = "topbar-status";
  devOverlay.appendChild(text);

  devToggle.addEventListener("click", () => {
    devOverlay.style.display =
      devOverlay.style.display === "none" ? "block" : "none";
  });

  rightCol.append(difficultyBadge, devToggle, devOverlay);
  bar.append(resources, centerCol, rightCol);
  document.body.appendChild(bar);

  let lastStatus = "";
  let lastResources = "";
  let lastAge = "";
  let lastDifficulty = "";

  function paintResources(stockText: string): void {
    const items = parseStockpileLine(stockText);
    resources.innerHTML = "";
    for (const item of items) {
      const el = document.createElement("div");
      el.className = "topbar-res-pill";
      el.dataset.res = item.name.toLowerCase();
      el.title = item.name;

      el.innerHTML = `
        <span class="topbar-res-icon">${resourceIconSvg(item.name)}</span>
        <span class="topbar-res-value">${item.value}</span>
      `;
      resources.appendChild(el);
    }
  }

  return {
    update(tick: number, fpsText: string, stockText?: string): void {
      const nextStatus = `seed ${String(seed)} · tick ${String(tick)} · ${fpsText} fps`;
      if (nextStatus !== lastStatus) {
        lastStatus = nextStatus;
        text.textContent = nextStatus;
      }
      if (stockText !== undefined && stockText !== lastResources) {
        lastResources = stockText;
        paintResources(stockText);
      }
    },
    updateAge(rank: number | undefined): void {
      const nextAge = formatAgeBadge(rank);
      if (nextAge === lastAge) return;
      const isInitial = lastAge === "";
      lastAge = nextAge;
      ageBadge.textContent = nextAge;
      ageBadge.dataset.ageRank = String(rank ?? 1);

      const style = ageBadgeStyle(rank);
      ageBadge.style.background = style.background;
      ageBadge.style.borderColor = style.borderColor;
      ageBadge.style.color = style.color;

      if (!isInitial && rank !== undefined) {
        ageBadge.classList.remove("age-up-pop");
        void ageBadge.offsetWidth;
        ageBadge.classList.add("age-up-pop");
      }
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
