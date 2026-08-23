/**
 * Orders — SPEC §2.13 prototype-validated command layer (M1-T8/T9).
 *
 * Right-click contextual orders. Ground right-clicks issue
 * `{kind:"groupMove"}` commands; right-clicking a resource node with a
 * live selection issues `{kind:"gather"}` instead (M1-T9). Both go into
 * the sim inbox targeted at the NEXT tick (`currentTick + 1`) —
 * replay-relevant input that golden fixtures drive verbatim.
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

/** Movement command kind (M1-T8). */
export const GROUP_MOVE_KIND = "groupMove";
/** Gather command kind (M1-T9). */
export const GATHER_KIND = "gather";
/** Build (assign villagers to a construction site) kind (M1-T10). */
export const BUILD_KIND = "build";
/** Attack-move command kind (M2-T6, SPEC §2.13 key A). */
export const ATTACK_MOVE_KIND = "attackMove";
/** Stop command kind (M2-T6, SPEC §2.13 key S). */
export const STOP_KIND = "stop";

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

/**
 * Validate, canonicalize (dedupe + ascending sort), and submit one
 * gather order against `nodeId` for delivery exactly on
 * `currentTick + 1`. Same canonical-payload discipline as issueGroupMove.
 */
export function issueGather(
  inbox: CommandInbox,
  currentTick: number,
  entityIds: readonly number[],
  nodeId: number,
): SimCommand {
  if (typeof nodeId !== "number" || !Number.isInteger(nodeId) || nodeId < 1) {
    throw new Error(
      `gather node id must be a positive integer, got ${String(nodeId)}`,
    );
  }
  const ids: number[] = [];
  for (const id of entityIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `gather entity id must be a positive integer, got ${String(id)}`,
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error("gather requires at least one entity");
  }
  ids.sort((a, b) => a - b);
  const command: SimCommand = {
    kind: GATHER_KIND,
    targetTick: currentTick + 1,
    data: { entityIds: ids, nodeId },
  };
  inbox.submit(command);
  return command;
}

/**
 * Validate, canonicalize (dedupe + ascending sort), and submit one
 * build order sending villagers to construct `siteEid`, delivered
 * exactly on `currentTick + 1`. Same canonical-payload discipline as
 * issueGroupMove.
 */
export function issueBuild(
  inbox: CommandInbox,
  currentTick: number,
  entityIds: readonly number[],
  siteEid: number,
): SimCommand {
  if (
    typeof siteEid !== "number" ||
    !Number.isInteger(siteEid) ||
    siteEid < 1
  ) {
    throw new Error(
      `build site id must be a positive integer, got ${String(siteEid)}`,
    );
  }
  const ids: number[] = [];
  for (const id of entityIds) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `build entity id must be a positive integer, got ${String(id)}`,
      );
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error("build requires at least one entity");
  }
  ids.sort((a, b) => a - b);
  const command: SimCommand = {
    kind: BUILD_KIND,
    targetTick: currentTick + 1,
    data: { entityIds: ids, siteEid },
  };
  inbox.submit(command);
  return command;
}

/**
 * Validate, canonicalize (dedupe + ascending sort), and submit one
 * attack-move order (M2-T6): march combat-ready to (x, y), acquiring
 * enemies inside aggro radius en route. Delivered exactly on
 * `currentTick + 1`. Same canonical-payload discipline as issueGroupMove.
 */
export function issueAttackMove(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
  x: number,
  y: number,
): SimCommand {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `attackMove destination must be finite, got (${String(x)}, ${String(y)})`,
    );
  }
  const entityIds = canonicalIds(ids, "attackMove");
  const command: SimCommand = {
    kind: ATTACK_MOVE_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds, x, y },
  };
  inbox.submit(command);
  return command;
}

/**
 * Validate, canonicalize, and submit one stop order (M2-T6, SPEC §2.13
 * key S): cancel every queued activity and drop engagements.
 */
export function issueStop(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
): SimCommand {
  const entityIds = canonicalIds(ids, "stop");
  const command: SimCommand = {
    kind: STOP_KIND,
    targetTick: currentTick + 1,
    data: { entityIds },
  };
  inbox.submit(command);
  return command;
}

