/**
 * RTS camera — M1-T6.
 *
 * PROJECTION CHOICE — orthographic. The game reads the battlefield as a
 * flat tactical plane (SPEC pillars: AoE-style top-down command);
 * orthographic keeps unit/building apparent size identical across the
 * whole viewport, which (a) preserves the instanced-billboard budget of
 * SPEC §7 across every zoom band, (b) makes the future screen↔world
 * picking math (§2.13 ray-to-ground-plane + spatial hash) strictly
 * linear, and (c) shows elevation terraces cleanly instead of
 * foreshortening them. Perspective buys nothing for a god-view RTS.
 *
 * Controls: WASD/arrow pan, screen-edge scroll, wheel zoom (clamped,
 * toward cursor), plus setCenter(x, y) as the minimap-jump hook for the
 * upcoming minimap ticket. World mapping everywhere in render/: sim tile
 * (x, y) → three.js (x, z = y), ground at Y ≈ 0, north = −Z = up.
 */

import {
  MathUtils,
  OrthographicCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from "three";

/** Vertical world extent at default zoom (map is 120 tiles wide). */
const DEFAULT_VIEW_HEIGHT = 90;
/**
 * Zoom clamp (exported for the §7 LOD band math): viewHeight between
 * MIN and MAX maps linearly onto zoom-out [0,1]; past the far-band
 * fraction sprite playback throttles to 7.5 fps.
 */
export const MIN_VIEW_HEIGHT = 24;
export const MAX_VIEW_HEIGHT = 240;
/** Screen-heights panned per second while a pan input is held. */
const PAN_SPEED_PER_SECOND = 1.1;
/** Pixels from the window edge where edge-scroll engages. */
const EDGE_MARGIN_PX = 28;
/** Camera pitch above the ground plane (degrees from horizon). */
const PITCH_DEG = 55;
/** Eye standoff distance; cosmetic under orthographic projection. */
const EYE_DISTANCE = 160;

export interface RtsCameraOptions {
  /** Map edge length in tiles; pans/center clamp to these bounds. */
  readonly mapSize?: number | undefined;
}

export class RtsCamera {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, EYE_DISTANCE * 4);

  /** Current view height in world units (the zoom value). */
  get viewHeight(): number {
    return this.#viewHeight;
  }

  /** Current camera look target in world coordinates. */
  get center(): { x: number; y: number } {
    return { x: this.#targetX, y: this.#targetZ };
  }

  /**
   * Horizontal camera azimuth (M1-T7): atan2 of the eye offset from
   * the look target in (x, z) — the value billboard direction picking
   * needs to choose each unit's baked yaw cell. Constant under this
   * fixed rig, computed from live state so a future rotating rig
   * keeps units honest.
   */
  get azimuthRad(): number {
    return Math.atan2(
      this.camera.position.x - this.#targetX,
      this.camera.position.z - this.#targetZ,
    );
  }

  #viewHeight = DEFAULT_VIEW_HEIGHT;
  /** Aspect ratio width/height of the attached viewport. */
  #aspect = 1;
  #targetX: number;
  #targetZ: number;
  #mapSize: number;
  #keys = new Set<string>();
  /** Last known pointer position in client pixels (-1 when off-window). */
  #pointerX = -1;
  #pointerY = -1;

  // Reusable scratch — the frame loop must not allocate.
  readonly #raycaster = new Raycaster();
  readonly #groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  readonly #ndc = new Vector2();
  readonly #groundHit = new Vector3();

  constructor(options: RtsCameraOptions = {}) {
    this.#mapSize = options.mapSize ?? 120;
    // Default focus: map center.
    const c = this.#mapSize / 2;
    this.#targetX = c;
    this.#targetZ = c;
    this.#applyTransform();
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("pointermove", this.#onPointerMove);
    window.addEventListener("blur", this.#onBlur);
    window.addEventListener("wheel", this.#onWheel, { passive: false });
  }

  dispose(): void {
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("pointermove", this.#onPointerMove);
    window.removeEventListener("blur", this.#onBlur);
    window.removeEventListener("wheel", this.#onWheel);
  }

  /** Resize handling: call whenever the canvas changes size. */
  resize(widthPx: number, heightPx: number): void {
    this.#aspect = widthPx / Math.max(heightPx, 1);
    this.#applyFrustum();
  }

  /**
   * Minimap-jump hook (upcoming minimap ticket): teleport the view so
   * sim-coordinate (x, y) sits at screen center.
   */
  setCenter(x: number, y: number): void {
    this.#targetX = x;
    this.#targetZ = y;
    this.#clampTarget();
    this.#applyTransform();
  }

  /** Set view height (zoom) directly, clamped to [MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT]. */
  setViewHeight(height: number): void {
    this.#viewHeight = MathUtils.clamp(
      height,
      MIN_VIEW_HEIGHT,
      MAX_VIEW_HEIGHT,
    );
    this.#applyFrustum();
    this.#applyTransform();
  }

  /** Advance panning for one rendered frame. */
  update(dtSeconds: number): void {
    let dx = 0;
    let dz = 0;
    if (this.#held("KeyW") || this.#held("ArrowUp")) dz -= 1;
    if (this.#held("KeyS") || this.#held("ArrowDown")) dz += 1;
    if (this.#held("KeyA") || this.#held("ArrowLeft")) dx -= 1;
    if (this.#held("KeyD") || this.#held("ArrowRight")) dx += 1;

    // Edge scroll: pointer parked in the border band nudges the same way.
    if (this.#pointerX >= 0) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (this.#pointerX <= EDGE_MARGIN_PX) dx -= 1;
      else if (this.#pointerX >= w - EDGE_MARGIN_PX) dx += 1;
      if (this.#pointerY <= EDGE_MARGIN_PX) dz -= 1;
      else if (this.#pointerY >= h - EDGE_MARGIN_PX) dz += 1;
    }

    const lengthSq = dx * dx + dz * dz;
    if (lengthSq > 0) {
      const scale =
        (PAN_SPEED_PER_SECOND * this.#viewHeight * dtSeconds) /
        Math.sqrt(lengthSq);
      this.#targetX += dx * scale;
      this.#targetZ += dz * scale;
      this.#clampTarget();
      this.#applyTransform();
    }
  }

  #held(code: string): boolean {
    return this.#keys.has(code);
  }

  #clampTarget(): void {
    this.#targetX = MathUtils.clamp(this.#targetX, 0, this.#mapSize);
    this.#targetZ = MathUtils.clamp(this.#targetZ, 0, this.#mapSize);
  }

  #applyFrustum(): void {
    const halfH = this.#viewHeight / 2;
    const halfW = halfH * this.#aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  #applyTransform(): void {
    // Fixed pitch/yaw rig: eye stands south of the target and above it.
    const pitch = MathUtils.degToRad(PITCH_DEG);
    const back = Math.cos(pitch) * EYE_DISTANCE;
    const up = Math.sin(pitch) * EYE_DISTANCE;
    this.camera.position.set(this.#targetX, up, this.#targetZ + back);
    this.camera.lookAt(this.#targetX, 0, this.#targetZ);
  }

  /**
   * World-space ground intersection under a client pixel, or null when
   * the ray misses the ground plane. Shared by zoom-to-cursor here and
   * reusable for the §2.13 picking pass later.
   */
  groundPointAt(clientX: number, clientY: number): Vector3 | null {
    const ndcX = (clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(clientY / window.innerHeight) * 2 + 1;
    this.#ndc.set(ndcX, ndcY);
    this.#raycaster.setFromCamera(this.#ndc, this.camera);
    return (
      this.#raycaster.ray
        .intersectPlane(this.#groundPlane, this.#groundHit)
        ?.clone() ?? null
    );
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    this.#keys.add(event.code);
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    this.#keys.delete(event.code);
  };

  #onPointerMove = (event: PointerEvent): void => {
    this.#pointerX = event.clientX;
    this.#pointerY = event.clientY;
  };

  #onBlur = (): void => {
    // Tab switches must not leave keys latched down.
    this.#keys.clear();
    this.#pointerX = -1;
    this.#pointerY = -1;
  };

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Ground point under the cursor before zooming…
    const anchor = this.groundPointAt(event.clientX, event.clientY);
    const factor = Math.exp(event.deltaY * 0.0012);
    this.#viewHeight = MathUtils.clamp(
      this.#viewHeight * factor,
      MIN_VIEW_HEIGHT,
      MAX_VIEW_HEIGHT,
    );
    this.#applyFrustum();
    // …then slide the target so that same point stays under the cursor.
    if (anchor) {
      const after = this.groundPointAt(event.clientX, event.clientY);
      if (after) {
        this.#targetX += anchor.x - after.x;
        this.#targetZ += anchor.z - after.z;
        this.#clampTarget();
      }
    }
    this.#applyTransform();
  };
}
