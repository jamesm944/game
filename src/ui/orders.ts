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

export const PATROL_KIND = "patrol";
export const GUARD_KIND = "guard";
export const SET_STANCE_KIND = "setStance";

export function issuePatrol(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
  waypoints: readonly { x: number; y: number }[],
): SimCommand {
  const entityIds = canonicalIds(ids, "patrol");
  if (waypoints.length < 2) {
    throw new Error("patrol requires at least 2 waypoints");
  }
  const command: SimCommand = {
    kind: PATROL_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds, waypoints },
  };
  inbox.submit(command);
  return command;
}

export function issueGuard(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
  targetId: number,
): SimCommand {
  const entityIds = canonicalIds(ids, "guard");
  if (!Number.isInteger(targetId) || targetId < 1) {
    throw new Error("guard targetId must be a positive integer");
  }
  const command: SimCommand = {
    kind: GUARD_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds, targetId },
  };
  inbox.submit(command);
  return command;
}

export function issueSetStance(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
  stance: string,
): SimCommand {
  const entityIds = canonicalIds(ids, "setStance");
  const command: SimCommand = {
    kind: SET_STANCE_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds, stance },
  };
  inbox.submit(command);
  return command;
}

export const GARRISON_KIND = "garrison";
export const UNGARRISON_KIND = "ungarrison";

export function issueGarrison(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
  targetBuildingId: number,
): SimCommand {
  const entityIds = canonicalIds(ids, "garrison");
  if (!Number.isInteger(targetBuildingId) || targetBuildingId < 1) {
    throw new Error("garrison targetBuildingId must be a positive integer");
  }
  const command: SimCommand = {
    kind: GARRISON_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds, targetBuildingId },
  };
  inbox.submit(command);
  return command;
}

export function issueUngarrison(
  inbox: CommandInbox,
  currentTick: number,
  buildingEid: number,
  exitPoint?: { x: number; y: number },
): SimCommand {
  if (!Number.isInteger(buildingEid) || buildingEid < 1) {
    throw new Error("ungarrison buildingEid must be a positive integer");
  }
  const command: SimCommand = {
    kind: UNGARRISON_KIND,
    targetTick: currentTick + 1,
    data: { buildingEid, ...(exitPoint ? { exitPoint } : {}) },
  };
  inbox.submit(command);
  return command;
}

export const PACK_KIND = "pack";
export const UNPACK_KIND = "unpack";

export function issuePack(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
): SimCommand {
  const entityIds = canonicalIds(ids, "pack");
  const command: SimCommand = {
    kind: PACK_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds },
  };
  inbox.submit(command);
  return command;
}

