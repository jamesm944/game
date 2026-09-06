/**
 * Unit selection bottom HUD panel — SPEC §2.13 / V13 (Part of #88, #90).
 *
 * AoE2-style unit selection interface:
 * - Single unit selected: Large portrait with player-color frame, unit name,
 *   full HP bar (colored green → yellow → red by health percentage), and
 *   attack, armor, range, and speed stats.
 * - 2 to 12 units selected: Responsive grid of mini unit cards with individual
 *   HP meters. Clicking any card focuses / selects just that unit.
 * - 13+ units selected: Multi-unit summary with bulk count, aggregate health bar,
 *   and breakdown chips by unit type.
 * - 0 units selected: Panel automatically hides.
 *
 * Glassmorphic dark card design consistent with #building-panel.
 */

import { playerColorOf } from "../render/playerColors";

export interface SelectedUnitSummary {
  readonly eid: number;
  readonly unitId: string;
  readonly name: string;
  readonly popName?: string | undefined;
  readonly hp: number;
  readonly maxHp: number;
  readonly attack: number;
  readonly armor: number;
  readonly range?: number | undefined;
  readonly speed: number;
  readonly ownerId: number;
  readonly isMilitary: boolean;
  readonly morphTargetId?: string | undefined;
  readonly siegeState?: "mobile" | "packed" | "unpacked" | undefined;
}

export interface UnitPanelDeps {
  readonly onFocusUnit?: (eid: number) => void;
  readonly onFilterByType?: (unitId: string) => void;
  readonly onPackUnit?: (eid: number) => void;
  readonly onUnpackUnit?: (eid: number) => void;
}

export interface UnitPanelHandle {
  readonly element: HTMLElement;
  update(units: readonly SelectedUnitSummary[]): void;
  hide(): void;
}

export interface HpBarInfo {
  readonly pct: number;
  readonly color: string;
  readonly label: string;
}

/** Pure helper to format HP fraction into percentage, color, and label. */
export function formatUnitHpBar(hp: number, maxHp: number): HpBarInfo {
  const safeMax = Math.max(1, maxHp);
  const clampedHp = Math.max(0, Math.min(safeMax, hp));
  const pct = Math.round((clampedHp / safeMax) * 100);

  let color = "#22c55e"; // Green (>50%)
  if (pct <= 25) {
    color = "#ef4444"; // Red (≤25%)
  } else if (pct <= 50) {
    color = "#eab308"; // Yellow (26-50%)
  }

  return {
    pct,
    color,
    label: `${Math.ceil(clampedHp)} / ${safeMax}`,
  };
}

export function formatUnitCardTitle(unit: SelectedUnitSummary): string {
  return unit.popName ? `${unit.popName} (${unit.name})` : unit.name;
}

export function formatUnitStats(unit: SelectedUnitSummary): string {
  const parts = [`⚔ ${String(unit.attack)}`, `🛡 ${String(unit.armor)}`];
  if (unit.range !== undefined && unit.range > 1) {
    parts.push(`🏹 ${String(unit.range)}`);
  }
  parts.push(`🏃 ${unit.speed.toFixed(1)}`);
  return parts.join("  ");
}

export interface UnitTypeGroup {
  readonly unitId: string;
  readonly name: string;
  readonly count: number;
  readonly totalHp: number;
  readonly totalMaxHp: number;
}

/** Aggregate units into type groups for bulk display. */
export function groupUnitsByType(
  units: readonly SelectedUnitSummary[],
): readonly UnitTypeGroup[] {
  const map = new Map<
    string,
    { name: string; count: number; totalHp: number; totalMaxHp: number }
  >();

  for (const u of units) {
    const existing = map.get(u.unitId);
    if (existing) {
      existing.count += 1;
      existing.totalHp += u.hp;
      existing.totalMaxHp += u.maxHp;
    } else {
      map.set(u.unitId, {
        name: u.name,
        count: 1,
        totalHp: u.hp,
        totalMaxHp: u.maxHp,
      });
    }
  }

  return [...map.entries()].map(([unitId, data]) => ({
    unitId,
    name: data.name,
    count: data.count,
    totalHp: data.totalHp,
    totalMaxHp: data.totalMaxHp,
  }));
}

