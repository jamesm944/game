/**
 * Replay playback chrome — SPEC §2.12 / M5-T3 (issue #65).
 *
 * The Import-replay flow's two overlays, framework-free like every ui/
 * panel: a progress bar while the headless replay runs to end or first
 * divergence, and the loud DESYNC report panel showing expected vs
 * actual milestone digests when one hits. Pure string helpers are
 * node-testable; only the create* factories touch document.
 */

import { formatReplayDesyncLines } from "../sim/replay/play";
import type { ReplayDivergenceInfo } from "../sim/replay/play";

/** "tick 123 / 900 · 13%" style progress line. */
export function formatReplayProgressLine(
  tickDone: number,
  total: number,
): string {
  const pct =
    total > 0 ? Math.min(100, Math.round((tickDone / total) * 100)) : 100;
  return `tick ${String(tickDone)} / ${String(total)} · ${String(pct)}%`;
}

export interface ReplayProgressOverlay {
  readonly root: HTMLDivElement;
  setProgress(tickDone: number, total: number): void;
  /** Swap to the completed state (victory screen takes over next). */
  complete(): void;
  /** Swap to a loud error state (format rejects, stalls). */
  fail(message: string): void;
}

/** Full-screen progress overlay for an in-flight headless replay. */
export function createReplayProgressOverlay(): ReplayProgressOverlay {
  const root = document.createElement("div");
  root.id = "replay-overlay";
  root.innerHTML = `
    <div id="replay-panel">
      <h2>Replaying…</h2>
      <p id="replay-progress-line"></p>
      <div id="replay-progress-track"><div id="replay-progress-fill"></div></div>
      <p id="replay-note" hidden></p>
    </div>
  `;
  document.body.appendChild(root);

  const line = root.querySelector("#replay-progress-line") as HTMLElement;
  const fill = root.querySelector("#replay-progress-fill") as HTMLDivElement;
  const note = root.querySelector("#replay-note") as HTMLElement;

  return {
    root,
    setProgress(tickDone, total) {
      line.textContent = formatReplayProgressLine(tickDone, total);
      const pct = total > 0 ? Math.min(100, (tickDone / total) * 100) : 100;
      fill.style.width = `${String(pct)}%`;
    },
    complete() {
      root.remove();
    },
    fail(message) {
      note.textContent = message;
      note.hidden = false;
      root.dataset.failed = "true";
    },
  };
}

/**
 * The loud desync report panel: stays on screen until dismissed so the
 * expected/actual digests can be pasted into a bug issue verbatim.
 */
export function createReplayDesyncPanel(
  divergence: ReplayDivergenceInfo,
): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "replay-desync";
  const pre = document.createElement("pre");
  pre.id = "replay-desync-report";
  pre.textContent = formatReplayDesyncLines(divergence).join("\n");
  const dismiss = document.createElement("button");
  dismiss.id = "replay-desync-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => root.remove());
  root.append(pre, dismiss);
  document.body.appendChild(root);
  return root;
}
