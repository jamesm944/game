/**
 * Multi-Player Score & Team Leaderboard HUD — Milestone S3 (Issue #116).
 *
 * Real-time match leaderboard displaying:
 * - Player color swatch & name.
 * - Live civilization score based on economic wealth, military strength,
 *   buildings, and technological age advancement.
 * - Current Age rank badge (I · Dark, II · Feudal, III · Castle, IV · Imperial).
 * - Match status (Active, Defeated, Surrendered).
 */

import type { World } from "../sim/core/world";
import type { SimComponents } from "../sim/components";
import { ageRankOf } from "../sim/components/age";

export interface PlayerScoreInfo {
  readonly playerId: number;
  readonly name: string;
  readonly color: string;
  readonly score: number;
  readonly ageRank: number;
  readonly status: "active" | "surrendered" | "defeated";
  readonly isAllied?: boolean | undefined;
}

export interface ScoreLeaderboardHandle {
  readonly element: HTMLDivElement;
  update(players: readonly PlayerScoreInfo[]): void;
  show(): void;
  hide(): void;
  toggle(): void;
}

const AGE_NUMERALS = ["I", "II", "III", "IV"] as const;

/**
 * Calculate standard RTS score for a player:
 * - Economy: 20% of current stockpiled resources.
 * - Military: 25 points per combat/military unit owned.
 * - Buildings: 35 points per standing finished building.
 * - Technology: 400 points per age advancement.
 */
export function calculatePlayerScore(
  world: World,
  comps: SimComponents,
  playerId: number,
): number {
  // 1. Economic score: 20% of player's stockpiled resources
  let econScore = 0;
  const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
  if (stockpileRows) {
    for (const [, row] of stockpileRows) {
      if (row[0] === playerId) {
        let totalRes = 0;
        for (let i = 1; i < row.length; i++) {
          totalRes += row[i] ?? 0;
        }
        econScore = Math.floor(totalRes * 0.2);
        break;
      }
    }
  }

  // 2. Military units: 25 points per combat unit
  let militaryCount = 0;
  const combatRows = world.rowsByComponentId.get(comps.combatId);
  if (combatRows) {
    for (const [, row] of combatRows) {
      if (row[1] === playerId) militaryCount++;
    }
  }
  const militaryScore = militaryCount * 25;

  // 3. Buildings: 35 points per standing finished building
  let buildingCount = 0;
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  if (buildingRows) {
    for (const [, row] of buildingRows) {
      if (row[0] === playerId) buildingCount++;
    }
  }
  const buildingScore = buildingCount * 35;

  // 4. Age advancement: 400 points per age rank above Dark Age
  const ageRank = ageRankOf(world, comps, playerId) ?? 1;
  const techScore = (ageRank - 1) * 400;

  return Math.max(0, econScore + militaryScore + buildingScore + techScore);
}

export function createScoreLeaderboard(): ScoreLeaderboardHandle {
  const container = document.createElement("div");
  container.id = "score-leaderboard";

  const header = document.createElement("div");
  header.className = "leaderboard-header";

  const title = document.createElement("span");
  title.className = "leaderboard-title";
  title.textContent = "Score";

  header.appendChild(title);
  container.appendChild(header);

  const listEl = document.createElement("div");
  listEl.id = "leaderboard-list";
  container.appendChild(listEl);

  document.body.appendChild(container);

  const update = (players: readonly PlayerScoreInfo[]): void => {
    // Sort players by score descending
    const sorted = [...players].sort((a, b) => b.score - a.score);

    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }
    for (const p of sorted) {
      const row = document.createElement("div");
      row.className = `leaderboard-row player-${String(p.playerId)}`;
      if (p.status !== "active") row.classList.add("defeated");

      const ageNumeral =
        AGE_NUMERALS[Math.max(0, Math.min(3, p.ageRank - 1))] ?? "I";

      const colorBar = document.createElement("span");
      colorBar.className = "lb-color-bar";
      colorBar.style.backgroundColor = p.color;

      const nameSpan = document.createElement("span");
      nameSpan.className = "lb-name";
      nameSpan.textContent = p.name;

      const ageBadge = document.createElement("span");
      ageBadge.className = "lb-age-badge";
      ageBadge.textContent = ageNumeral;

      const scoreSpan = document.createElement("span");
      scoreSpan.className = "lb-score";
      scoreSpan.textContent = p.score.toLocaleString();

      row.appendChild(colorBar);
      row.appendChild(nameSpan);
      row.appendChild(ageBadge);
      row.appendChild(scoreSpan);

      listEl.appendChild(row);
    }
  };

  const show = (): void => {
    container.hidden = false;
  };

  const hide = (): void => {
    container.hidden = true;
  };

  const toggle = (): void => {
    container.hidden = !container.hidden;
  };

  return {
    element: container,
    update,
    show,
    hide,
    toggle,
  };
}
