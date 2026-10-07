/**
 * Objectives HUD Overlay & Panel — Milestone S5 / Issue #133.
 *
 * Provides:
 * 1. Topbar / HUD trigger button with active objective counter badge and [O] hotkey indicator.
 * 2. Glassmorphic modal/overlay presenting scenario briefing, primary & secondary objectives,
 *    and live status indicators (Active, Completed, Failed).
 * 3. Recent narrative dialogue log transcript.
 * 4. Responsive ARIA accessibility, ESC key handling, and seamless updates.
 */

import type { ScenarioObjective, ScenarioNarrativeEvent } from "../sim/scenario/types";

export interface ObjectivesPanelOptions {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly onClose?: () => void;
  readonly onToggle?: (isOpen: boolean) => void;
}

export interface ObjectivesPanelHandle {
  readonly element: HTMLElement;
  readonly button: HTMLElement;
  update(
    objectives: readonly ScenarioObjective[],
    recentEvents?: readonly ScenarioNarrativeEvent[],
  ): void;
  toggle(force?: boolean): void;
  isOpen(): boolean;
  destroy(): void;
}

const SCROLL_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14Z"/>
  <path d="M19 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-5"/>
  <line x1="7" y1="9" x2="15" y2="9"/>
  <line x1="7" y1="13" x2="13" y2="13"/>
