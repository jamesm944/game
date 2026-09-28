/**
 * Interactive Diplomacy & Tribute Panel — Milestone S3 (Issue #116).
 *
 * AoE2-style Diplomacy modal and tribute transfer interface:
 * - Lists all active players with assigned player color swatch, name, team indicator,
 *   and current match status (Active, Surrendered, Defeated).
 * - Interactive diplomatic stance selector (Ally / Neutral / Enemy) allowing the
 *   human player to adjust stances in real time.
 * - Tribute transfer interface: 1-click resource transfer (100 Food, Wood, Gold, Stone)
 *   with balance validation and live fee calculation.
 */

import {
  DIPLOMACY_STANCE_ALLY,
  DIPLOMACY_STANCE_ENEMY,
  DIPLOMACY_STANCE_NEUTRAL,
  type DiplomacyStance,
} from "../sim/core/diplomacy";
import {
  RESOURCE_FOOD,
  RESOURCE_GOLD,
  RESOURCE_STONE,
  RESOURCE_WOOD,
} from "../sim/components/economy";

export interface PlayerDiplomacyInfo {
  readonly playerId: number;
  readonly name: string;
  readonly color: string;
  readonly stance: DiplomacyStance;
  readonly team?: number | undefined;
  readonly status: "active" | "surrendered" | "defeated";
  readonly isHuman?: boolean | undefined;
}

export interface DiplomacyPanelCallbacks {
  /** Return status information for all players. */
  getPlayers(): readonly PlayerDiplomacyInfo[];
  /** Dispatch diplomatic stance change towards target player. */
  onSetStance(targetPlayerId: number, stance: DiplomacyStance): void;
  /** Dispatch resource tribute transfer. */
  onSendTribute(
    targetPlayerId: number,
    resourceCode: number,
    amount: number,
  ): void;
  /** Check whether donor can afford tribute packet. */
  canAffordTribute(resourceCode: number, amount: number): boolean;
  /** Optional modal close hook. */
  onClose?(): void;
}

export interface DiplomacyPanelHandle {
  readonly root: HTMLDivElement;
  show(): void;
  hide(): void;
  toggle(): void;
  readonly isOpen: boolean;
  render(): void;
  note(message: string, isError?: boolean): void;
}

const TRIBUTE_AMOUNT = 100;

