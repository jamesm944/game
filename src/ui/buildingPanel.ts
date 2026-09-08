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

/** One ranked appointment candidate (M4-T1 §2.7). */
export interface BuildingPanelCandidate {
  readonly popId: number;
  /** e.g. "Alric · rating 3.4". */
  readonly label: string;
}

export interface BuildingPanelData {
  /** The selected building's entity id (appointment target). */
  readonly buildingEid?: number | undefined;
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
  /** Serving foreman label, e.g. "Foreman Alric · rating 3.4" (M4-T1). */
  readonly foreman?: string | undefined;
  /** Appointment candidates, best first (workplaces only). */
  readonly candidates?: readonly BuildingPanelCandidate[] | undefined;
  /** True if selected building is a Market for commodity trading. */
  readonly isMarket?: boolean | undefined;
  /** Number of active trade carts trading at or from this market (Issue #103). */
  readonly activeTradeCarts?: number | undefined;
  /** Train action options if trainable (unitId, label). */
  readonly trainableUnits?: readonly {
    readonly unitId: string;
    readonly label: string;
  }[];
  /** Garrison status if building can hold units (V13 #96). */
  readonly garrison?:
    | { readonly count: number; readonly capacity: number }
    | undefined;
  /** True if selected building is a Mill or Farm supporting auto-reseed toggle (V15 #105). */
  readonly canAutoReseed?: boolean | undefined;
  /** Current auto-reseed setting for player. */
  readonly autoReseedEnabled?: boolean | undefined;
  /** Remaining food on selected farm (if farm). */
  readonly farmFoodRemaining?: number | undefined;
}

const TRAIN_VILLAGER_KIND = "trainVillager";
export const TRAIN_UNIT_KIND = "trainUnit";
/** M4-T1 appointment command kind — validated by systems/management.ts. */
export const APPOINT_FOREMAN_KIND = "appointForeman";
export const MARKET_EXCHANGE_KIND = "marketExchange";
export const UNGARRISON_COMMAND_KIND = "ungarrison";
export const SET_AUTO_RESEED_COMMAND_KIND = "setAutoReseed";

export function issueSetAutoReseed(
  inbox: CommandInbox,
  currentTick: number,
  playerId: number,
  enabled: boolean,
): void {
  inbox.submit({
    kind: SET_AUTO_RESEED_COMMAND_KIND,
    targetTick: currentTick + 1,
    data: { playerId, enabled },
  });
}

export function formatFarmFoodStatus(
  remaining: number,
  baseCapacity: number = 175,
): string {
  return `Food remaining: ${String(remaining)} / ${String(baseCapacity)} · Reseed: 60 wood`;
}

export function formatMarketSummary(activeTradeCarts: number = 0): string {
  return `Rates: Sell 100 for 70g · Buy 100 for 130g | Active Carts: ${String(activeTradeCarts)}`;
}

export function issueUngarrison(
  inbox: CommandInbox,
  currentTick: number,
  buildingEid: number,
): void {
  inbox.submit({
    kind: UNGARRISON_COMMAND_KIND,
    targetTick: currentTick + 1,
    data: { buildingEid },
  });
}

export function issueMarketExchange(
  inbox: CommandInbox,
  currentTick: number,
  playerId: number,
  action: "buy" | "sell",
  resource: "wood" | "food" | "stone",
  amount = 100,
): void {
  inbox.submit({
    kind: MARKET_EXCHANGE_KIND,
    targetTick: currentTick + 1,
    data: { playerId, action, resource, amount },
  });
}

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

/** Issue one authoritative trainUnit order for `currentTick + 1`. */
export function issueTrainUnit(
  inbox: CommandInbox,
  currentTick: number,
  buildingEid: number,
  unitId: string,
): void {
  inbox.submit({
    kind: TRAIN_UNIT_KIND,
    targetTick: currentTick + 1,
    data: { siteEid: buildingEid, unitId },
  });
}

/** Issue one authoritative foreman appointment for `currentTick + 1`. */
export function issueAppointForeman(
  inbox: CommandInbox,
  currentTick: number,
  buildingEid: number,
  popId: number,
): void {
  inbox.submit({
    kind: APPOINT_FOREMAN_KIND,
    targetTick: currentTick + 1,
    data: { buildingEid, popId },
  });
}

