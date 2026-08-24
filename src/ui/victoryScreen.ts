/**
 * Victory / defeat overlay — SPEC §2.11 + §2.13 game flow (M2-T10).
 *
 * Full-screen DOM chrome (framework-free per §2.13) shown once the
 * victory evaluator decides the match: VICTORY or DEFEAT from the human
 * viewer's perspective, why it ended (conquest vs surrender), and a
 * stats recap — ticks elapsed plus units lost on each side read straight
 * from the CombatEvents death ledger. Restart tears down into a FRESH
 * world from a new seed via the existing bootstrap; dismiss keeps the
 * decided world on screen for spectating.
 *
 * The formatting helpers are pure string functions so tests cover them
 * without a DOM; only createVictoryScreen touches document.
 */

/** Stats recap payload for one decided match. */
export interface VictoryRecapStats {
  /** Sim ticks elapsed at the decision (30 Hz — divide by 30 for s). */
  readonly ticksElapsed: number;
  /** Fallen units for the human viewer (death ledger UNIT_DEATH count). */
  readonly viewerUnitsLost: number;
  /** Fallen units across the remaining combatants. */
  readonly enemyUnitsLost: number;
}

export type VictorySide = "victory" | "defeat";

export type VictoryEndReason =
  "conquest" | "surrender" | "knowledge" | "culture";

/** "Victory" / "Defeat" headline from the viewer's perspective. */
export function formatVictoryTitle(side: VictorySide): string {
  return side === "victory" ? "Victory" : "Defeat";
}

/**
 * Why the match ended, e.g. `Conquest — AI opponent's military
 * production destroyed` / `You surrendered the match` / the M4-T4
 * sustain paths.
 */
export function formatVictoryReason(
  side: VictorySide,
  reason: VictoryEndReason,
): string {
  if (reason === "surrender") {
    return side === "victory"
      ? "AI opponent surrendered the match"
      : "You surrendered the match";
  }
  if (reason === "knowledge") {
    return side === "victory"
      ? "Knowledge — the Grand Academy sustained its research output"
      : "Knowledge — your rival's Grand Academy sustained its research";
  }
  if (reason === "culture") {
    return side === "victory"
      ? "Culture — the Grand Monument sustained its prestige"
      : "Culture — your rival's Grand Monument sustained its prestige";
  }
  return side === "victory"
    ? "Conquest — enemy military production destroyed"
    : "Conquest — your military production was destroyed";
}

/** Sim ticks as the §2.13-style clock `m:ss` (30 ticks to the second). */
export function formatTicksClock(ticks: number): string {
  const totalSeconds = Math.floor(ticks / 30);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

/** The recap lines: ticks elapsed first, then units lost per side. */
export function formatRecapLines(stats: VictoryRecapStats): string[] {
  return [
    `Ticks elapsed: ${String(stats.ticksElapsed)} (${formatTicksClock(stats.ticksElapsed)})`,
    `Units lost — you: ${String(stats.viewerUnitsLost)} · enemy: ${String(stats.enemyUnitsLost)}`,
  ];
}

export interface VictoryScreenHandle {
  /** Show the overlay for one decided match. */
  show(outcome: {
    side: VictorySide;
    reason: VictoryEndReason;
    stats: VictoryRecapStats;
  }): void;
  hide(): void;
  isVisible(): boolean;
  /** Root element (main.ts appends; overlay styles key off the id). */
  readonly element: HTMLElement;
}

export interface VictoryScreenActions {
  /** Wire the restart button (fresh world from a new seed). */
  readonly onRestart: () => void;
}

export function createVictoryScreen(
  actions: VictoryScreenActions,
): VictoryScreenHandle {
  const element = document.createElement("div");
  element.id = "victory-screen";
  element.hidden = true;

  const title = document.createElement("h1");
  title.id = "victory-title";
  const reason = document.createElement("p");
  reason.id = "victory-reason";
  const recap = document.createElement("ul");
  recap.id = "victory-recap";
  const buttons = document.createElement("div");
  buttons.className = "victory-actions";
  const restart = document.createElement("button");
  restart.id = "victory-restart";
  restart.textContent = "Restart — new world";
  restart.addEventListener("click", actions.onRestart);
  const dismiss = document.createElement("button");
  dismiss.id = "victory-dismiss";
  dismiss.textContent = "Keep watching";
  dismiss.addEventListener("click", () => {
    element.hidden = true;
  });
  buttons.append(restart, dismiss);
  element.append(title, reason, recap, buttons);
  document.body.appendChild(element);

  return {
    show(outcome) {
      title.textContent = formatVictoryTitle(outcome.side);
      title.dataset.outcome = outcome.side;
      reason.textContent = formatVictoryReason(outcome.side, outcome.reason);
      recap.replaceChildren(
        ...formatRecapLines(outcome.stats).map((line) => {
          const item = document.createElement("li");
          item.textContent = line;
          return item;
        }),
      );
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
    isVisible: () => !element.hidden,
    element,
  };
}

/**
 * The surrender control: a small always-visible button that submits the
 * `surrender` command through the shared inbox exactly like any other
 * order. Disabled once the match is decided (the evaluator ignores
 * post-game surrenders anyway — this keeps the UI honest).
 */
export interface SurrenderControlHandle {
  setEnabled(enabled: boolean): void;
  readonly element: HTMLButtonElement;
}

export function createSurrenderControl(
  onSurrender: () => void,
): SurrenderControlHandle {
  const element = document.createElement("button");
  element.id = "surrender-control";
  element.textContent = "Surrender";
  element.addEventListener("click", onSurrender);
  document.body.appendChild(element);
  return {
    setEnabled(enabled: boolean) {
      element.disabled = !enabled;
    },
    element,
  };
}
