/**
 * Command button grid bottom-centre HUD — SPEC §2.13 / V13 (Part of #88, #91)
 * and Tactical Unit Formations — Q4 (Issue #125 / Epic #122).
 *
 * AoE2-style command button grid:
 * - Stop (S): Instantly halts current orders.
 * - Attack-Move (A): Arms attack-move destination targeting.
 * - Patrol (P): Arms patrol route waypoint targeting.
 * - Guard (G): Sets defensive guard on ground / ally.
 * - Stance (Z): Cycles unit posture (Aggressive → Defensive → Stand Ground).
 * - Garrison (T): Commands units to seek entry in nearest shelter (Tower, Castle, Town Center).
 *
 * Tactical Formations (AoE2 + Bannerlord):
 * - Line (F), Box (X), Staggered (C), Flank (V)
 * - Shield Wall (B), Square (N), Circle (M), Wedge (K)
 *
 * Appears bottom-centre when units are selected, hidden otherwise.
 * Features SVG icons, hotkey letter badges, and interactive tooltips.
 */

import type { FormationType } from "../sim/components/formation";

export type UnitStance =
  "aggressive" | "defensive" | "stand-ground" | "no-attack";

export interface CommandPanelDeps {
  readonly onStop: () => void;
  readonly onAttackMove: () => void;
  readonly onPatrol: () => void;
  readonly onGuard: () => void;
  readonly onCycleStance: () => void;
  readonly onGarrison: () => void;
  readonly onCycleFormation?: () => void;
  readonly onSetFormation?: (formation: FormationType) => void;
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

export interface FormationButtonMeta {
  readonly id: FormationType;
  readonly hotkey: string;
  readonly name: string;
  readonly description: string;
}

export const FORMATION_BUTTONS: readonly FormationButtonMeta[] = [
  {
    id: "line",
    hotkey: "F",
    name: "Line",
    description: "Line formation — rank-and-file abreast (F)",
  },
  {
    id: "box",
    hotkey: "X",
    name: "Box",
    description:
      "Box formation — perimeter protection with interior defense (X)",
  },
  {
    id: "staggered",
    hotkey: "C",
    name: "Stagger",
    description:
      "Staggered formation — dispersed spacing to minimize AoE splash (C)",
  },
  {
    id: "flank",
    hotkey: "V",
    name: "Flank",
    description:
      "Flank formation — split twin wings for flanking maneuvers (V)",
  },
  {
    id: "shieldWall",
    hotkey: "B",
    name: "Shield",
    description:
      "Shield Wall — tight infantry rank, +2 pierce armor, -20% speed (B)",
  },
  {
    id: "square",
    hotkey: "N",
    name: "Square",
    description: "Square formation — solid 4-sided outward defense (N)",
  },
  {
    id: "circle",
    hotkey: "M",
    name: "Circle",
    description: "Circle formation — radial ring perimeter defense (M)",
  },
  {
    id: "wedge",
    hotkey: "K",
    name: "Wedge",
    description:
      "Wedge formation — triangular spearhead to pierce enemy lines (K)",
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

export function formatFormationLabel(formation: FormationType): string {
  switch (formation) {
    case "line":
      return "Formation: Line";
    case "box":
      return "Formation: Box";
    case "staggered":
      return "Formation: Staggered";
    case "flank":
      return "Formation: Flank";
    case "shieldWall":
      return "Formation: Shield Wall";
    case "square":
      return "Formation: Square";
    case "circle":
      return "Formation: Circle";
    case "wedge":
      return "Formation: Wedge";
  }
}

export const FORMATION_ORDER: readonly FormationType[] = [
  "line",
  "box",
  "staggered",
  "flank",
  "shieldWall",
  "square",
  "circle",
  "wedge",
];

export function nextFormation(current: FormationType): FormationType {
  const idx = FORMATION_ORDER.indexOf(current);
  return FORMATION_ORDER[(idx + 1) % FORMATION_ORDER.length]!;
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

function formationIconSvg(id: FormationType): string {
  switch (id) {
    case "line":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="3" y1="8" x2="17" y2="8"/>
        <line x1="3" y1="12" x2="17" y2="12"/>
      </svg>`;
    case "box":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="4" y="4" width="12" height="12" rx="1"/>
        <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
      </svg>`;
    case "staggered":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor">
        <circle cx="5" cy="6" r="1.5"/>
        <circle cx="15" cy="6" r="1.5"/>
        <circle cx="10" cy="10" r="1.5"/>
        <circle cx="5" cy="14" r="1.5"/>
        <circle cx="15" cy="14" r="1.5"/>
      </svg>`;
    case "flank":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <line x1="5" y1="4" x2="5" y2="16"/>
        <line x1="15" y1="4" x2="15" y2="16"/>
      </svg>`;
    case "shieldWall":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
        <path d="M10 3L4 6v5c0 4 6 7 6 7s6-3 6-7V6l-6-3z"/>
      </svg>`;
    case "square":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="4" y="4" width="12" height="12"/>
        <path d="M10 4v12M4 10h12" stroke-width="1.2"/>
      </svg>`;
    case "circle":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
        <circle cx="10" cy="10" r="6"/>
        <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
      </svg>`;
    case "wedge":
      return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
        <polygon points="10,3 17,16 3,16"/>
      </svg>`;
  }
}

export interface CommandPanelHandle {
  readonly element: HTMLElement;
  update(
    hasSelection: boolean,
    stance: UnitStance,
    garrisonAvailable: boolean,
    formation?: FormationType,
  ): void;
  hide(): void;
}

export function createCommandPanel(deps: CommandPanelDeps): CommandPanelHandle {
  const panel = document.createElement("div");
  panel.id = "command-panel";
  panel.className = "command-panel";
  panel.style.display = "none";

  const actionGrid = document.createElement("div");
  actionGrid.className = "command-grid";
  panel.appendChild(actionGrid);

  const formationGrid = document.createElement("div");
  formationGrid.className = "command-grid formation-grid";
  panel.appendChild(formationGrid);

  document.body.appendChild(panel);

  const actionButtonElements = new Map<string, HTMLButtonElement>();
  const formationButtonElements = new Map<FormationType, HTMLButtonElement>();

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

    actionGrid.appendChild(btn);
    actionButtonElements.set(meta.id, btn);
  }

  for (const meta of FORMATION_BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "command-btn";
    btn.dataset.formation = meta.id;
    btn.title = meta.description;

    btn.innerHTML = `
      <span class="command-btn-icon">${formationIconSvg(meta.id)}</span>
      <span class="command-btn-hotkey">${meta.hotkey}</span>
      <span class="command-btn-label">${meta.name}</span>
    `;

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deps.onSetFormation?.(meta.id);
    });

    formationGrid.appendChild(btn);
    formationButtonElements.set(meta.id, btn);
  }

  let lastVisible = false;
  let lastStance: UnitStance | undefined = undefined;
  let lastFormation: FormationType | undefined = undefined;
  let lastGarrison = false;

  return {
    element: panel,
    update(
      hasSelection: boolean,
      stance: UnitStance,
      garrisonAvailable: boolean,
      formation?: FormationType,
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
        const stanceBtn = actionButtonElements.get("stance");
        if (stanceBtn) {
          const label = stanceBtn.querySelector(".command-btn-label");
          if (label) label.textContent = stance;
          stanceBtn.title = formatStanceLabel(stance);
        }
      }

      const activeForm = formation ?? "line";
      if (activeForm !== lastFormation) {
        lastFormation = activeForm;
        formationButtonElements.forEach((btn, id) => {
          btn.classList.toggle("active", id === activeForm);
        });
      }

      if (garrisonAvailable !== lastGarrison) {
        lastGarrison = garrisonAvailable;
        const garrisonBtn = actionButtonElements.get("garrison");
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
