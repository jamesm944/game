/**
 * Selection — SPEC §2.13 prototype-validated command layer (M1-T8).
 *
 * Owns the player's selected-entity set as a MODULE-LEVEL singleton so
 * it survives context switches (panel toggles, mode changes) exactly
 * like the approved prototype. Input wiring is browser-only and lives
 * behind `wireSelectionInput`; the state accessors are plain functions,
 * importable headlessly.
 *
 * Picking follows the §2.13 stance: ray-to-ground-plane through the
 * orthographic RTS camera (`groundPointAt`), then a spatial-hash query
 * over the latest post-step SIM coordinates — never mesh raycasts.
 *
 * Interactions (CONTROLS.md):
 *   left-drag        box select (screen-space marquee → world rect)
 *   left-click       select nearest unit / deselect on empty ground
 *   shift+click      toggle entity in/out of selection
 *   shift+drag       add box contents to current selection
 *   double-click     select every unit of the same type on screen
 *   Esc              deselect all
 *
 * M1 placeholder: every movable entity is a villager, so "same type"
 * is a constant today; a future UnitType lookup slots into unitTypeOf.
 */

/** Screen-pixels of movement before a press becomes a marquee drag. */
const DRAG_THRESHOLD_PX = 4;
/** Click pick radius in screen pixels (validated prototype feel). */
const PICK_RADIUS_PX = 12;

import { buildEntitySpatialHash } from "../sim/core/spatialHash";

/** Snapshot-shaped frame (structurally SimSnapshotFrame). */
export interface SelectionFrame {
  readonly count: number;
  readonly eids: Int32Array;
  readonly positions: Float32Array;
}

// ---- Module-level selection state (survives context switches) ---------------

const selectedEids = new Set<number>();
let liveEids: ReadonlySet<number> = new Set();

