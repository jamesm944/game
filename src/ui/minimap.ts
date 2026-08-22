/**
 * Minimap — SPEC §2.13 prototype-validated command layer (M1-T8).
 *
 * Bottom-right canvas: the terrain layers are mini-rendered ONCE into
 * an offscreen buffer (per-tile palette + elevation shading), then each
 * redraw blits that buffer, paints unit dots from the latest post-step
 * snapshot (~10 Hz is plenty), and strokes the camera viewport quad
 * (ground-plane projections of the four screen corners — a trapezoid
 * under the pitched orthographic rig). Click/drag anywhere jumps the
 * camera via `setCenter`. Fog stays full-bright until the fog ticket.
 *
 * All DOM/canvas access lives inside the factory; importing this file
 * headlessly is safe.
 */

import type { WorldLayers } from "../sim/world/layers";
import type { SelectionFrame } from "./selection";

/** CSS size of the square minimap in pixels (validated prototype feel). */
const MINIMAP_CSS_PX = 176;
/** Redraw cadence handled by the caller (~10 Hz). */
export const MINIMAP_REDRAW_MS = 100;

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

export interface MinimapDeps {
  readonly layers: WorldLayers;
  /** Latest post-step snapshot for unit dots (null before first step). */
  getFrame(): SelectionFrame | null;
  /** eid → selected test (white highlight dots). */
  isSelected(eid: number): boolean;
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

      const frame = deps.getFrame();
      if (frame && frame.count > 0) {
        for (let i = 0; i < frame.count; i++) {
          const selected = deps.isSelected(frame.eids[i]!);
          ctx.fillStyle = selected ? SELECTED_DOT_HEX : UNIT_DOT_HEX;
          const dot = selected ? 3 : 2;
          ctx.fillRect(
            frame.positions[i * 2]! * pxPerTile - dot / 2,
            frame.positions[i * 2 + 1]! * pxPerTile - dot / 2,
            dot,
            dot,
          );
        }
      }

      drawViewportQuad();
    },
  };
}
