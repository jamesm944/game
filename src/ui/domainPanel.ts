/**
 * Domain strategy panel — SPEC §2.7 / M4-T1 (issue #56).
 *
 * One row per managed domain: the serving manager's name and one
 * weight slider per workplace of that domain, best-identity-order top
 * to bottom. Moving a slider issues the authoritative `setStrategy`
 * command carrying the WHOLE weight vector for the domain — partial
 * writes would silently reorder against a shifting workplace set.
 *
 * Data flows in from a polling callback each refresh (the same rows
 * golden digests hash); sliders only rebuild when the structural key
 * changes, so dragging never fights a re-render mid-gesture.
 */

import type { CommandInbox } from "../sim/core/inbox";

/** One weighted workplace line inside a domain block. */
export interface DomainPanelWeight {
  readonly workplaceEid: number;
  /** e.g. "Sawpit #17". */
  readonly label: string;
  /** Player-set weight ≥ 0 (rendered 0–4 in quarter steps). */
  readonly weight: number;
}

/** One managed-domain block. */
export interface DomainPanelEntry {
  readonly domainSlug: string;
  /** "Manager Alric · rating 3.4" or undefined while unstaffed. */
  readonly managerLabel?: string | undefined;
  readonly weights: readonly DomainPanelWeight[];
}

export interface DomainPanelData {
  readonly domains: readonly DomainPanelEntry[];
}

export interface SetStrategyPayload {
  readonly domainSlug: string;
  readonly weights: readonly number[];
}

export function createDomainPanel(deps: {
  getData(): DomainPanelData | undefined;
  currentTick(): number;
  inbox: CommandInbox;
  /** Issue the authoritative setStrategy command (main.ts owns codes). */
  issueStrategy(payload: SetStrategyPayload): void;
}): { refresh(): void } {
  const panel = document.createElement("div");
  panel.id = "domain-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  const titleEl = document.createElement("h3");
  titleEl.textContent = "Domain Strategy";
  const bodyEl = document.createElement("div");
  bodyEl.className = "domain-panel-body";

  let lastKey = "";

  return {
    refresh(): void {
      const data = deps.getData();
      if (!data || data.domains.length === 0) {
        if (lastKey !== "") {
          lastKey = "";
          panel.style.display = "none";
        }
        return;
      }
      const key = JSON.stringify(data);
      if (key !== lastKey) {
        lastKey = key;
        panel.style.display = "block";
        while (panel.firstChild) panel.firstChild.remove();
        panel.append(titleEl, bodyEl);
        bodyEl.textContent = "";
        for (const entry of data.domains) {
          const block = document.createElement("div");
          block.className = "domain-block";
          const heading = document.createElement("div");
          heading.className = "domain-heading";
          heading.textContent =
            entry.managerLabel !== undefined
              ? `${entry.domainSlug} — ${entry.managerLabel}`
              : `${entry.domainSlug} — no manager`;
          block.appendChild(heading);
          for (const weight of entry.weights) {
            const line = document.createElement("label");
            line.className = "domain-weight";
            const label = document.createElement("span");
            label.textContent = weight.label;
            const input = document.createElement("input");
            input.type = "range";
            input.min = "0";
            input.max = "4";
            input.step = "0.25";
            input.value = String(weight.weight);
            input.addEventListener("change", () => {
              // The whole vector rides every command; read sibling
              // sliders so a single drag publishes a consistent brief.
              const inputs = [
                ...block.querySelectorAll<HTMLInputElement>(
                  'input[type="range"]',
                ),
              ];
              deps.issueStrategy({
                domainSlug: entry.domainSlug,
                weights: inputs.map((el) => Number(el.value)),
              });
            });
            line.append(label, input);
            block.appendChild(line);
          }
          bodyEl.appendChild(block);
        }
      }
    },
  };
}
