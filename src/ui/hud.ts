/**
 * Topbar — SPEC §2.13/§2.6 (M1-T8 chrome, M1-T9 resource readout).
 *
 * Line 1: seed · tick · fps. Line 2: live stockpile counts per
 * gatherable resource (food · wood · gold · stone), polled from the
 * sim snapshot each rendered frame. The numbers come straight from the
 * Stockpile component rows — the exact rows golden digests hash — so
 * the topbar cannot drift from the simulation.
 */

import { RESOURCE_NAMES } from "../sim/components/economy";

export interface TopbarHandle {
  update(tick: number, fpsText: string, stockText?: string): void;
}

export function createTopbar(seed: number): TopbarHandle {
  const bar = document.createElement("div");
  bar.id = "topbar";
  const text = document.createElement("span");
  text.id = "topbar-status";
  const resources = document.createElement("div");
  resources.id = "topbar-resources";
  bar.append(text, resources);
  document.body.appendChild(bar);

  let lastStatus = "";
  let lastResources = "";

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
  };
}

/**
 * Format a stockpile snapshot row as the canonical topbar line,
 * e.g. `food 12 · wood 340 · gold 0 · stone 0`.
 */
export function formatStockpileLine(amounts: readonly number[]): string {
  const parts: string[] = [];
  for (let code = 0; code < RESOURCE_NAMES.length; code++) {
    parts.push(`${RESOURCE_NAMES[code]!} ${String(amounts[code] ?? 0)}`);
  }
  return parts.join(" · ");
}