/** Feed the latest post-step live-eid set; dead ids are pruned silently. */
export function noteLiveEids(eids: Int32Array, count: number): void {
  if (liveEids.size === count) {
    let unchanged = true;
    for (const eid of liveEids) {
      if (!eids.includes(eid)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return;
  }
  const next = new Set<number>();
  for (let i = 0; i < count; i++) next.add(eids[i]!);
  liveEids = next;
  for (const eid of selectedEids) {
    if (!liveEids.has(eid)) selectedEids.delete(eid);
  }
}

/** Live selected eids as a fresh ascending array. */
export function getSelectedEids(): number[] {
  return [...selectedEids].sort((a, b) => a - b);
}

export function isSelected(eid: number): boolean {
  return selectedEids.has(eid);
}

/** Number of currently-selected entities. */
export function selectionCount(): number {
  return selectedEids.size;
}

/** Replace the selection wholesale. */
export function setSelection(eids: readonly number[]): void {
  selectedEids.clear();
  for (const eid of eids) selectedEids.add(eid);
}

export function clearSelection(): void {
  selectedEids.clear();
}

function toggleSelection(eid: number): void {
  if (!selectedEids.delete(eid)) selectedEids.add(eid);
}

function addToSelection(eids: readonly number[]): void {
  for (const eid of eids) selectedEids.add(eid);
}

// ---- Input wiring (browser-only) --------------------------------------------

export interface SelectionInputDeps {
  /** Canvas receiving pointer events (the three.js renderer canvas). */
  canvas: HTMLCanvasElement;
  /**
   * Ground-plane raycast: client pixel → sim-coordinate {x, y} on the
   * world XZ plane, or null when the ray misses.
   */
  groundPointAt(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null;
  /** Latest post-step snapshot for hash building (or null before first). */
  getFrame(): SelectionFrame | null;
  /** World tiles covered by one screen pixel right now (zoom-dependent). */
  worldPerPixel(): number;
  /** Exact viewport test used by double-click's on-screen filter. */
  isOnScreen(x: number, y: number): boolean;
  /**
   * Building/construction-site entity under a world point, or
   * undefined (M1-T10). Consulted when the unit hash misses, so single
   * clicks can select buildings as well as Pops.
   */
  buildingAt?(x: number, y: number): number | undefined;
  /**
   * Buildings/construction sites intersecting world rect bounds.
   * Consulted when box select encloses no units (AoE2-style unit priority).
   */
  buildingsInRect?(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): number[];
  /** True when placement is armed (prevents dragging selection box during placement). */
  isPlacementArmed?(): boolean;
}

interface MarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** M1 placeholder: one unit kind exists until definition tickets land. */
function unitTypeOf(_eid: number): string {
  return "villager";
}

function hashFrom(frame: SelectionFrame | null) {
  return buildEntitySpatialHash(
    frame ?? {
      count: 0,
      eids: new Int32Array(0),
      positions: new Float32Array(0),
    },
  );
}

export function wireSelectionInput(deps: SelectionInputDeps): void {
  const marquee = document.createElement("div");
  marquee.id = "marquee";
  marquee.style.display = "none";
  document.body.appendChild(marquee);

  let down = false;
  let dragging = false;
  let startClientX = 0;
  let startClientY = 0;
  let shiftDown = false;

  const showMarquee = (rect: MarqueeRect): void => {
    marquee.style.display = "block";
    marquee.style.left = `${rect.x}px`;
    marquee.style.top = `${rect.y}px`;
    marquee.style.width = `${rect.w}px`;
    marquee.style.height = `${rect.h}px`;
  };

  const marqueeRect = (curX: number, curY: number): MarqueeRect => ({
    x: Math.min(startClientX, curX),
    y: Math.min(startClientY, curY),
    w: Math.abs(curX - startClientX),
    h: Math.abs(curY - startClientY),
  });

  /** Pick radius in world tiles for the current zoom level. */
  const pickRadiusTiles = (): number => {
    const radius = PICK_RADIUS_PX * deps.worldPerPixel();
    return Math.min(1.25, Math.max(0.35, radius));
  };

  /** Nearest live unit under a client pixel, or undefined. */
  const hitTest = (
    clientX: number,
    clientY: number,
  ): { eid: number } | undefined => {
    const ground = deps.groundPointAt(clientX, clientY);
    const frame = deps.getFrame();
    if (!ground || !frame || frame.count === 0) return undefined;
    return hashFrom(frame).nearest(ground.x, ground.y, pickRadiusTiles());
  };

  /** World-space XZ rectangle between two client pixels. */
  const worldRectFromClients = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null => {
    const cornerA = deps.groundPointAt(ax, ay);
    const cornerB = deps.groundPointAt(bx, by);
    if (!cornerA || !cornerB) return null;
    return {
      minX: Math.min(cornerA.x, cornerB.x),
      maxX: Math.max(cornerA.x, cornerB.x),
      minY: Math.min(cornerA.y, cornerB.y),
      maxY: Math.max(cornerA.y, cornerB.y),
    };
  };

  const boxSelect = (
    additive: boolean,
    rect: ReturnType<typeof worldRectFromClients>,
  ): void => {
    if (!rect) return;
    const frame = deps.getFrame();
    const hits =
      frame && frame.count > 0
        ? hashFrom(frame).queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY)
        : [];
    if (hits.length > 0) {
      if (additive) addToSelection(hits);
      else setSelection(hits);
      return;
    }
    // When no units are in the box, check for buildings in the rect (modern RTS QoL)
    const bHits =
      deps.buildingsInRect?.(rect.minX, rect.minY, rect.maxX, rect.maxY) ?? [];
    if (bHits.length > 0) {
      if (additive) addToSelection(bHits);
      else setSelection(bHits);
      return;
    }
    if (!additive) clearSelection(); // empty box without shift deselects (prototype)
  };

  const selectSameTypeOnScreen = (eid: number): void => {
    const frame = deps.getFrame();
    if (!frame || frame.count === 0) return;
    const hash = hashFrom(frame);
    // Conservative world AABB of the viewport from ground-plane corner
    // rays, then the exact per-unit on-screen test.
    const w = window.innerWidth;
    const h = window.innerHeight;
    const corners = [
      deps.groundPointAt(0, 0),
      deps.groundPointAt(w, 0),
      deps.groundPointAt(w, h),
      deps.groundPointAt(0, h),
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const corner of corners) {
      if (!corner) continue;
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y);
      maxY = Math.max(maxY, corner.y);
    }
    if (!Number.isFinite(minX)) return;
    const type = unitTypeOf(eid);
    const onScreen: number[] = [];
    for (const candidate of hash.queryRect(minX, minY, maxX, maxY)) {
      if (unitTypeOf(candidate) !== type) continue;
      // Find its position by rank to run the exact frustum test.
      for (let i = 0; i < frame.count; i++) {
        if (frame.eids[i] !== candidate) continue;
        if (
          deps.isOnScreen(frame.positions[i * 2]!, frame.positions[i * 2 + 1]!)
        ) {
          onScreen.push(candidate);
        }
        break;
      }
    }
    if (onScreen.length > 0) setSelection(onScreen);
  };

  deps.canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0 || deps.isPlacementArmed?.()) return;
    down = true;
    dragging = false;
    shiftDown = event.shiftKey;
    startClientX = event.clientX;
    startClientY = event.clientY;
  });

  window.addEventListener("pointermove", (event: PointerEvent) => {
    if (!down) return;
    if (
      !dragging &&
      (Math.abs(event.clientX - startClientX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - startClientY) > DRAG_THRESHOLD_PX)
    ) {
      dragging = true;
    }
    if (dragging) showMarquee(marqueeRect(event.clientX, event.clientY));
  });

  window.addEventListener("pointerup", (event: PointerEvent) => {
    if (event.button !== 0 || !down) return;
    down = false;
    marquee.style.display = "none";
    if (dragging) {
      dragging = false;
      boxSelect(
        shiftDown,
        worldRectFromClients(
          startClientX,
          startClientY,
          event.clientX,
          event.clientY,
        ),
      );
      return;
    }
    const unitHit = hitTest(event.clientX, event.clientY);
    let hit = unitHit;
    if (!unitHit) {
      // Unit hash missed: fall back to building/site footprint picking.
      const ground = deps.groundPointAt(event.clientX, event.clientY);
      const buildingEid =
        ground !== null ? deps.buildingAt?.(ground.x, ground.y) : undefined;
      if (buildingEid !== undefined) hit = { eid: buildingEid };
    }
    if (hit) {
      if (shiftDown) toggleSelection(hit.eid);
      else setSelection([hit.eid]);
    } else if (!shiftDown) {
      clearSelection(); // click on empty ground deselects
    }
  });

  deps.canvas.addEventListener("dblclick", (event: MouseEvent) => {
    if (event.button !== 0) return;
    const hit = hitTest(event.clientX, event.clientY);
    if (hit) selectSameTypeOnScreen(hit.eid);
  });

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.code === "Escape") clearSelection();
  });
}