export function createDiplomacyPanel(
  callbacks: DiplomacyPanelCallbacks,
): DiplomacyPanelHandle {
  const root = document.createElement("div");
  root.id = "diplomacy-modal";
  root.hidden = true;

  const panel = document.createElement("div");
  panel.id = "diplomacy-panel";

  const header = document.createElement("div");
  header.className = "diplomacy-header";

  const title = document.createElement("h2");
  title.id = "diplomacy-title";
  title.textContent = "Diplomacy & Tributes";

  const closeBtn = document.createElement("button");
  closeBtn.id = "diplomacy-close";
  closeBtn.setAttribute("aria-label", "Close diplomacy panel");
  closeBtn.textContent = "✕";

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const desc = document.createElement("p");
  desc.className = "diplomacy-desc";
  desc.textContent =
    "Adjust diplomatic stances and transfer resources to allies.";
  panel.appendChild(desc);

  const content = document.createElement("div");
  content.id = "diplomacy-content";

  const table = document.createElement("table");
  table.id = "diplomacy-table";

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  for (const h of [
    "Player",
    "Team",
    "Stance",
    "Status",
    "Send Tribute (100)",
  ]) {
    const th = document.createElement("th");
    th.textContent = h;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.id = "diplomacy-tbody";
  table.appendChild(tbody);
  content.appendChild(table);
  panel.appendChild(content);

  const footer = document.createElement("div");
  footer.id = "diplomacy-footer";
  const noteEl = document.createElement("p");
  noteEl.id = "diplomacy-note";
  noteEl.hidden = true;
  footer.appendChild(noteEl);
  panel.appendChild(footer);

  root.appendChild(panel);
  document.body.appendChild(root);

  let noteTimeout: ReturnType<typeof setTimeout> | undefined;

  const note = (message: string, isError = false): void => {
    if (noteTimeout) clearTimeout(noteTimeout);
    noteEl.textContent = message;
    noteEl.hidden = false;
    noteEl.className = isError ? "note-error" : "note-success";
    noteTimeout = setTimeout(() => {
      noteEl.hidden = true;
    }, 4000);
  };

  const render = (): void => {
    while (tbody.firstChild) {
      tbody.removeChild(tbody.firstChild);
    }
    const players = callbacks.getPlayers();

    for (const player of players) {
      const tr = document.createElement("tr");
      tr.className = `player-row player-${String(player.playerId)}`;
      if (player.isHuman) tr.classList.add("player-self");

      // 1. Player Name & Color swatch
      const tdPlayer = document.createElement("td");
      tdPlayer.className = "td-player";

      const swatch = document.createElement("span");
      swatch.className = "player-color-swatch";
      swatch.style.backgroundColor = player.color;

      const nameSpan = document.createElement("span");
      nameSpan.className = "player-name";
      nameSpan.textContent = `${player.name}${player.isHuman ? " (You)" : ""}`;

      tdPlayer.appendChild(swatch);
      tdPlayer.appendChild(nameSpan);
      tr.appendChild(tdPlayer);

      // 2. Team
      const tdTeam = document.createElement("td");
      tdTeam.className = "td-team";
      tdTeam.textContent =
        player.team !== undefined ? `Team ${String(player.team + 1)}` : "FFA";
      tr.appendChild(tdTeam);

      // 3. Stance selector
      const tdStance = document.createElement("td");
      tdStance.className = "td-stance";

      if (player.isHuman) {
        const selfSpan = document.createElement("span");
        selfSpan.className = "stance-self";
        selfSpan.textContent = "—";
        tdStance.appendChild(selfSpan);
      } else {
        const stanceGroup = document.createElement("div");
        stanceGroup.className = "stance-btn-group";

        const stances: { id: DiplomacyStance; label: string; cls: string }[] = [
          { id: DIPLOMACY_STANCE_ALLY, label: "Ally", cls: "btn-ally" },
          {
            id: DIPLOMACY_STANCE_NEUTRAL,
            label: "Neutral",
            cls: "btn-neutral",
          },
          { id: DIPLOMACY_STANCE_ENEMY, label: "Enemy", cls: "btn-enemy" },
        ];

        for (const s of stances) {
          const btn = document.createElement("button");
          btn.className = `stance-btn ${s.cls}${player.stance === s.id ? " active" : ""}`;
          btn.textContent = s.label;
          btn.disabled = player.status !== "active";
          btn.addEventListener("click", () => {
            callbacks.onSetStance(player.playerId, s.id);
            render();
            note(`Set diplomatic stance with ${player.name} to ${s.label}.`);
          });
          stanceGroup.appendChild(btn);
        }
        tdStance.appendChild(stanceGroup);
      }
      tr.appendChild(tdStance);

      // 4. Status
      const tdStatus = document.createElement("td");
      tdStatus.className = "td-status";
      const statusBadge = document.createElement("span");
      statusBadge.className = `status-badge status-${player.status}`;
      statusBadge.textContent =
        player.status.charAt(0).toUpperCase() + player.status.slice(1);
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      // 5. Tribute buttons (Food, Wood, Gold, Stone)
      const tdTribute = document.createElement("td");
      tdTribute.className = "td-tribute";

      if (player.isHuman || player.status !== "active") {
        const disabledSpan = document.createElement("span");
        disabledSpan.className = "tribute-disabled";
        disabledSpan.textContent = "—";
        tdTribute.appendChild(disabledSpan);
      } else {
        const tributeGroup = document.createElement("div");
        tributeGroup.className = "tribute-btn-group";

        const resources = [
          { code: RESOURCE_FOOD, name: "Food", icon: "🌾", cls: "trib-food" },
          { code: RESOURCE_WOOD, name: "Wood", icon: "🪵", cls: "trib-wood" },
          { code: RESOURCE_GOLD, name: "Gold", icon: "🪙", cls: "trib-gold" },
          {
            code: RESOURCE_STONE,
            name: "Stone",
            icon: "🪨",
            cls: "trib-stone",
          },
        ];

        for (const res of resources) {
          const btn = document.createElement("button");
          btn.className = `tribute-btn ${res.cls}`;
          btn.title = `Send ${String(TRIBUTE_AMOUNT)} ${res.name} to ${player.name}`;

          const labelSpan = document.createElement("span");
          labelSpan.className = "trib-label";
          labelSpan.textContent = `+${String(TRIBUTE_AMOUNT)}`;
          btn.textContent = `${res.icon} `;
          btn.appendChild(labelSpan);

          const canAfford = callbacks.canAffordTribute(
            res.code,
            TRIBUTE_AMOUNT,
          );
          btn.disabled = !canAfford;

          btn.addEventListener("click", () => {
            if (!callbacks.canAffordTribute(res.code, TRIBUTE_AMOUNT)) {
              note(
                `Cannot afford ${String(TRIBUTE_AMOUNT)} ${res.name} tribute!`,
                true,
              );
              return;
            }
            callbacks.onSendTribute(player.playerId, res.code, TRIBUTE_AMOUNT);
            render();
            note(
              `Sent ${String(TRIBUTE_AMOUNT)} ${res.name} tribute to ${player.name}.`,
            );
          });

          tributeGroup.appendChild(btn);
        }
        tdTribute.appendChild(tributeGroup);
      }
      tr.appendChild(tdTribute);

      tbody.appendChild(tr);
    }
  };

  const show = (): void => {
    root.hidden = false;
    render();
  };

  const hide = (): void => {
    root.hidden = true;
    if (noteTimeout) clearTimeout(noteTimeout);
    noteEl.hidden = true;
    callbacks.onClose?.();
  };

  const toggle = (): void => {
    if (root.hidden) show();
    else hide();
  };

  closeBtn.addEventListener("click", hide);

  // Close when clicking outside panel
  root.addEventListener("click", (e) => {
    if (e.target === root) hide();
  });

  // Hotkey Esc to close
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden) {
      hide();
    }
  });

  return {
    root,
    show,
    hide,
    toggle,
    get isOpen() {
      return !root.hidden;
    },
    render,
    note,
  };
}