/** Shared id canonicalization for the issuers above. */
function canonicalIds(ids: readonly number[], label: string): number[] {
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(
        `${label} entity id must be a positive integer, got ${String(id)}`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) {
    throw new Error(`${label} requires at least one entity`);
  }
  out.sort((a, b) => a - b);
  return out;
}

// ---- Order log (capped, newest-first) ---------------------------------------

export type OrderKind = "move" | "gather" | "build";

export interface OrderLogEntry {
  readonly seq: number;
  /** Absolute sim tick the order was issued on. */
  readonly issuedTick: number;
  readonly kind: OrderKind;
  readonly label: string;
}

export function createOrderLog(limit = 20): {
  push(
    issuedTick: number,
    entry: { kind: OrderKind; label: string },
  ): OrderLogEntry;
  entries(): readonly OrderLogEntry[];
} {
  const entries: OrderLogEntry[] = [];
  let nextSeq = 0;
  return {
    push(issuedTick, entry): OrderLogEntry {
      const logEntry: OrderLogEntry = {
        seq: nextSeq++,
        issuedTick,
        kind: entry.kind,
        label: entry.label,
      };
      entries.unshift(logEntry); // newest first, like the prototype panel
      if (entries.length > limit) entries.length = limit;
      return logEntry;
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

/** "GATHER · tick 42 · 12 units → node 37" style line. */
export function formatGatherLabel(unitCount: number, nodeId: number): string {
  return `${unitCount} ${unitCount === 1 ? "unit" : "units"} → node ${String(nodeId)}`;
}

/** "BUILD · tick 42 · 3 units → site 41" style line. */
export function formatBuildLabel(unitCount: number, siteEid: number): string {
  return `${unitCount} ${unitCount === 1 ? "unit" : "units"} → site ${String(siteEid)}`;
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
  /**
   * Resource-node entity under a world point, or undefined (M1-T9).
   * When provided and hit, right-clicks become gather orders.
   */
  nodeAt?(x: number, y: number): number | undefined;
  /**
   * Construction-site entity under a world point, or undefined
   * (M1-T10). When hit with a live selection, right-clicks become
   * build orders (priority over ground moves, below gather).
   */
  siteAt?(x: number, y: number): number | undefined;
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
      kind.className =
        entry.kind === "gather"
          ? "order-kind order-kind-gather"
          : entry.kind === "build"
            ? "order-kind order-kind-build"
            : "order-kind";
      kind.textContent =
        entry.kind === "gather"
          ? "GTH"
          : entry.kind === "build"
            ? "BLD"
            : "MOV";
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

    // Contextual dispatch: node → gather, construction site → build,
    // otherwise ground move.
    const nodeId = deps.nodeAt?.(ground.x, ground.y);
    if (nodeId !== undefined) {
      const command = issueGather(
        deps.inbox,
        deps.currentTick(),
        selection,
        nodeId,
      );
      log.push(command.targetTick, {
        kind: "gather",
        label:
          `tick ${String(command.targetTick)} · ` +
          formatGatherLabel(selection.length, nodeId),
      });
      renderList();
      return;
    }

    const siteId = deps.siteAt?.(ground.x, ground.y);
    if (siteId !== undefined) {
      const command = issueBuild(
        deps.inbox,
        deps.currentTick(),
        selection,
        siteId,
      );
      log.push(command.targetTick, {
        kind: "build",
        label:
          `tick ${String(command.targetTick)} · ` +
          formatBuildLabel(selection.length, siteId),
      });
      renderList();
      return;
    }

    const command = issueGroupMove(
      deps.inbox,
      deps.currentTick(),
      selection,
      ground.x,
      ground.y,
    );
    // Same-frame feedback: marker exists before this handler returns.
    deps.onMoveOrdered(ground.x, ground.y);
    log.push(command.targetTick, {
      kind: "move",
      label:
        `tick ${String(command.targetTick)} · ` +
        formatMoveLabel(selection.length, ground.x, ground.y),
    });
    renderList();
  });
}