</svg>`;

export function countActiveObjectives(
  objectives: readonly ScenarioObjective[],
): number {
  return objectives.filter((o) => o.primary && o.status === "active").length;
}

export function formatObjectiveStatusPill(
  status: "active" | "completed" | "failed",
): {
  text: string;
  icon: string;
  className: string;
} {
  switch (status) {
    case "completed":
      return { text: "Completed", icon: "✓", className: "completed" };
    case "failed":
      return { text: "Failed", icon: "✕", className: "failed" };
    case "active":
    default:
      return { text: "Active", icon: "○", className: "pending" };
  }
}

export function createObjectivesPanel(
  options: ObjectivesPanelOptions = {},
): ObjectivesPanelHandle {
  // 1. Trigger button (suitable for attaching to topbar or HUD)
  const button = document.createElement("button");
  button.id = "objectives-toggle-btn";
  button.className = "topbar-btn topbar-objectives-btn";
  button.title = "View Scenario Objectives (O)";
  button.setAttribute("aria-label", "View Scenario Objectives");
  button.setAttribute("aria-expanded", "false");

  button.innerHTML = `
    <span class="btn-icon">${SCROLL_ICON_SVG}</span>
    <span class="btn-label">Objectives</span>
    <span class="objectives-badge" id="objectives-badge" style="display: none;">0</span>
    <span class="btn-hotkey-badge">O</span>
  `;

  // 2. Modal Overlay Panel
  const panel = document.createElement("div");
  panel.id = "objectives-panel";
  panel.className = "objectives-panel objectives-panel--hidden";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "objectives-title");

  panel.innerHTML = `
    <div class="objectives-panel-card">
      <div class="objectives-header">
        <div class="objectives-header-title">
          <span class="objectives-icon">${SCROLL_ICON_SVG}</span>
          <h2 id="objectives-title">${options.title ?? "Mission Objectives"}</h2>
        </div>
        <button type="button" class="objectives-close-btn" id="objectives-close-btn" aria-label="Close Objectives">✕</button>
      </div>
      
      ${
        options.description
          ? `<div class="objectives-briefing">${options.description}</div>`
          : `<div class="objectives-briefing" id="objectives-briefing" style="display: none;"></div>`
      }

      <div class="objectives-section">
        <h3 class="objectives-section-title">Primary Objectives</h3>
        <ul class="objectives-list" id="objectives-primary-list"></ul>
      </div>

      <div class="objectives-section" id="objectives-secondary-section" style="display: none;">
        <h3 class="objectives-section-title">Secondary Objectives</h3>
        <ul class="objectives-list" id="objectives-secondary-list"></ul>
      </div>

      <div class="objectives-transcripts" id="objectives-transcripts-section" style="display: none;">
        <h3 class="objectives-section-title">Mission Transcripts</h3>
        <div class="objectives-transcripts-log" id="objectives-transcripts-log"></div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  const badge = button.querySelector<HTMLElement>("#objectives-badge")!;
  const closeBtn = panel.querySelector<HTMLElement>("#objectives-close-btn")!;
  const primaryList = panel.querySelector<HTMLElement>("#objectives-primary-list")!;
  const secondarySection = panel.querySelector<HTMLElement>("#objectives-secondary-section")!;
  const secondaryList = panel.querySelector<HTMLElement>("#objectives-secondary-list")!;
  const transcriptsSection = panel.querySelector<HTMLElement>("#objectives-transcripts-section")!;
  const transcriptsLog = panel.querySelector<HTMLElement>("#objectives-transcripts-log")!;
  const briefing = panel.querySelector<HTMLElement>("#objectives-briefing");

  let open = false;

  function setOpen(targetOpen: boolean): void {
    if (open === targetOpen) return;
    open = targetOpen;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      panel.classList.remove("objectives-panel--hidden");
    } else {
      panel.classList.add("objectives-panel--hidden");
    }
    options.onToggle?.(open);
  }

  button.addEventListener("click", () => {
    setOpen(!open);
  });

  closeBtn.addEventListener("click", () => {
    setOpen(false);
    options.onClose?.();
  });

  // Close on backdrop click
  panel.addEventListener("click", (e) => {
    if (e.target === panel) {
      setOpen(false);
      options.onClose?.();
    }
  });

  // Global keydown listener for hotkey 'O' and 'Escape'
  function handleKeyDown(e: KeyboardEvent): void {
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    ) {
      return;
    }

    if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      setOpen(!open);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      options.onClose?.();
    }
  }

  window.addEventListener("keydown", handleKeyDown);

  function renderObjectiveItem(obj: ScenarioObjective): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `objective-item objective-item--${obj.status}`;
    li.id = `objective-item-${obj.id}`;

    let statusIcon = "○";
    let statusClass = "pending";
    if (obj.status === "completed") {
      statusIcon = "✓";
      statusClass = "completed";
    } else if (obj.status === "failed") {
      statusIcon = "✕";
      statusClass = "failed";
    }

    li.innerHTML = `
      <span class="objective-status-icon objective-status-icon--${statusClass}">${statusIcon}</span>
      <div class="objective-content">
        <div class="objective-title">${obj.title}</div>
        ${obj.description ? `<div class="objective-desc">${obj.description}</div>` : ""}
      </div>
      <span class="objective-pill objective-pill--${statusClass}">${obj.status}</span>
    `;

    return li;
  }

  return {
    element: panel,
    button,
    update(objectives, recentEvents = []) {
      primaryList.innerHTML = "";
      secondaryList.innerHTML = "";

      let activePrimaryCount = 0;
      let hasSecondary = false;

      for (const obj of objectives) {
        if (obj.primary) {
          if (obj.status === "active") activePrimaryCount++;
          primaryList.appendChild(renderObjectiveItem(obj));
        } else {
          hasSecondary = true;
          secondaryList.appendChild(renderObjectiveItem(obj));
        }
      }

      secondarySection.style.display = hasSecondary ? "block" : "none";

      // Update badge
      if (activePrimaryCount > 0) {
        badge.textContent = String(activePrimaryCount);
        badge.style.display = "inline-flex";
      } else {
        badge.style.display = "none";
      }

      // Update transcripts if present
      const broadcastMessages = recentEvents
        .filter((e) => e.action.kind === "broadcastMessage")
        .slice(-5);

      if (broadcastMessages.length > 0) {
        transcriptsSection.style.display = "block";
        transcriptsLog.innerHTML = "";
        for (const ev of broadcastMessages) {
          if (ev.action.kind === "broadcastMessage") {
            const row = document.createElement("div");
            row.className = "transcript-entry";
            row.innerHTML = `
              <span class="transcript-sender">${ev.action.sender ?? "Narrator"}:</span>
              <span class="transcript-text">${ev.action.message}</span>
            `;
            transcriptsLog.appendChild(row);
          }
        }
      } else {
        transcriptsSection.style.display = "none";
      }
    },
    toggle(force) {
      setOpen(force !== undefined ? force : !open);
    },
    isOpen() {
      return open;
    },
    destroy() {
      window.removeEventListener("keydown", handleKeyDown);
      panel.remove();
      button.remove();
    },
  };
}
