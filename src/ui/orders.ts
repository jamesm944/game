/**
 * Orders — SPEC §2.13 prototype-validated command layer (M1-T8).
 *
 * Right-click contextual orders. The only order the M1 sim understands
 * is `groupMove` (movement ticket), so every ground right-click with a
 * live selection issues one `{kind:"groupMove"}` command into the sim
 * inbox targeted at the NEXT tick (`currentTick + 1`) — replay-relevant
 * input that golden fixtures can drive verbatim.
 *
 * Feedback latency contract: the green ring marker spawns synchronously
 * inside the click handler, so it is on screen the same rendered frame
 * as the click (< 1 frame — imperceptible).
 *
 * This module is deliberately DOM-light and three-free: the pure
 * command issuer + capped order log are importable headlessly (node
 * tests drive them directly); all element creation lives inside the
 * wiring factory and never runs at import time.
 */

import type { CommandInbox, SimCommand } from "../sim/core/inbox";

/** The one movement command kind the M1 sim consumes. */
export const GROUP_MOVE_KIND = "groupMove";

/**
 * Validate, canonicalize (dedupe + ascending sort), and submit one
 * group-move order for delivery exactly on `currentTick + 1`.
 *
 * Canonical form matters: the movement system re-sorts defensively,
 * but replays/logs/digests should observe ONE canonical payload.
 * Throws on an empty selection or non-positive ids — a silent no-op
 * would corrupt the orders log's meaning.
 */
export function issueGroupMove(
  inbox: CommandInbox,
  currentTick: number,
  entityIds: readonly number[],
  x: number,
  y: number,
): SimCommand {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `groupMove destination must be finite, got (${String(x)}, ${String(y)})`,
    );
  }
  const ids: number[] = [];
  for (const id of entityIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `groupMove entity id must be a positive integer, got ${String(id)}`,
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error("groupMove requires at least one entity");
  }
  ids.sort((a, b) => a - b);
  const command: SimCommand = {
    kind: GROUP_MOVE_KIND,
    targetTick: currentTick + 1,
    data: { entityIds: ids, x, y },
  };
  inbox.submit(command);
  return command;
}

// ---- Order log (capped, newest-first) ---------------------------------------

export interface OrderLogEntry {
  readonly seq: number;
  /** Absolute sim tick the order was issued on. */
  readonly issuedTick: number;
  readonly label: string;
}

export function createOrderLog(limit = 20): {
  push(issuedTick: number, label: string): OrderLogEntry;
  entries(): readonly OrderLogEntry[];
} {
  const entries: OrderLogEntry[] = [];
  let nextSeq = 0;
  return {
    push(issuedTick: number, label: string): OrderLogEntry {
      const entry: OrderLogEntry = { seq: nextSeq++, issuedTick, label };
      entries.unshift(entry); // newest first, like the prototype panel
      if (entries.length > limit) entries.length = limit;
      return entry;
    },
    entries: () => entries,
  };
}

/** "MOVE · tick 42 · 12 units → (63, 48)" style line. */
export function formatMoveLabel(
  unitCount: number,
  x: number,
  y: number,
): string {
  return `${unitCount} ${unitCount === 1 ? "unit" : "units"} → (${Math.round(x)}, ${Math.round(y)})`;
}

// ---- Input wiring (browser-only) ---------------------------------------------

export interface OrderInputDeps {
  /** Canvas receiving right-clicks (the three.js renderer canvas). */
  canvas: HTMLCanvasElement;
  /** Element the orders log panel appends to. */
  panelRoot: ParentNode;
  /** Ground-plane raycast: client pixel → world XZ point, or null. */
  getGroundPoint(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null;
  /** Current selected-entity count (orders require a live selection). */
  selectionCount(): number;
  /** Selected eids to carry in the command. */
  selection(): readonly number[];
  /** Sim state accessors kept narrow for testability. */
  currentTick(): number;
  inbox: CommandInbox;
  /** Same-frame feedback hook: called synchronously on issue. */
  onMoveOrdered(x: number, y: number): void;
}

const ORDERS_PANEL_LIMIT = 20;

export function wireOrderInput(deps: OrderInputDeps): void {
  // Orders log panel — top-right, newest first, last ~20 entries. The
  // DOM list renders FROM the pure capped log (single source of truth).
  const log = createOrderLog(ORDERS_PANEL_LIMIT);

  const panel = document.createElement("div");
  panel.id = "orders-panel";
  const title = document.createElement("h3");
  title.textContent = "Orders";
  const list = document.createElement("ul");
  panel.append(title, list);
  deps.panelRoot.appendChild(panel);

  const renderList = (): void => {
    while (list.firstChild) list.firstChild.remove();
    for (const entry of log.entries()) {
      const item = document.createElement("li");
      const kind = document.createElement("span");
      kind.className = "order-kind";
      kind.textContent = "MOV";
      const text = document.createElement("span");
      text.textContent = entry.label;
      item.append(kind, text);
      list.appendChild(item);
    }
  };

  deps.canvas.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault(); // never open the browser menu over the map
    const ground = deps.getGroundPoint(event.clientX, event.clientY);
    if (!ground || deps.selectionCount() === 0) return;
    const selection = deps.selection();
    const command = issueGroupMove(
      deps.inbox,
      deps.currentTick(),
      selection,
      ground.x,
      ground.y,
    );
    // Same-frame feedback: marker exists before this handler returns.
    deps.onMoveOrdered(ground.x, ground.y);
    log.push(
      command.targetTick,
      `tick ${String(command.targetTick)} · ` +
        formatMoveLabel(selection.length, ground.x, ground.y),
    );
    renderList();
  });
}
