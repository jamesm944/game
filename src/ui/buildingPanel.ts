/**
 * Building selection panel — SPEC §2.13 / M1-T10.
 *
 * Selecting a single construction site shows its build progress bar
 * and builder count; selecting a finished production building (M1:
 * town-center) shows its training queue with per-entry countdowns plus
 * the live population/cap line, and a Train Villager button issuing the
 * authoritative `{kind:"trainVillager"}` command. Data flows in from a
 * polling callback each refresh — the same rows golden digests hash.
 */

import type { CommandInbox } from "../sim/core/inbox";

export interface BuildingPanelQueueEntry {
  readonly label: string;
  readonly remainingTicks: number;
}

export interface BuildingPanelData {
  /** e.g. "Town Center" / "House — under construction". */
  readonly title: string;
  /** Construction progress clamped [0,1] (sites only). */
  readonly progress01?: number | undefined;
  /** Builders currently assigned (sites only). */
  readonly builders?: number | undefined;
  /** Production queue, head first. */
  readonly queue?: readonly BuildingPanelQueueEntry[];
  /** Population line, e.g. { current: 6, cap: 15 }. */
  readonly pop?: { current: number; cap: number } | undefined;
  /** Show the train button (production buildings only). */
  readonly canTrain?: boolean | undefined;
  /**
   * Recipe workshop line (M2-T3): current recipe + per-input
   * availability + running/stalled state. Excluded from the structural
   * rebuild key — it repaints through text comparison every frame.
   */
  readonly production?:
    { readonly recipeLabel: string; readonly line: string } | undefined;
}

const TRAIN_VILLAGER_KIND = "trainVillager";

/** Issue one authoritative trainVillager order for `currentTick + 1`. */
export function issueTrainVillager(
  inbox: CommandInbox,
  currentTick: number,
): void {
  inbox.submit({
    kind: TRAIN_VILLAGER_KIND,
    targetTick: currentTick + 1,
    data: {},
  });
}

export function createBuildingPanel(deps: {
  getData(): BuildingPanelData | undefined;
  currentTick(): number;
  inbox: CommandInbox;
}): { refresh(): void } {
  const panel = document.createElement("div");
  panel.id = "building-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  const titleEl = document.createElement("h3");
  const barWrap = document.createElement("div");
  barWrap.className = "panel-bar";
  const barFill = document.createElement("div");
  barFill.className = "panel-bar-fill";
  barWrap.appendChild(barFill);
  const metaEl = document.createElement("div");
  metaEl.className = "panel-meta";
  const queueEl = document.createElement("div");
  queueEl.className = "panel-queue";
  const productionEl = document.createElement("div");
  productionEl.className = "panel-production";
  const trainButton = document.createElement("button");
  trainButton.type = "button";
  trainButton.className = "panel-train";
  trainButton.textContent = "Train Villager (50 food)";
  trainButton.addEventListener("click", () => {
    issueTrainVillager(deps.inbox, deps.currentTick());
  });

  let lastKey = "";

  return {
    refresh(): void {
      const data = deps.getData();
      if (!data) {
        if (lastKey !== "") {
          lastKey = "";
          panel.style.display = "none";
        }
        return;
      }
      // The production line is volatile (countdowns/stock counts change
      // every tick) — structural rebuilds key off everything else.
      const { production, ...structural } = data;
      const key = JSON.stringify(structural);
      const structuralChange = key !== lastKey;
      if (structuralChange) {
        lastKey = key;
        panel.style.display = "block";
        while (panel.firstChild) panel.firstChild.remove();
        panel.append(titleEl, barWrap, metaEl, queueEl, productionEl);
        titleEl.textContent = data.title;
        metaEl.textContent = "";
        queueEl.textContent = "";
        if (data.queue !== undefined) panel.appendChild(trainButton);
        trainButton.disabled = !(data.canTrain ?? false);
      }

      // Progress bar repaints every frame during construction.
      if (data.progress01 !== undefined) {
        barWrap.style.display = "block";
        barFill.style.width = `${Math.round(Math.min(1, Math.max(0, data.progress01)) * 100)}%`;
      } else {
        barWrap.style.display = "none";
      }
      const metaParts: string[] = [];
      if (data.builders !== undefined) {
        metaParts.push(
          `${String(data.builders)} builder${data.builders === 1 ? "" : "s"}`,
        );
      }
      if (data.pop) {
        metaParts.push(
          `pop ${String(data.pop.current)}/${String(data.pop.cap)}`,
        );
      }
      const metaText = metaParts.join(" · ");
      if (metaEl.textContent !== metaText) metaEl.textContent = metaText;

      const queueText =
        data.queue === undefined
          ? ""
          : data.queue.length === 0
            ? "queue empty"
            : data.queue
                .map(
                  (entry) =>
                    `${entry.label} ${String(Math.max(0, entry.remainingTicks) / 30 <= 0 ? "done" : `${(entry.remainingTicks / 30).toFixed(1)}s`)}`,
                )
                .join(" → ");
      if (queueEl.textContent !== queueText) queueEl.textContent = queueText;

      // Recipe workshop line: "Planks — wood 4/2 · running 8.3s".
      let productionText = "";
      if (production) {
        productionText = `${production.recipeLabel} — ${production.line}`;
      }
      if (productionEl.textContent !== productionText) {
        productionEl.textContent = productionText;
      }
    },
  };
}