/** Unit class SVG icons (clean silhouettes). */
function getUnitIconSvg(unitId: string): string {
  if (unitId.includes("villager")) {
    // Pickaxe / Builder
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14.5 9.5L5 19l-2-2 9.5-9.5"/>
      <path d="M12 4l3-3 5 5-3 3"/>
      <path d="M18 10l-4-4"/>
    </svg>`;
  }
  if (
    unitId.includes("archer") ||
    unitId.includes("arbalest") ||
    unitId.includes("skirmisher")
  ) {
    // Bow & Arrow
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 5L5 19"/>
      <path d="M15 5h4v4"/>
      <path d="M5 9c0 5.5 4.5 10 10 10"/>
    </svg>`;
  }
  if (
    unitId.includes("cavalry") ||
    unitId.includes("knight") ||
    unitId.includes("paladin") ||
    unitId.includes("cavalier")
  ) {
    // Cavalry / Knight Helmet
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5z"/>
      <path d="M8 14v4a4 4 0 0 0 8 0v-4"/>
      <line x1="10" y1="9" x2="14" y2="9"/>
      <line x1="12" y1="7" x2="12" y2="11"/>
    </svg>`;
  }
  if (unitId.includes("monk")) {
    // Monk / Cross
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2v20"/>
      <path d="M7 8h10"/>
      <circle cx="12" cy="5" r="2"/>
    </svg>`;
  }
  if (unitId.includes("trade-cart")) {
    // Cart / Wheel
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="18" r="3"/>
      <path d="M6 15h12l2-7H4l2 7z"/>
      <path d="M2 5h20"/>
    </svg>`;
  }
  if (unitId.includes("ram")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="8" width="20" height="8" rx="2"/>
      <path d="M6 16v4M18 16v4M2 12h20"/>
    </svg>`;
  }
  if (unitId.includes("mangonel") || unitId.includes("catapult")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="7" cy="18" r="3"/>
      <circle cx="17" cy="18" r="3"/>
      <path d="M7 15l8-8M15 7h4v4"/>
    </svg>`;
  }
  if (unitId.includes("trebuchet")) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 20h16M12 20V8M6 8l12-4M18 4l2 6"/>
      <circle cx="6" cy="8" r="2"/>
    </svg>`;
  }
  // Swordsman / Infantry default
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="14.5 17.5 3 6 6 3 17.5 14.5"/>
    <line x1="13" y1="19" x2="19" y2="13"/>
    <line x1="16" y1="16" x2="20" y2="20"/>
    <line x1="19" y1="21" x2="21" y2="19"/>
  </svg>`;
}

export function createUnitPanel(deps: UnitPanelDeps = {}): UnitPanelHandle {
  const panel = document.createElement("div");
  panel.id = "unit-panel";
  panel.className = "unit-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  let lastUnitCount = -1;
  let lastFirstEid = -1;
  let lastHpString = "";

  function renderSingle(unit: SelectedUnitSummary): void {
    const hpInfo = formatUnitHpBar(unit.hp, unit.maxHp);
    const pColor = playerColorOf(unit.ownerId);
    const displayName = unit.popName ? `${unit.popName} (${unit.name})` : unit.name;

    panel.innerHTML = `
      <div class="unit-single-card">
        <div class="unit-portrait-box" style="border-color: ${pColor.hex};">
          <div class="unit-icon-wrap" style="color: ${pColor.hex};">
            ${getUnitIconSvg(unit.unitId)}
          </div>
          <span class="unit-player-tag" style="background: ${pColor.hex};">${pColor.name}</span>
        </div>
        <div class="unit-info-col">
          <div class="unit-name-row">
            <h3 class="unit-title">${displayName}</h3>
          </div>
          <div class="unit-hp-box">
            <div class="unit-hp-bar">
              <div class="unit-hp-fill" style="width: ${hpInfo.pct}%; background-color: ${hpInfo.color};"></div>
            </div>
            <span class="unit-hp-text">${hpInfo.label}</span>
          </div>
          <div class="unit-stats-row">
            <span class="unit-stat" title="Attack">⚔ ${unit.attack}</span>
            <span class="unit-stat" title="Armour">🛡 ${unit.armor}</span>
            ${unit.range !== undefined && unit.range > 1 ? `<span class="unit-stat" title="Range">🏹 ${unit.range}</span>` : ""}
            <span class="unit-stat" title="Speed">🏃 ${unit.speed.toFixed(1)}</span>
          </div>
          ${
            unit.morphTargetId
              ? `<div class="unit-action-row" style="margin-top: 6px;">
                  <button type="button" class="unit-pack-btn" style="padding: 3px 8px; font-size: 11px; background: #3b82f6; border: 1px solid #60a5fa; border-radius: 4px; color: #fff; cursor: pointer;">
                    ${unit.siegeState === "packed" ? "Unpack" : "Pack"}
                  </button>
                </div>`
              : ""
          }
        </div>
      </div>
    `;

    if (unit.morphTargetId) {
      const btn = panel.querySelector(".unit-pack-btn");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (unit.siegeState === "packed") {
            deps.onUnpackUnit?.(unit.eid);
          } else {
            deps.onPackUnit?.(unit.eid);
          }
        });
      }
    }
  }

  function renderMulti(units: readonly SelectedUnitSummary[]): void {
    panel.innerHTML = `
      <div class="unit-multi-container">
        <div class="unit-multi-header">
          <span class="unit-multi-title">Selected Units (${units.length})</span>
          <span class="unit-multi-hint">Click a unit to focus</span>
        </div>
        <div class="unit-grid-12"></div>
      </div>
    `;

    const grid = panel.querySelector(".unit-grid-12")!;
    for (const unit of units) {
      const hpInfo = formatUnitHpBar(unit.hp, unit.maxHp);
      const pColor = playerColorOf(unit.ownerId);

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "unit-grid-cell";
      cell.title = `${unit.name} (${hpInfo.label})`;
      cell.style.borderColor = pColor.hex;

      cell.innerHTML = `
        <div class="unit-cell-icon" style="color: ${pColor.hex};">
          ${getUnitIconSvg(unit.unitId)}
        </div>
        <div class="unit-cell-hp-bar">
          <div class="unit-cell-hp-fill" style="width: ${hpInfo.pct}%; background-color: ${hpInfo.color};"></div>
        </div>
      `;

      cell.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deps.onFocusUnit?.(unit.eid);
      });

      grid.appendChild(cell);
    }
  }

  function renderBulk(units: readonly SelectedUnitSummary[]): void {
    let totalHp = 0;
    let totalMaxHp = 0;
    for (const u of units) {
      totalHp += u.hp;
      totalMaxHp += u.maxHp;
    }

    const hpInfo = formatUnitHpBar(totalHp, totalMaxHp);
    const groups = groupUnitsByType(units);

    panel.innerHTML = `
      <div class="unit-bulk-container">
        <div class="unit-multi-header">
          <span class="unit-multi-title">${units.length} Units Selected</span>
        </div>
        <div class="unit-hp-box" style="margin-top: 4px;">
          <div class="unit-hp-bar">
            <div class="unit-hp-fill" style="width: ${hpInfo.pct}%; background-color: ${hpInfo.color};"></div>
          </div>
          <span class="unit-hp-text">Army HP: ${hpInfo.label}</span>
        </div>
        <div class="unit-type-chips"></div>
      </div>
    `;

    const chipsContainer = panel.querySelector(".unit-type-chips")!;
    for (const group of groups) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "unit-type-chip";
      chip.innerHTML = `
        <span class="unit-chip-icon">${getUnitIconSvg(group.unitId)}</span>
        <span class="unit-chip-label">${group.count} × ${group.name}</span>
      `;

      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deps.onFilterByType?.(group.unitId);
      });

      chipsContainer.appendChild(chip);
    }
  }

  return {
    element: panel,
    update(units: readonly SelectedUnitSummary[]): void {
      if (units.length === 0) {
        if (panel.style.display !== "none") {
          panel.classList.remove("visible");
          panel.style.display = "none";
        }
        lastUnitCount = 0;
        return;
      }

      panel.style.display = "block";
      panel.classList.add("visible");

      // Check if we can fast-path or need full rebuild
      const hpKey = units.map((u) => Math.ceil(u.hp)).join(",");
      const firstEid = units[0] ? units[0].eid : -1;
      const count = units.length;

      if (count === lastUnitCount && firstEid === lastFirstEid && hpKey === lastHpString) {
        return;
      }

      lastUnitCount = count;
      lastFirstEid = firstEid;
      lastHpString = hpKey;

      if (count === 1) {
        renderSingle(units[0]!);
      } else if (count <= 12) {
        renderMulti(units);
      } else {
        renderBulk(units);
      }
    },
    hide(): void {
      panel.classList.remove("visible");
      panel.style.display = "none";
      lastUnitCount = 0;
    },
  };
}
