/**
 * Minimap — SPEC §2.13 prototype-validated command layer (M1-T8),
 * fog tri-state projection M2-T8.
 *
 * Bottom-right canvas: the terrain layers are mini-rendered ONCE into
 * an offscreen buffer (per-tile palette + elevation shading), then each
 * redraw blits that buffer, applies the fog planes as a per-tile
 * tri-state overlay (unexplored black / explored-dim / visible bright —
 * a pure projection of the sim planes, never independent state, ~4 Hz),
 * paints unit dots from the latest post-step snapshot (own Pops always;
 * enemy dots only on visible tiles), and strokes the camera viewport
 * quad (ground-plane projections of the four screen corners — a
 * trapezoid under the pitched orthographic rig). Click/drag anywhere
 * jumps the camera via `setCenter`.
 *
 * All DOM/canvas access lives inside the factory; importing this file
 * headlessly is safe.
 */

import type { WorldLayers } from "../sim/world/layers";
import type { SelectionFrame } from "./selection";

/** CSS size of the square minimap in pixels (validated prototype feel). */
const MINIMAP_CSS_PX = 176;
/** Redraw cadence handled by the caller (~4 Hz, SPEC §2.9). */
export const MINIMAP_REDRAW_MS = 250;

/** Tri-state fog shading for one minimap tile (SPEC §2.9). */
export const MINIMAP_SHADE_UNEXPLORED = 0;
export const MINIMAP_SHADE_DIM = 1;
export const MINIMAP_SHADE_BRIGHT = 2;

/**
 * Pure projection of the fog planes onto the minimap tri-state. The
 * redraw loop and the golden tests share this exact mapping so the
 * canvas can never disagree with the planes.
 */
export function minimapShadeFor(
  isExplored: boolean,
  isVisible: boolean,
): number {
  if (!isExplored) return MINIMAP_SHADE_UNEXPLORED;
  return isVisible ? MINIMAP_SHADE_BRIGHT : MINIMAP_SHADE_DIM;
}

/**
 * Same palette as render/terrain.ts's TERRAIN_HEX (kept literal here to
 * leave the terrain module untouched; both derive from the STABLE
 * terrain-id enum — never renumber).
 */
const TERRAIN_MINI_HEX: readonly number[] = [
  0x16324a, // deep-water
  0x2e648c, // water
  0xc7ae7e, // shore
  0x59853f, // grass
  0x8a6f47, // dirt
  0x39562e, // forest-floor
];

// Dot palette (M5-T4 §2.13 readability pass): own dots brightened so
// they stay readable over the night-dimmed terrain bake and the fog
// dim overlay; enemy dots get their own warm hue instead of sharing
// the own-unit blue — under a 0.45 black dim layer two same-hue dots
// were indistinguishable. Exported for headless assertions.
export const OWN_DOT_HEX = "#a9d2ff";
export const ENEMY_DOT_HEX = "#ff8a66";
export const SELECTED_DOT_HEX = "#ffffff";

// Resource node palette — V14 / Issue #100
export const MINIMAP_RESOURCE_GOLD_HEX = "#facc15"; // bright gold-yellow
export const MINIMAP_RESOURCE_STONE_HEX = "#94a3b8"; // stone grey
export const MINIMAP_RESOURCE_FOOD_HEX = "#22c55e"; // food/berries green
export const MINIMAP_RESOURCE_IRON_HEX = "#818cf8"; // iron violet-grey
export const MINIMAP_RESOURCE_COAL_HEX = "#475569"; // coal dark slate
export const MINIMAP_RESOURCE_CLAY_HEX = "#fb923c"; // clay orange

// Building palette — V14 / Issue #100
export const ENEMY_BUILDING_VISIBLE_HEX = "#ef4444"; // bright red
export const ENEMY_BUILDING_GHOST_HEX = "#991b1b"; // dark red memory ghost
export const OWN_BUILDING_HEX = "#3b82f6"; // friendly blue

// Viewport rect styling — V14 / Issue #100
export const VIEWPORT_BORDER_STROKE = "rgba(254, 240, 138, 0.95)"; // warm gold
export const VIEWPORT_FILL_STYLE = "rgba(255, 255, 255, 0.08)";
export const VIEWPORT_LINE_WIDTH = 1.5;

