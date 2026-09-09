/**
 * Build menu — SPEC §2.13 prototype-validated placement UX (M1-T10).
 *
 * Grid bottom-left with one button per placeable M1 definition
 * (town-center · house · barracks). Clicking a button ARMS placement:
 * the canvas cursor drives a grid-snapped ghost (render/buildGhost.ts)
 * whose green/red validity comes from the SAME validatePlacement the
 * sim command handler enforces — the menu can never offer a placement
 * the sim would reject. Click-to-place issues `{kind:"placeBuilding"}`
 * into the sim inbox at `currentTick + 1`; Esc/right-click disarms.
 *
 * Affordability greys buttons live from stockpile rows each refresh.
 * The pure issuer + snapping helpers are importable headlessly; all
 * element creation lives inside the wiring factory.
 */

import type { CommandInbox, SimCommand } from "../sim/core/inbox";
import { BUILDING_DEFINITIONS } from "../data/definitions";

/**
 * Build-menu order: the M1 demo flow first, then the feudal-age
 * military/support set (M2). Age-gated entries render locked until the
 * player's current age clears each definition's ageGate.
 */
export const BUILD_MENU_IDS: readonly string[] = [
  "town-center",
  "house",
  "barracks",
  "mill",
  "farm",
  "lumber-camp",
  "mining-camp",
  "dock",
  "palisade-wall",
  "stone-wall",
  "palisade-gate",
  "stone-gate",
  "church",
  "school",
  "blacksmith",
  "market",
  "archery-range",
  "stable",
  "watch-tower",
  "castle",
  "monastery",
  "monument",
  "grand-monument",
  "grand-academy",
  "wonder",
];

/** Legacy alias (M1 demo flow prefix of BUILD_MENU_IDS). */
export const M1_BUILD_MENU_IDS = BUILD_MENU_IDS.slice(0, 3);

/** Issue one authoritative placeBuilding order for `currentTick + 1`. */
export function issuePlaceBuilding(
  inbox: CommandInbox,
  currentTick: number,
  defId: string,
  tileX: number,
  tileY: number,
): SimCommand {
  if (
    !Number.isInteger(tileX) ||
    !Number.isInteger(tileY) ||
    tileX < 0 ||
    tileY < 0
  ) {
    throw new Error(
      `placeBuilding needs non-negative integer tiles, got (${String(tileX)}, ${String(tileY)})`,
    );
  }
  const command: SimCommand = {
    kind: PLACE_BUILDING_KIND,
    targetTick: currentTick + 1,
    data: { defId, tileX, tileY },
  };
  inbox.submit(command);
  return command;
}

// The literal mirrors sim/systems/placement.ts PLACE_BUILDING_KIND to
// keep this UI module importable without dragging systems in headlessly.
const PLACE_BUILDING_KIND = "placeBuilding";

/**
 * Snap a pointer's world position to the footprint origin that centers
 * the ghost under the cursor: floor(p − size/2). Pure.
 */
export function snapGhostOrigin(
  px: number,
  py: number,
  widthTiles: number,
  heightTiles: number,
): { tileX: number; tileY: number } {
  return {
    tileX: Math.floor(px - widthTiles / 2),
    tileY: Math.floor(py - heightTiles / 2),
  };
}

export interface BuildMenuDeps {
  /** Live affordability from stockpile rows (per definition id). */
  canAfford(defId: string): boolean;
  /**
   * Live age-gate verdict per definition id (M2-T4): false greys the
   * button with a "Requires …" lock label until the age is reached.
   * Omitted = everything unlocked (headless/tests).
   */
  ageUnlocked?(defId: string): boolean;
  /** Called whenever the armed selection CHANGES (null = disarmed). */
  onArm(defId: string | null): void;
  onClick?(): void;
}

export interface BuildMenuHandle {
  refresh(): void;
  armedDefId(): string | null;
  disarm(): void;
}

export function wireBuildMenu(deps: BuildMenuDeps): BuildMenuHandle {
  const menu = document.createElement("div");
  menu.id = "build-menu";
  const title = document.createElement("h3");
  title.textContent = "Build";
  const grid = document.createElement("div");
  grid.className = "build-grid";
  menu.append(title, grid);
  document.body.appendChild(menu);

  let armed: string | null = null;

  const buttons = BUILD_MENU_IDS.map((defId) => {
    const def = BUILDING_DEFINITIONS.get(defId);
    if (!def) throw new Error(`build menu references unknown def ${defId}`);
    const button = document.createElement("button");
    button.className = "build-button";
    button.type = "button";
    button.dataset.defId = defId;
    const name = document.createElement("span");
    name.className = "build-name";
    name.textContent = def.name;
    const cost = document.createElement("span");
    cost.className = "build-cost";
    cost.textContent = Object.entries(def.costs)
      .filter(([, amount]) => amount > 0)
      .map(([slug, amount]) => `${slug} ${String(amount)}`)
      .join(" · ");
    const size = document.createElement("span");
    size.className = "build-size";
    size.textContent = `${String(def.footprint.width)}×${String(def.footprint.height)}`;
    button.append(name, cost, size);
    button.addEventListener("click", () => {
      deps.onClick?.();
      armed = armed === defId ? null : defId;
      deps.onArm(armed);
      paint();
    });
    grid.appendChild(button);
    return { defId, button, name };
  });

  function paint(): void {
    for (const entry of buttons) {
      const affordable = deps.canAfford(entry.defId);
      const unlocked = deps.ageUnlocked?.(entry.defId) ?? true;
      const def = BUILDING_DEFINITIONS.get(entry.defId);
      entry.button.classList.toggle("unaffordable", !affordable);
      entry.button.classList.toggle("age-locked", !unlocked);
      entry.button.classList.toggle("armed", armed === entry.defId);
      entry.button.disabled =
        (!affordable || !unlocked) && armed !== entry.defId;
      if (!unlocked) {
        entry.name.textContent = `${def?.name ?? entry.defId} — requires ${def?.ageGate ?? "?"} age`;
      } else {
        entry.name.textContent = def?.name ?? entry.defId;
      }
    }
  }

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code === "Escape" && armed !== null) {
      armed = null;
      deps.onArm(null);
      paint();
    }
  });

  return {
    refresh: paint,
    armedDefId: () => armed,
    disarm() {
      if (armed !== null) {
        armed = null;
        deps.onArm(null);
        paint();
      }
    },
  };
}
