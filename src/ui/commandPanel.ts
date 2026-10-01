/**
 * Command button grid bottom-centre HUD — SPEC §2.13 / V13 (Part of #88, #91).
 *
 * AoE2-style command button grid:
 * - Stop (S): Instantly halts current orders.
 * - Attack-Move (A): Arms attack-move destination targeting.
 * - Patrol (P): Arms patrol route waypoint targeting.
 * - Guard (G): Sets defensive guard on ground / ally.
 * - Stance (Z): Cycles unit posture (Aggressive → Defensive → Stand Ground).
 * - Garrison (T): Commands units to seek entry in nearest shelter (Tower, Castle, Town Center).
 *
 * Appears bottom-centre when units are selected, hidden otherwise.
 * Features SVG icons, hotkey letter badges, and interactive tooltips.
 */

export type UnitStance =
  "aggressive" | "defensive" | "stand-ground" | "no-attack";

export interface CommandPanelDeps {
  readonly onStop: () => void;
  readonly onAttackMove: () => void;
  readonly onPatrol: () => void;
  readonly onGuard: () => void;
  readonly onCycleStance: () => void;
  readonly onGarrison: () => void;
}

export interface CommandButtonMeta {
  readonly id: string;
  readonly hotkey: string;
  readonly name: string;
  readonly description: string;
}

export const COMMAND_BUTTONS: readonly CommandButtonMeta[] = [
  {
    id: "stop",
    hotkey: "S",
    name: "Stop",
    description: "Halt all movement and combat orders immediately (S)",
  },
  {
    id: "attack-move",
    hotkey: "A",
    name: "Attack-Move",
    description: "Move to destination, engaging any enemies encountered (A)",
  },
  {
    id: "patrol",
    hotkey: "P",
    name: "Patrol",
    description: "Patrol between current position and destination (P)",
  },
  {
    id: "guard",
    hotkey: "G",
    name: "Guard",
    description: "Hold ground and guard this perimeter (G)",
  },
  {
    id: "stance",
    hotkey: "Z",
    name: "Stance",
    description:
      "Cycle stance: Aggressive, Defensive, Stand Ground, No Attack (Z)",
  },
  {
    id: "garrison",
    hotkey: "T",
    name: "Garrison",
    description: "Enter nearest Town Center, Tower, or Castle for safety (T)",
  },
];

export function formatStanceLabel(stance: UnitStance): string {
  switch (stance) {
    case "aggressive":
      return "Stance: Aggressive";
    case "defensive":
      return "Stance: Defensive";
    case "stand-ground":
      return "Stance: Stand Ground";
    case "no-attack":
      return "Stance: No Attack";
  }
}

export function nextStance(current: UnitStance): UnitStance {
  switch (current) {
    case "aggressive":
      return "defensive";
    case "defensive":
      return "stand-ground";
    case "stand-ground":
      return "no-attack";
    case "no-attack":
      return "aggressive";
  }
}

function commandIconSvg(id: string): string {
  switch (id) {
    case "stop":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor"/>
      </svg>`;
    case "attack-move":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 5.5l-9 9m0-9l9 9"/>
        <path d="M11 3h6v6M9 17H3v-6"/>
      </svg>`;
    case "patrol":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 7h14l-3-3m3 3l-3 3"/>
        <path d="M17 13H3l3-3m-3 3l3 3"/>
      </svg>`;
    case "guard":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 2s6 2 6 7c0 5-6 9-6 9s-6-4-6-9c0-5 6-7 6-7z"/>
        <circle cx="10" cy="9" r="2" fill="currentColor"/>
      </svg>`;
    case "stance":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="10" cy="10" r="7"/>
        <path d="M10 6v8M6 10h8"/>
      </svg>`;
    case "garrison":
    default:
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 18V8l3-3v3h6V5l3 3v10"/>
        <path d="M8 18v-5h4v5"/>
      </svg>`;
  }
}

export interface CommandPanelHandle {
  readonly element: HTMLElement;
  update(
    hasSelection: boolean,
    stance: UnitStance,
    garrisonAvailable: boolean,
  ): void;
  hide(): void;
}

export function createCommandPanel(deps: CommandPanelDeps): CommandPanelHandle {
  const panel = document.createElement("div");
  panel.id = "command-panel";
  panel.className = "command-panel";
  panel.style.display = "none";

  const grid = document.createElement("div");
  grid.className = "command-grid";
  panel.appendChild(grid);
  document.body.appendChild(panel);

  const buttonElements = new Map<string, HTMLButtonElement>();

  for (const meta of COMMAND_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "command-btn";
    btn.dataset.command = meta.id;
    btn.title = meta.description;

    btn.innerHTML = `
      <span class="command-btn-icon">${commandIconSvg(meta.id)}</span>
      <span class="command-btn-hotkey">${meta.hotkey}</span>
      <span class="command-btn-label">${meta.name}</span>
    `;

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      switch (meta.id) {
        case "stop":
          deps.onStop();
          break;
        case "attack-move":
          deps.onAttackMove();
          break;
        case "patrol":
          deps.onPatrol();
          break;
        case "guard":
          deps.onGuard();
          break;
        case "stance":
          deps.onCycleStance();
          break;
        case "garrison":
          deps.onGarrison();
          break;
      }
    });

    grid.appendChild(btn);
    buttonElements.set(meta.id, btn);
  }

  let lastVisible = false;
  let lastStance: UnitStance | undefined = undefined;
  let lastGarrison = false;

  return {
    element: panel,
    update(
      hasSelection: boolean,
      stance: UnitStance,
      garrisonAvailable: boolean,
    ): void {
      if (!hasSelection) {
        if (lastVisible) {
          panel.classList.remove("visible");
          panel.style.display = "none";
          lastVisible = false;
        }
        return;
      }

      if (!lastVisible) {
        panel.style.display = "flex";
        panel.classList.add("visible");
        lastVisible = true;
      }

      if (stance !== lastStance) {
        lastStance = stance;
        const stanceBtn = buttonElements.get("stance");
        if (stanceBtn) {
          const label = stanceBtn.querySelector(".command-btn-label");
          if (label) label.textContent = stance;
          stanceBtn.title = formatStanceLabel(stance);
        }
      }

      if (garrisonAvailable !== lastGarrison) {
        lastGarrison = garrisonAvailable;
        const garrisonBtn = buttonElements.get("garrison");
        if (garrisonBtn) {
          garrisonBtn.classList.toggle("disabled", !garrisonAvailable);
          garrisonBtn.disabled = !garrisonAvailable;
        }
      }
    },
    hide(): void {
      panel.classList.remove("visible");
      panel.style.display = "none";
      lastVisible = false;
    },
  };
}