export function colorForResource(code: number): string | null {
  switch (code) {
    case 0:
      return MINIMAP_RESOURCE_FOOD_HEX;
    case 2:
      return MINIMAP_RESOURCE_GOLD_HEX;
    case 3:
      return MINIMAP_RESOURCE_STONE_HEX;
    case 4:
      return MINIMAP_RESOURCE_IRON_HEX;
    case 5:
      return MINIMAP_RESOURCE_COAL_HEX;
    case 6:
      return MINIMAP_RESOURCE_CLAY_HEX;
    default:
      return null;
  }
}

/** Pure point-in-polygon ray-casting test. */
export function isPointInPolygon(
  x: number,
  y: number,
  poly: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function shade(hex: number, factor: number): string {
  const r = Math.round(((hex >> 16) & 0xff) * factor);
  const g = Math.round(((hex >> 8) & 0xff) * factor);
  const b = Math.round((hex & 0xff) * factor);
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

export interface MinimapFogView {
  isVisible(tileX: number, tileY: number): boolean;
  isExplored(tileX: number, tileY: number): boolean;
}

export interface MinimapResourceNode {
  readonly x: number;
  readonly y: number;
  readonly resourceCode: number;
}

export interface MinimapBuilding {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly ownerId: number;
}

export interface MinimapDeps {
  readonly layers: WorldLayers;
  /** Latest post-step snapshot for unit dots (null before first step). */
  getFrame(): SelectionFrame | null;
  /** eid → selected test (white highlight dots). */
  isSelected(eid: number): boolean;
  /**
   * Fog planes projection (M2-T8). Omitted → legacy full-bright map
   * (fog-blind tests/fixtures).
   */
  readonly fog?: MinimapFogView | undefined;
  /** Ownership test gating enemy dots; defaults to "everyone is own". */
  isOwn?(eid: number): boolean;
  /** Ground-plane raycast of a client pixel → world XZ (viewport quad). */
  groundPointAt(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null;
  /** Camera jump hook for click/drag. */
  setCenter(x: number, y: number): void;

  /** Active resource nodes on the map (gold, stone, food, etc.). */
  getResourceNodes?(): readonly MinimapResourceNode[];
  /** Buildings on the map (own and enemy). */
  getBuildings?(): readonly MinimapBuilding[];
  /** Ownership test for buildings: defaults to comparing with 0 or isOwn. */
  isOwnBuilding?(ownerId: number): boolean;
  /** Camera center coordinates if directly available. */
  getCameraCenter?(): { x: number; y: number };
  /** Optional player color resolver for multi-player skirmish (S3 / #116). */
  readonly getPlayerColor?: ((ownerId: number) => string) | undefined;
  /** Optional unit owner resolver (S3 / #116). */
  readonly getUnitOwner?: ((eid: number) => number) | undefined;
}

export interface MinimapHandle {
  /** Repaint full minimap (terrain + fog + nodes + buildings + units + viewport). */
  redraw(): void;
  /** Repaint only the viewport quad over the cached background buffer (~60 Hz). */
  updateViewport(): void;
  readonly element: HTMLCanvasElement;
}

export function createMinimap(deps: MinimapDeps): MinimapHandle {
  const { layers } = deps;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = document.createElement("canvas");
  canvas.id = "minimap";
  canvas.width = Math.round(MINIMAP_CSS_PX * dpr);
  canvas.height = Math.round(MINIMAP_CSS_PX * dpr);
  canvas.style.width = `${String(MINIMAP_CSS_PX)}px`;
  canvas.style.height = `${String(MINIMAP_CSS_PX)}px`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("minimap 2d context unavailable");
  ctx.scale(dpr, dpr);

  const pxPerTile = MINIMAP_CSS_PX / layers.size;

  // ---- Terrain bake (once) -----------------------------------------------------
  const bake = document.createElement("canvas");
  bake.width = MINIMAP_CSS_PX;
  bake.height = MINIMAP_CSS_PX;
  const bakeCtx = bake.getContext("2d");
  if (!bakeCtx) throw new Error("minimap bake context unavailable");
  for (let ty = 0; ty < layers.size; ty++) {
    for (let tx = 0; tx < layers.size; tx++) {
      const index = ty * layers.size + tx;
      const hex = TERRAIN_MINI_HEX[layers.terrainType[index]!];
      if (hex === undefined) continue;
      const level = layers.elevationLevel[index]!;
      bakeCtx.fillStyle = shade(hex, 0.86 + level * 0.045);
      bakeCtx.fillRect(
        tx * pxPerTile,
        ty * pxPerTile,
        pxPerTile + 0.5,
        pxPerTile + 0.5,
      );
    }
  }

  // ---- Dynamic content back-buffer (updated on ~4 Hz redraw) -------------------
  const backBuffer = document.createElement("canvas");
  backBuffer.width = MINIMAP_CSS_PX;
  backBuffer.height = MINIMAP_CSS_PX;
  const backCtx = backBuffer.getContext("2d");
  if (!backCtx) throw new Error("minimap backBuffer context unavailable");

  // Initial draw of bake into backBuffer
  backCtx.drawImage(bake, 0, 0);

  // ---- Camera jump & viewport dragging interaction ----------------------------
  let pointerDown = false;
  let isDraggingViewport = false;
  let dragOffset = { dx: 0, dy: 0 };
  let lastViewportCorners: { x: number; y: number }[] = [];

  const eventToMap = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * layers.size;
    const y = ((event.clientY - rect.top) / rect.height) * layers.size;
    return {
      x: Math.min(layers.size, Math.max(0, x)),
      y: Math.min(layers.size, Math.max(0, y)),
    };
  };

  const getCameraCenter = (): { x: number; y: number } => {
    if (deps.getCameraCenter) return deps.getCameraCenter();
    const center = deps.groundPointAt(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    return center ?? { x: layers.size / 2, y: layers.size / 2 };
  };

  const updateViewport = (): void => {
    ctx.drawImage(backBuffer, 0, 0);

    const w = window.innerWidth;
    const h = window.innerHeight;
    const c0 = deps.groundPointAt(0, 0);
    const c1 = deps.groundPointAt(w, 0);
    const c2 = deps.groundPointAt(w, h);
    const c3 = deps.groundPointAt(0, h);
    const corners = [c0, c1, c2, c3].filter(
      (c): c is { x: number; y: number } => c !== null,
    );
    lastViewportCorners = corners;

    if (corners.length < 3) return;

    ctx.beginPath();
    ctx.moveTo(corners[0]!.x * pxPerTile, corners[0]!.y * pxPerTile);
    for (let i = 1; i < corners.length; i++) {
      ctx.lineTo(corners[i]!.x * pxPerTile, corners[i]!.y * pxPerTile);
    }
    ctx.closePath();

    ctx.fillStyle = VIEWPORT_FILL_STYLE;
    ctx.fill();

    ctx.strokeStyle = VIEWPORT_BORDER_STROKE;
    ctx.lineWidth = VIEWPORT_LINE_WIDTH;
    ctx.stroke();
  };

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    pointerDown = true;
    canvas.setPointerCapture(event.pointerId);

    const mapPt = eventToMap(event);
    const inside =
      lastViewportCorners.length >= 3 &&
      isPointInPolygon(mapPt.x, mapPt.y, lastViewportCorners);
    const cam = getCameraCenter();

    if (inside) {
      isDraggingViewport = true;
      dragOffset = { dx: cam.x - mapPt.x, dy: cam.y - mapPt.y };
      canvas.style.cursor = "grabbing";
    } else {
      isDraggingViewport = true;
      dragOffset = { dx: 0, dy: 0 };
      deps.setCenter(mapPt.x, mapPt.y);
      canvas.style.cursor = "grabbing";
      updateViewport();
    }
  });

  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    const mapPt = eventToMap(event);
    if (pointerDown && isDraggingViewport) {
      deps.setCenter(
        Math.min(layers.size, Math.max(0, mapPt.x + dragOffset.dx)),
        Math.min(layers.size, Math.max(0, mapPt.y + dragOffset.dy)),
      );
      updateViewport();
    } else if (!pointerDown) {
      const inside =
        lastViewportCorners.length >= 3 &&
        isPointInPolygon(mapPt.x, mapPt.y, lastViewportCorners);
      canvas.style.cursor = inside ? "grab" : "crosshair";
    }
  });

  const release = (): void => {
    pointerDown = false;
    isDraggingViewport = false;
    canvas.style.cursor = "crosshair";
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  return {
    element: canvas,
    updateViewport,
    redraw(): void {
      // 1. Reset backBuffer with static terrain bake
      backCtx.drawImage(bake, 0, 0);

      // 2. Fog tri-state overlay — pure projection of the planes.
      if (deps.fog) {
        for (let ty = 0; ty < layers.size; ty++) {
          for (let tx = 0; tx < layers.size; tx++) {
            const shade = minimapShadeFor(
              deps.fog.isExplored(tx, ty),
              deps.fog.isVisible(tx, ty),
            );
            if (shade === MINIMAP_SHADE_BRIGHT) continue;
            backCtx.fillStyle =
              shade === MINIMAP_SHADE_UNEXPLORED
                ? "#0e1218"
                : "rgba(16, 22, 32, 0.50)";
            backCtx.fillRect(
              tx * pxPerTile,
              ty * pxPerTile,
              pxPerTile + 0.5,
              pxPerTile + 0.5,
            );
          }
        }
      }

      // 3. Resource node dots (gold, stone, food, etc.)
      if (deps.getResourceNodes) {
        const nodes = deps.getResourceNodes();
        for (const node of nodes) {
          const tx = Math.floor(node.x);
          const ty = Math.floor(node.y);
          if (deps.fog && !deps.fog.isExplored(tx, ty)) continue;
          const color = colorForResource(node.resourceCode);
          if (!color) continue;
          const isVis = !deps.fog || deps.fog.isVisible(tx, ty);
          backCtx.fillStyle = color;
          backCtx.globalAlpha = isVis ? 1.0 : 0.65;
          backCtx.fillRect(
            node.x * pxPerTile - 1,
            node.y * pxPerTile - 1,
            2,
            2,
          );
        }
        backCtx.globalAlpha = 1.0;
      }

      // 4. Buildings (own and enemy, including fog ghost memory)
      if (deps.getBuildings) {
        const buildings = deps.getBuildings();
        for (const b of buildings) {
          const cx = Math.floor(b.x + b.width / 2);
          const cy = Math.floor(b.y + b.height / 2);
          if (deps.fog && !deps.fog.isExplored(cx, cy)) continue;
          const isVis = !deps.fog || deps.fog.isVisible(cx, cy);
          const isOwn = deps.isOwnBuilding
            ? deps.isOwnBuilding(b.ownerId)
            : deps.isOwn
              ? deps.isOwn(b.eid)
              : true;
          const pColor = deps.getPlayerColor
            ? deps.getPlayerColor(b.ownerId)
            : undefined;
          if (pColor) {
            backCtx.fillStyle = isVis
              ? pColor
              : shade(parseInt(pColor.replace("#", ""), 16), 0.55);
          } else if (isOwn) {
            backCtx.fillStyle = OWN_BUILDING_HEX;
          } else {
            backCtx.fillStyle = isVis
              ? ENEMY_BUILDING_VISIBLE_HEX
              : ENEMY_BUILDING_GHOST_HEX;
          }
          const bw = Math.max(3, Math.round(b.width * pxPerTile));
          const bh = Math.max(3, Math.round(b.height * pxPerTile));
          backCtx.fillRect(
            Math.round(b.x * pxPerTile),
            Math.round(b.y * pxPerTile),
            bw,
            bh,
          );
        }
      }

      // 5. Unit dots
      const frame = deps.getFrame();
      if (frame && frame.count > 0) {
        for (let i = 0; i < frame.count; i++) {
          const eid = frame.eids[i]!;
          const x = frame.positions[i * 2]!;
          const y = frame.positions[i * 2 + 1]!;
          // Own Pops always dotted; enemy dots only on visible tiles
          // (SPEC §2.9).
          const own = deps.isOwn ? deps.isOwn(eid) : true;
          if (!own && !deps.fog?.isVisible(Math.floor(x), Math.floor(y))) {
            continue;
          }
          const selected = deps.isSelected(eid);
          const unitOwner = deps.getUnitOwner
            ? deps.getUnitOwner(eid)
            : own
              ? 0
              : 1;
          const pColor = deps.getPlayerColor
            ? deps.getPlayerColor(unitOwner)
            : undefined;
          backCtx.fillStyle = selected
            ? SELECTED_DOT_HEX
            : pColor
              ? pColor
              : own
                ? OWN_DOT_HEX
                : ENEMY_DOT_HEX;
          const dot = selected ? 3 : 2;
          backCtx.fillRect(
            x * pxPerTile - dot / 2,
            y * pxPerTile - dot / 2,
            dot,
            dot,
          );
        }
      }

      // 6. Blit backBuffer and draw live viewport quad
      updateViewport();
    },
  };
}