export function createBuildingPanel(deps: {
  getData(): BuildingPanelData | undefined;
  currentTick(): number;
  inbox: CommandInbox;
  onClick?: () => void;
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
  const foremanEl = document.createElement("div");
  foremanEl.className = "panel-foreman";
  const appointWrap = document.createElement("div");
  appointWrap.className = "panel-appoint";
  const garrisonWrap = document.createElement("div");
  garrisonWrap.className = "panel-garrison-wrap";
  garrisonWrap.style.marginTop = "8px";
  const garrisonEl = document.createElement("div");
  garrisonEl.className = "panel-foreman";
  const ungarrisonBtn = document.createElement("button");
  ungarrisonBtn.type = "button";
  ungarrisonBtn.className = "panel-train";
  ungarrisonBtn.textContent = "Ungarrison";
  ungarrisonBtn.addEventListener("click", () => {
    deps.onClick?.();
    const d = deps.getData();
    if (d?.buildingEid !== undefined) {
      issueUngarrison(deps.inbox, deps.currentTick(), d.buildingEid);
    }
  });
  garrisonWrap.append(garrisonEl, ungarrisonBtn);
  const trainButton = document.createElement("button");
  trainButton.type = "button";
  trainButton.className = "panel-train";
  trainButton.textContent = "Train Villager (50 food)";
  trainButton.addEventListener("click", () => {
    deps.onClick?.();
    issueTrainVillager(deps.inbox, deps.currentTick());
  });

  const reseedWrap = document.createElement("div");
  reseedWrap.className = "panel-auto-reseed";
  reseedWrap.style.marginTop = "8px";
  reseedWrap.style.padding = "6px 8px";
  reseedWrap.style.background = "rgba(15, 23, 42, 0.6)";
  reseedWrap.style.borderRadius = "4px";
  reseedWrap.style.border = "1px solid rgba(255, 255, 255, 0.1)";

  const reseedHeader = document.createElement("div");
  reseedHeader.style.display = "flex";
  reseedHeader.style.justifyContent = "space-between";
  reseedHeader.style.alignItems = "center";

  const reseedLabelSpan = document.createElement("span");
  reseedLabelSpan.textContent = "🌾 Auto-Reseed Farms";
  reseedLabelSpan.style.fontSize = "12px";
  reseedLabelSpan.style.fontWeight = "600";
  reseedLabelSpan.style.color = "#f8fafc";

  let currentAutoReseed = true;
  const reseedToggleBtn = document.createElement("button");
  reseedToggleBtn.type = "button";
  reseedToggleBtn.className = "panel-toggle-btn";
  reseedToggleBtn.style.padding = "3px 10px";
  reseedToggleBtn.style.fontSize = "11px";
  reseedToggleBtn.style.fontWeight = "bold";
  reseedToggleBtn.style.borderRadius = "3px";
  reseedToggleBtn.style.cursor = "pointer";
  reseedToggleBtn.addEventListener("click", () => {
    deps.onClick?.();
    issueSetAutoReseed(
      deps.inbox,
      deps.currentTick(),
      0,
      !currentAutoReseed,
    );
  });

  reseedHeader.append(reseedLabelSpan, reseedToggleBtn);
  reseedWrap.appendChild(reseedHeader);

  const farmFoodEl = document.createElement("div");
  farmFoodEl.className = "panel-farm-food";
  farmFoodEl.style.fontSize = "11px";
  farmFoodEl.style.color = "#94a3b8";
  farmFoodEl.style.marginTop = "4px";
  reseedWrap.appendChild(farmFoodEl);

  let lastKey = "";

  return {
    refresh(): void {
      const data = deps.getData();
      if (!data) {
        if (lastKey !== "") {
          lastKey = "";
          panel.classList.remove("visible");
          setTimeout(() => {
            if (!panel.classList.contains("visible")) {
              panel.style.display = "none";
            }
          }, 300);
        }
        return;
      }
      // The production line is volatile (countdowns/stock counts change
      // every tick) and farmFoodRemaining changes on harvests —
      // structural rebuilds key off everything else.
      const { production, farmFoodRemaining, ...structural } = data;
      const key = JSON.stringify(structural);
      const structuralChange = key !== lastKey;
      if (structuralChange) {
        lastKey = key;
        panel.style.display = "block";
        void panel.offsetWidth;
        panel.classList.add("visible");
        while (panel.firstChild) panel.firstChild.remove();
        panel.append(
          titleEl,
          barWrap,
          metaEl,
          queueEl,
          productionEl,
          foremanEl,
          appointWrap,
        );
        titleEl.textContent = data.title;
        metaEl.textContent = "";
        queueEl.textContent = "";
        foremanEl.textContent = "";
        if (data.garrison !== undefined) {
          panel.appendChild(garrisonWrap);
        }
        if (data.queue !== undefined) {
          if (data.trainableUnits && data.trainableUnits.length > 0) {
            for (const u of data.trainableUnits) {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "panel-train";
              btn.textContent = u.label;
              btn.disabled = !(data.canTrain ?? false);
              btn.addEventListener("click", () => {
                deps.onClick?.();
                if (data.buildingEid && u.unitId !== "villager") {
                  issueTrainUnit(
                    deps.inbox,
                    deps.currentTick(),
                    data.buildingEid,
                    u.unitId,
                  );
                } else {
                  issueTrainVillager(deps.inbox, deps.currentTick());
                }
              });
              panel.appendChild(btn);
            }
          } else {
            panel.appendChild(trainButton);
            trainButton.disabled = !(data.canTrain ?? false);
          }
        }
        // M4-T1 appointment section: ranked candidates, one button each
        // (best first), issuing the authoritative appointForeman command.
        if (
          data.buildingEid !== undefined &&
          data.candidates !== undefined &&
          data.candidates.length > 0
        ) {
          const heading = document.createElement("div");
          heading.className = "panel-appoint-heading";
          heading.textContent = "Appoint Foreman";
          appointWrap.appendChild(heading);
          for (const candidate of data.candidates) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "panel-appoint-candidate";
            button.textContent = candidate.label;
            button.addEventListener("click", () => {
              deps.onClick?.();
              issueAppointForeman(
                deps.inbox,
                deps.currentTick(),
                data.buildingEid!,
                candidate.popId,
              );
            });
            appointWrap.appendChild(button);
          }
        }

        // V9 Market commodity exchange section
        if (data.isMarket) {
          const exchangeWrap = document.createElement("div");
          exchangeWrap.className = "panel-market-exchange";
          exchangeWrap.style.marginTop = "8px";
          const heading = document.createElement("div");
          heading.className = "panel-appoint-heading";
          heading.textContent = "Commodity Exchange";
          exchangeWrap.appendChild(heading);

          const summary = document.createElement("div");
          summary.className = "panel-market-summary";
          summary.style.fontSize = "11px";
          summary.style.color = "#a0aab8";
          summary.style.marginBottom = "6px";
          summary.textContent = formatMarketSummary(data.activeTradeCarts ?? 0);
          exchangeWrap.appendChild(summary);

          const commodities: Array<{
            res: "wood" | "food" | "stone";
            label: string;
          }> = [
            { res: "wood", label: "Wood" },
            { res: "food", label: "Food" },
            { res: "stone", label: "Stone" },
          ];

          for (const c of commodities) {
            const row = document.createElement("div");
            row.style.display = "flex";
            row.style.gap = "6px";
            row.style.marginBottom = "4px";

            const sellBtn = document.createElement("button");
            sellBtn.type = "button";
            sellBtn.className = "panel-train";
            sellBtn.style.flex = "1";
            sellBtn.textContent = `Sell 100 ${c.label} (+70g)`;
            sellBtn.addEventListener("click", () => {
              deps.onClick?.();
              issueMarketExchange(
                deps.inbox,
                deps.currentTick(),
                0,
                "sell",
                c.res,
                100,
              );
            });

            const buyBtn = document.createElement("button");
            buyBtn.type = "button";
            buyBtn.className = "panel-train";
            buyBtn.style.flex = "1";
            buyBtn.textContent = `Buy 100 ${c.label} (-130g)`;
            buyBtn.addEventListener("click", () => {
              deps.onClick?.();
              issueMarketExchange(
                deps.inbox,
                deps.currentTick(),
                0,
                "buy",
                c.res,
                100,
              );
            });

            row.append(sellBtn, buyBtn);
            exchangeWrap.appendChild(row);
          }
          panel.appendChild(exchangeWrap);
        }

        if (data.canAutoReseed) {
          panel.appendChild(reseedWrap);
        }
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

      // Serving foreman line repaints through text comparison like the
      // production line (ratings drift as service XP grows).
      const foremanText = data.foreman ?? "";
      if (foremanEl.textContent !== foremanText) {
        foremanEl.textContent = foremanText;
      }

      if (data.garrison !== undefined) {
        garrisonWrap.style.display = "block";
        const garrisonText = `Garrison: ${String(data.garrison.count)} / ${String(data.garrison.capacity)}`;
        if (garrisonEl.textContent !== garrisonText) {
          garrisonEl.textContent = garrisonText;
        }
        ungarrisonBtn.disabled = data.garrison.count === 0;
      } else {
        garrisonWrap.style.display = "none";
      }

      if (data.canAutoReseed) {
        currentAutoReseed = data.autoReseedEnabled ?? true;
        reseedToggleBtn.textContent = currentAutoReseed ? "ON" : "OFF";
        reseedToggleBtn.className = currentAutoReseed
          ? "panel-toggle-btn active"
          : "panel-toggle-btn";
        reseedToggleBtn.style.background = currentAutoReseed
          ? "#15803d"
          : "#475569";
        reseedToggleBtn.style.color = "#fff";
        reseedToggleBtn.style.border = currentAutoReseed
          ? "1px solid #22c55e"
          : "1px solid #64748b";
        reseedToggleBtn.title = currentAutoReseed
          ? "Auto-reseed is ON: Depleted farms will automatically debit 60 wood and restore food capacity"
          : "Auto-reseed is OFF: Depleted farms will exhaust and workers will become idle";
        reseedToggleBtn.setAttribute(
          "aria-label",
          `Auto-reseed farms: currently ${currentAutoReseed ? "ON" : "OFF"}`,
        );

        if (data.farmFoodRemaining !== undefined) {
          farmFoodEl.style.display = "block";
          farmFoodEl.textContent = formatFarmFoodStatus(data.farmFoodRemaining);
        } else {
          farmFoodEl.style.display = "none";
        }
      }
    },
  };
}
