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

const UNIT_DOT_HEX = "#6fa8ff";
const SELECTED_DOT_HEX = "#ffffff";

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
}

export interface MinimapHandle {
  /** Repaint dots + viewport quad over the cached terrain bake. */
  redraw(): void;
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

  // ---- Camera jump interaction ---------------------------------------------------
  let pointerDown = false;

  const jumpToEvent = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * layers.size;
    const y = ((event.clientY - rect.top) / rect.height) * layers.size;
    deps.setCenter(
      Math.min(layers.size, Math.max(0, x)),
      Math.min(layers.size, Math.max(0, y)),
    );
  };

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    pointerDown = true;
    canvas.setPointerCapture(event.pointerId);
    jumpToEvent(event);
  });
  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (pointerDown) jumpToEvent(event);
  });
  const release = (): void => {
    pointerDown = false;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  // ---- Per-redraw paint -----------------------------------------------------------

  const drawViewportQuad = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const corners = [
      deps.groundPointAt(0, 0),
      deps.groundPointAt(w, 0),
      deps.groundPointAt(w, h),
      deps.groundPointAt(0, h),
    ];
    ctx!.beginPath();
    let started = false;
    for (const corner of corners) {
      if (!corner) continue;
      const sx = corner.x * pxPerTile;
      const sy = corner.y * pxPerTile;
      if (!started) {
        ctx!.moveTo(sx, sy);
        started = true;
      } else {
        ctx!.lineTo(sx, sy);
      }
    }
    if (!started) return;
    ctx!.closePath();
    ctx!.strokeStyle = "rgba(255,255,255,0.85)";
    ctx!.lineWidth = 1;
    ctx!.stroke();
  };

  return {
    element: canvas,
    redraw(): void {
      ctx.drawImage(bake, 0, 0);

      // Fog tri-state overlay — pure projection of the planes.
      if (deps.fog) {
        for (let ty = 0; ty < layers.size; ty++) {
          for (let tx = 0; tx < layers.size; tx++) {
            const shade = minimapShadeFor(
              deps.fog.isExplored(tx, ty),
              deps.fog.isVisible(tx, ty),
            );
            if (shade === MINIMAP_SHADE_BRIGHT) continue;
            ctx.fillStyle =
              shade === MINIMAP_SHADE_UNEXPLORED
                ? "#000000"
                : "rgba(0, 0, 0, 0.45)";
            ctx.fillRect(
              tx * pxPerTile,
              ty * pxPerTile,
              pxPerTile + 0.5,
              pxPerTile + 0.5,
            );
          }
        }
      }

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
          ctx.fillStyle = selected ? SELECTED_DOT_HEX : UNIT_DOT_HEX;
          const dot = selected ? 3 : 2;
          ctx.fillRect(
            x * pxPerTile - dot / 2,
            y * pxPerTile - dot / 2,
            dot,
            dot,
          );
        }
      }

      drawViewportQuad();
    },
  };
}
