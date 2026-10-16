/**
 * Interactive Objective HUD Card — Milestone S5 / Issue #134 (Part of Epic #131).
 *
 * Lightweight, glassmorphic HUD card pinned to the top-left game viewport displaying:
 * 1. Live Primary and Secondary scenario objectives with completion status checkmarks.
 * 2. Visual styling: Active (Amber ○), Completed (Emerald ✓), Failed (Rose ✕).
 * 3. Collapsible panel toggle to save screen real-estate during intense tactical battles.
 * 4. Reactive updates with minimal DOM churn.
 */

import type { ScenarioObjective } from "../sim/scenario/types";

export interface ObjectiveHudOptions {
  readonly container?: HTMLElement | undefined;
  readonly initialCollapsed?: boolean | undefined;
}

export interface ObjectiveHudHandle {
  readonly element: HTMLElement;
  update(objectives: readonly ScenarioObjective[]): void;
  toggle(collapsed?: boolean): void;
  isCollapsed(): boolean;
  setVisible(visible: boolean): void;
  destroy(): void;
}

export function countActiveObjectives(
  objectives: readonly ScenarioObjective[],
): number {
  return objectives.filter((o) => o.primary && o.status === "active").length;
}

export function formatObjectiveItem(objective: ScenarioObjective): {
  id: string;
  title: string;
  description?: string | undefined;
  icon: string;
  className: string;
} {
  let icon = "○";
  let className = "pending";
  if (objective.status === "completed") {
    icon = "✓";
    className = "completed";
  } else if (objective.status === "failed") {
    icon = "✕";
    className = "failed";
  }
  return {
    id: objective.id,
    title: objective.title,
    description: objective.description,
    icon,
    className,
  };
}

export function createObjectiveHud(
  options: ObjectiveHudOptions = {},
): ObjectiveHudHandle {
  const container = options.container ?? document.body;

  const card = document.createElement("div");
  card.id = "objective-hud";
  // Hidden by default until scenario objectives are loaded
  card.className = "objective-hud objective-hud--hidden";
  if (options.initialCollapsed) {
    card.classList.add("objective-hud--collapsed");
  }

  // Header
  const header = document.createElement("div");
  header.className = "objective-hud-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "objective-hud-title-wrap";
  titleWrap.innerHTML = `<span>Objectives</span><span class="objective-hud-badge" id="objective-hud-badge">0 active</span>`;

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "objective-hud-toggle-btn";
  toggleBtn.title = "Toggle Objectives HUD";
  toggleBtn.setAttribute("aria-label", "Toggle Objectives HUD");
  toggleBtn.textContent = options.initialCollapsed ? "▼" : "▲";

  header.append(titleWrap, toggleBtn);

  // Content
  const content = document.createElement("div");
  content.className = "objective-hud-content";
  content.id = "objective-hud-content";

  card.append(header, content);
  container.appendChild(card);

  let collapsed = options.initialCollapsed ?? false;
  let lastDigest = "";

  const setCollapsed = (collapseState?: boolean): void => {
    collapsed = collapseState !== undefined ? collapseState : !collapsed;
    if (collapsed) {
      card.classList.add("objective-hud--collapsed");
      toggleBtn.textContent = "▼";
    } else {
      card.classList.remove("objective-hud--collapsed");
      toggleBtn.textContent = "▲";
    }
  };

  header.addEventListener("click", () => setCollapsed());

  const update = (objectives: readonly ScenarioObjective[]): void => {
    if (objectives.length === 0) {
      card.classList.add("objective-hud--hidden");
      return;
    }
    card.classList.remove("objective-hud--hidden");

    // Fast-path digest check to avoid layout thrashing
    const digest = objectives
      .map((o) => `${o.id}:${o.status}:${o.title}`)
      .join("|");
    if (digest === lastDigest) return;
    lastDigest = digest;

    const activeCount = countActiveObjectives(objectives);
    const badge = card.querySelector("#objective-hud-badge");
    if (badge) {
      badge.textContent = `${activeCount} active`;
    }

    const primaryList = objectives.filter((o) => o.primary);
    const secondaryList = objectives.filter((o) => !o.primary);

    content.replaceChildren();

    if (primaryList.length > 0) {
      const pHeader = document.createElement("div");
      pHeader.className = "objective-hud-section-label";
      pHeader.textContent = "Primary Objectives";
      content.appendChild(pHeader);

      for (const obj of primaryList) {
        const item = renderObjectiveItem(obj);
        content.appendChild(item);
      }
    }

    if (secondaryList.length > 0) {
      const sHeader = document.createElement("div");
      sHeader.className = "objective-hud-section-label";
      sHeader.textContent = "Secondary Objectives";
      content.appendChild(sHeader);

      for (const obj of secondaryList) {
        const item = renderObjectiveItem(obj);
        content.appendChild(item);
      }
    }
  };

  return {
    element: card,
    update,
    toggle: setCollapsed,
    isCollapsed: () => collapsed,
    setVisible: (visible: boolean) => {
      if (visible) card.classList.remove("objective-hud--hidden");
      else card.classList.add("objective-hud--hidden");
    },
    destroy: () => {
      card.remove();
    },
  };
}

function renderObjectiveItem(objective: ScenarioObjective): HTMLElement {
  const formatted = formatObjectiveItem(objective);

  const item = document.createElement("div");
  item.className = `objective-hud-item ${formatted.className}`;
  if (item.dataset) {
    item.dataset.objectiveId = formatted.id;
  } else {
    item.setAttribute("data-objective-id", formatted.id);
  }

  const iconSpan = document.createElement("span");
  iconSpan.className = "objective-hud-item-icon";
  iconSpan.textContent = formatted.icon;

  const details = document.createElement("div");
  details.className = "objective-hud-item-details";

  const titleSpan = document.createElement("span");
  titleSpan.className = "objective-hud-item-title";
  titleSpan.textContent = formatted.title;

  details.appendChild(titleSpan);

  if (formatted.description) {
    const descSpan = document.createElement("span");
    descSpan.className = "objective-hud-item-desc";
    descSpan.textContent = formatted.description;
    details.appendChild(descSpan);
  }

  item.append(iconSpan, details);
  return item;
}