export function issueUnpack(
  inbox: CommandInbox,
  currentTick: number,
  ids: readonly number[],
): SimCommand {
  const entityIds = canonicalIds(ids, "unpack");
  const command: SimCommand = {
    kind: UNPACK_KIND,
    targetTick: currentTick + 1,
    data: { ids: entityIds },
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

export type OrderKind =
  | "move"
  | "gather"
  | "build"
  | "stop"
  | "attack"
  | "attackMove"
  | "relic"
  | "trade"
  | "rally"
  | "garrison"
  | "ungarrison"
  | "pack"
  | "unpack";

const KIND_TAGS: Record<OrderKind, string> = {
  move: "MOV",
  gather: "GTH",
  build: "BLD",
  stop: "STP",
  attack: "ATK",
  attackMove: "A-M",
  relic: "RLC",
  trade: "TRD",
  rally: "RLY",
  garrison: "GAR",
  ungarrison: "UNG",
  pack: "PCK",
  unpack: "UPK",
};

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
  /**
   * Grounded relic entity under a world point, or undefined (issue #76 / §2.11).
   */
  relicAt?(x: number, y: number): number | undefined;
  /**
   * Monastery building entity under a world point, or undefined.
   */
  monasteryAt?(x: number, y: number): number | undefined;
  /**
   * Market building entity under a world point, or undefined.
   */
  marketAt?(x: number, y: number): number | undefined;
  /**
   * Query if a selected unit is a trade cart.
   */
  isTradeCart?(unitEid: number): boolean;
  /** Query if a selected unit is carrying a relic. */
  isCarryingRelic?(unitEid: number): boolean;
  /** Query if a selected entity is a production building with a train queue. */
  isProductionBuilding?(eid: number): boolean;
  /** Set rally point for a production building. */
  setRallyPoint?(buildingEid: number, rallyX: number, rallyY: number): void;
  /**
   * Allied garrison target building entity under a world point, or undefined.
   */
  garrisonAt?(x: number, y: number): number | undefined;
  /** Same-frame feedback hook: called synchronously on issue. */
  onMoveOrdered(x: number, y: number): void;
}

export const COLLECT_RELIC_COMMAND_KIND = "collectRelic";
export const DEPOSIT_RELIC_COMMAND_KIND = "depositRelic";
export const TRADE_ROUTE_COMMAND_KIND = "tradeRoute";

export function issueTradeRoute(
  inbox: CommandInbox,
  currentTick: number,
  unitEid: number,
  targetMarketEid: number,
): SimCommand {
  const command: SimCommand = {
    kind: TRADE_ROUTE_COMMAND_KIND,
    targetTick: currentTick + 1,
    data: { unitEid, targetMarketEid },
  };
  inbox.submit(command);
  return command;
}

export function issueCollectRelic(
  inbox: CommandInbox,
  currentTick: number,
  unitEid: number,
  relicEid: number,
): SimCommand {
  const command: SimCommand = {
    kind: COLLECT_RELIC_COMMAND_KIND,
    targetTick: currentTick + 1,
    data: { unitEid, relicEid },
  };
  inbox.submit(command);
  return command;
}

export function issueDepositRelic(
  inbox: CommandInbox,
  currentTick: number,
  unitEid: number,
  monasteryEid: number,
): SimCommand {
  const command: SimCommand = {
    kind: DEPOSIT_RELIC_COMMAND_KIND,
    targetTick: currentTick + 1,
    data: { unitEid, monasteryEid },
  };
  inbox.submit(command);
  return command;
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
      const kindClass =
        entry.kind === "gather"
          ? "order-kind order-kind-gather"
          : entry.kind === "build"
            ? "order-kind order-kind-build"
            : entry.kind === "relic"
              ? "order-kind order-kind-relic"
              : entry.kind === "trade"
                ? "order-kind order-kind-trade"
                : entry.kind === "rally"
                  ? "order-kind order-kind-rally"
                  : entry.kind === "garrison"
                    ? "order-kind order-kind-garrison"
                    : "order-kind";
      kind.className = kindClass;
      kind.textContent = KIND_TAGS[entry.kind] ?? "MOV";
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

    // Contextual dispatch:
    // 0. Production building -> set rally point
    if (
      deps.selectionCount() === 1 &&
      deps.isProductionBuilding?.(selection[0]!)
    ) {
      const bEid = selection[0]!;
      deps.setRallyPoint?.(bEid, ground.x, ground.y);
      deps.onMoveOrdered(ground.x, ground.y);
      log.push(deps.currentTick() + 1, {
        kind: "rally",
        label: `tick ${String(deps.currentTick() + 1)} · Rally Point → (${Math.round(ground.x)}, ${Math.round(ground.y)})`,
      });
      renderList();
      return;
    }
    // 1. Relic collection: if grounded relic is clicked
    const relicId = deps.relicAt?.(ground.x, ground.y);
    if (relicId !== undefined && selection.length > 0) {
      const carrier = selection[0]!;
      const command = issueCollectRelic(
        deps.inbox,
        deps.currentTick(),
        carrier,
        relicId,
      );
      deps.onMoveOrdered(ground.x, ground.y);
      log.push(command.targetTick, {
        kind: "relic",
        label: `tick ${String(command.targetTick)} · Collect Relic #${String(relicId)}`,
      });
      renderList();
      return;
    }

    // 2. Relic deposition: if monastery is clicked with carrier selected
    const monasteryId = deps.monasteryAt?.(ground.x, ground.y);
    if (monasteryId !== undefined && selection.length > 0) {
      const carrier =
        selection.find((eid) => deps.isCarryingRelic?.(eid)) ??
        (deps.isCarryingRelic?.(selection[0]!) ? selection[0] : undefined);
      if (carrier !== undefined) {
        const command = issueDepositRelic(
          deps.inbox,
          deps.currentTick(),
          carrier,
          monasteryId,
        );
        deps.onMoveOrdered(ground.x, ground.y);
        log.push(command.targetTick, {
          kind: "relic",
          label: `tick ${String(command.targetTick)} · Deposit Relic into Monastery #${String(monasteryId)}`,
        });
        renderList();
        return;
      }
    }

    // 3. Market -> Trade Route (if a Trade Cart is selected)
    const marketId = deps.marketAt?.(ground.x, ground.y);
    if (marketId !== undefined && selection.length > 0) {
      const cartEid = selection.find((eid) => deps.isTradeCart?.(eid));
      if (cartEid !== undefined) {
        const command = issueTradeRoute(
          deps.inbox,
          deps.currentTick(),
          cartEid,
          marketId,
        );
        deps.onMoveOrdered(ground.x, ground.y);
        log.push(command.targetTick, {
          kind: "trade",
          label: `tick ${String(command.targetTick)} · Trade Route to Market #${String(marketId)}`,
        });
        renderList();
        return;
      }
    }

    // 4. Node -> gather
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

    // 4. Construction site -> build
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

    // 5. Garrison -> enter tower, castle or town center
    const garrisonTargetId = deps.garrisonAt?.(ground.x, ground.y);
    if (garrisonTargetId !== undefined && selection.length > 0) {
      const command = issueGarrison(
        deps.inbox,
        deps.currentTick(),
        selection,
        garrisonTargetId,
      );
      deps.onMoveOrdered(ground.x, ground.y);
      log.push(command.targetTick, {
        kind: "garrison",
        label: `tick ${String(command.targetTick)} · Garrison ${selection.length} units → #${String(garrisonTargetId)}`,
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
