/**
 * Victory-path progress panel — SPEC §2.11 / M4-T4.
 *
 * Framework-free DOM chrome (§2.13): one line per §2.11 path showing
 * the viewer's current metric against the path's threshold plus the
 * sustain-timer state (holding x/y, paused, or act missing). Every
 * number comes from {@link VictoryPathReadout} — the same digest-row
 * derivation the evaluator decides on — so the panel cannot disagree
 * with the sim. Formatting helpers are pure functions so tests cover
 * them without a DOM; only createVictoryPathsPanel touches document.
 */

import type { VictoryPathReadout } from "../sim/systems/victory";

/** Whole units for display: milli-rate → e.g. `3.5`. */
function formatPerMin(milli: number | undefined): string {
  return milli === undefined ? "—" : (milli / 1000).toFixed(1);
}

/**
 * One legible status line per path, e.g.
 *   `Knowledge · 240.0/min sustained · need 40/min · holding 450/900t`
 *   `Knowledge · 12.0/min sustained · need 40/min · paused 120/900t`
 *   `Knowledge · 0.0/min sustained · need Grand Academy`
 *   `Conquest · capacity 2 · in progress`
 *   `Conquest · capacity 2 · act ready`
 *   `Wonder · wonders 1 · holding 300/900t`   (hold-only paths)
 *   `Relic · relics 1/3 · collect relics`
 */
export function formatVictoryPathLine(readout: VictoryPathReadout): string {
  const label = readout.id.charAt(0).toUpperCase() + readout.id.slice(1);
  if (!readout.actComplete) {
    // Conquest: timerless — "in progress" is more accurate than "act missing"
    if (readout.timerTicks === undefined) {
      return `${label} · ${readout.metricNoun} ${String(readout.metric)} · in progress`;
    }
    // Relic (hold-only, no rate): show current/threshold progress
    if (readout.thresholdPerMin === undefined) {
      return `${label} · ${readout.metricNoun} ${String(readout.metric)} · collect ${readout.metricNoun}`;
    }
    // Gated timed paths (Knowledge, Culture, Economic): show rate + goal hint
    const rate = `${formatPerMin(readout.ratePerMinMilli)}/min sustained`;
    const goal =
      readout.id === "knowledge"
        ? "need Grand Academy"
        : readout.id === "culture"
          ? "need Grand Monument"
          : "act missing";
    return `${label} · ${rate} · ${goal}`;
  }
  // Act complete from here: gated timed paths show the sustain race…
  if (
    readout.thresholdPerMin !== undefined &&
    readout.timerTicks !== undefined &&
    readout.ratePerMinMilli !== undefined
  ) {
    const state =
      readout.ratePerMinMilli >= readout.thresholdPerMin * 1000
        ? "holding"
        : "paused";
    return `${label} · ${formatPerMin(readout.ratePerMinMilli)}/min sustained · need ${String(readout.thresholdPerMin)}/min · ${state} ${String(readout.holdTicks)}/${String(readout.timerTicks)}t`;
  }
  // …hold-only paths show the bare hold race (the act standing IS the
  // qualifying condition — no rate to fall below)…
  if (readout.timerTicks !== undefined) {
    return `${label} · ${readout.metricNoun} ${String(readout.metric)} · holding ${String(readout.holdTicks)}/${String(readout.timerTicks)}t`;
  }
  // …and conquest (timerless) simply stands ready to win.
  return `${label} · ${readout.metricNoun} ${String(readout.metric)} · act ready`;
}

export interface VictoryPathsPanelHandle {
  /** Repaint from a fresh readout array (diffed to avoid DOM churn). */
  update(readouts: readonly VictoryPathReadout[]): void;
  readonly element: HTMLElement;
}

export function createVictoryPathsPanel(
  options: { container?: HTMLElement } = {},
): VictoryPathsPanelHandle {
  const element = document.createElement("div");
  element.id = "victory-paths";

  const header = document.createElement("div");
  header.className = "victory-paths-header";
  const title = document.createElement("h4");
  title.textContent = "Victory Paths";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "victory-paths-toggle-btn";
  toggleBtn.type = "button";
  toggleBtn.setAttribute("aria-label", "Toggle Victory Paths");
  toggleBtn.title = "Collapse / Expand Victory Paths";
  toggleBtn.textContent = "−";

  header.append(title, toggleBtn);

  const content = document.createElement("div");
  content.className = "victory-paths-content";

  element.append(header, content);

  const container = options.container ?? document.body;
  container.appendChild(element);

  let isCollapsed = false;
  const toggleCollapse = (): void => {
    isCollapsed = !isCollapsed;
    element.classList.toggle("collapsed", isCollapsed);
    content.style.display = isCollapsed ? "none" : "flex";
    toggleBtn.textContent = isCollapsed ? "+" : "−";
  };

  toggleBtn.addEventListener("click", (e) => {
    (e as { stopPropagation?: () => void })?.stopPropagation?.();
    toggleCollapse();
  });

  header.addEventListener("click", () => {
    toggleCollapse();
  });

  let lastText = "";
  return {
    update(readouts) {
      if (readouts.length === 0) {
        element.style.display = "none";
        return;
      }
      element.style.display = "block";
      const next = readouts.map(formatVictoryPathLine).join("\n");
      if (next === lastText) return;
      lastText = next;
      content.replaceChildren(
        ...readouts.map((readout) => {
          const line = document.createElement("div");
          line.className = "victory-path-line";
          line.dataset.pathId = readout.id;
          line.textContent = formatVictoryPathLine(readout);
          if (readout.actComplete) line.dataset.active = "true";
          return line;
        }),
      );
    },
    element,
  };
}
