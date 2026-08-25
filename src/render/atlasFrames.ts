/**
 * Billboard atlas frame math — M1-T7.
 *
 * Deliberately THREE-FREE and DOM-free: this module holds every piece of
 * the billboard pipeline that must be shared across three very different
 * hosts — the bake tool (node), the runtime shader feeder (browser), and
 * the headless perf tests (vitest, which bans three imports). Layout
 * planning, uv-rect lookup, quantized playback frame selection, view-
 * direction picking, and the per-frame attribute write all live here so
 * there is exactly one definition of each contract.
 *
 * Frame addressing (pinned by planAtlasLayout + parseAtlasIndex):
 *   absoluteFrame = action.baseFrame + yawIndex * action.frameCount + f
 * Cells are assigned in ascending (action name → yaw → frame) order,
 * left-to-right / top-to-bottom within a 2048² page of 128 px cells.
 *
 * Direction convention (must match tools/atlas-bake): the bake renders
 * yaw k by rotating the rig +k·(τ/8) about Y while a camera sits at
 * azimuth 0 looking along −Z. At runtime `directionIndexFor` derives
 * the same k from the unit heading and the live camera azimuth.
 */

/** One baked action clip as planned on the atlas. */
export interface AtlasActionMeta {
  readonly name: string;
  readonly frameCount: number;
  /** Playback frames per second of the source clip. */
  readonly fps: number;
}

export interface PlannedAtlasAction {
  readonly name: string;
  /** First absolute frame slot of this action's yaw 0 block. */
  readonly baseFrame: number;
  readonly frameCount: number;
  readonly fps: number;
  /** Loop length in seconds = frameCount / fps. */
  readonly duration: number;
  /** Atlas page holding this action's cells. */
  readonly page: number;
}

export interface AtlasLayout {
  readonly frameSize: number;
  readonly pageSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellsPerPage: number;
  readonly pageCount: number;
  readonly yawCount: number;
  readonly totalFrames: number;
  readonly actions: readonly PlannedAtlasAction[];
  /**
   * Per absolute frame: packed u0, v0, du, dv (v measured from the TOP
   * of the image, matching GL texture space after the standard flip).
   */
  readonly rects: Float32Array;
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Assign every (action → yaw → frame) triple to a grid cell and derive
 * its uv rect. Deterministic given identical metas: actions are sorted
 * by name first, so JSON key order upstream cannot shift cells.
 */
export function planAtlasLayout(
  metas: readonly AtlasActionMeta[],
  yawCount: number,
  frameSize: number,
  pageSize: number,
): AtlasLayout {
  if (yawCount <= 0) throw new Error("yawCount must be positive");
  if (frameSize <= 0 || pageSize < frameSize)
    throw new Error("invalid frame/page size");
  const columns = Math.floor(pageSize / frameSize);
  const rows = columns; // square pages, square cells
  const cellsPerPage = columns * rows;

  const sorted = [...metas].sort((a, b) =>
    a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
  );
  const seen = new Set<string>();
  let cell = 0;
  const actions: PlannedAtlasAction[] = [];
  for (const meta of sorted) {
    if (seen.has(meta.name)) throw new Error(`duplicate action ${meta.name}`);
    seen.add(meta.name);
    if (meta.frameCount <= 0) throw new Error(`empty action ${meta.name}`);
    const baseFrame = cell;
    cell += meta.frameCount * yawCount;
    if (
      Math.floor((cell - 1) / cellsPerPage) !==
      Math.floor(baseFrame / cellsPerPage)
    ) {
      throw new Error(
        `action ${meta.name} would straddle a page boundary; raise pageSize`,
      );
    }
    actions.push({
      name: meta.name,
      baseFrame,
      frameCount: meta.frameCount,
      fps: meta.fps,
      duration: meta.frameCount / meta.fps,
      page: Math.floor(baseFrame / cellsPerPage),
    });
  }

  const totalFrames = cell;
  const pageCount = Math.ceil(totalFrames / cellsPerPage);
  const rects = new Float32Array(totalFrames * 4);
  const stepU = frameSize / pageSize;
  const stepV = frameSize / pageSize;
  for (let abs = 0; abs < totalFrames; abs++) {
    const col = abs % columns;
    const row = Math.floor(abs / columns) % rows;
    const o = abs * 4;
    rects[o] = col * stepU;
    rects[o + 1] = row * stepV;
    rects[o + 2] = stepU;
    rects[o + 3] = stepV;
  }

  return {
    frameSize,
    pageSize,
    columns,
    rows,
    cellsPerPage,
    pageCount,
    yawCount,
    totalFrames,
    actions,
    rects,
  };
}

function findAction(
  layout: AtlasLayout,
  actionName: string,
): PlannedAtlasAction {
  const action = layout.actions.find((a) => a.name === actionName);
  if (!action) {
    throw new Error(
      `action "${actionName}" not in atlas (have: ${layout.actions
        .map((a) => a.name)
        .join(", ")})`,
    );
  }
  return action;
}

/**
 * Absolute frame slot for one (action, yaw, frame) triple — the same
 * arithmetic the vertex shader performs with texture lookups.
 */
export function absoluteFrameOf(
  layout: AtlasLayout,
  actionName: string,
  yaw: number,
  frame: number,
): number {
  const action = findAction(layout, actionName);
  if (yaw < 0 || yaw >= layout.yawCount)
    throw new Error(`yaw ${String(yaw)} out of range`);
  if (frame < 0 || frame >= action.frameCount)
    throw new Error(`frame ${String(frame)} out of range`);
  return action.baseFrame + yaw * action.frameCount + frame;
}

/** Pure CPU mirror of the shader's rect lookup. */
export function uvRectFor(
  layout: AtlasLayout,
  actionName: string,
  yaw: number,
  frame: number,
): UvRect {
  const abs = absoluteFrameOf(layout, actionName, yaw, frame);
  const o = abs * 4;
  return {
    u0: layout.rects[o]!,
    v0: layout.rects[o + 1]!,
    u1: layout.rects[o]! + layout.rects[o + 2]!,
    v1: layout.rects[o + 1]! + layout.rects[o + 3]!,
  };
}

/**
 * Quantized playback frame for elapsed clip time `timeSec`. Time is
 * snapped to the near-band quantum (SPEC §7: 15 fps) BEFORE dividing
 * the loop, so all units of a type flip frames on the same ticks —
 * this is what keeps playback cost O(1) per type instead of per
 * instance. The identical formula runs in the vertex shader.
 */
export function frameAtTime(
  frameCount: number,
  durationSec: number,
  timeSec: number,
  quantumFps: number,
): number {
  const tq = Math.floor(Math.max(timeSec, 0) * quantumFps) / quantumFps;
  const wrapped = tq - Math.floor(tq / durationSec) * durationSec;
  const local = Math.floor((wrapped / durationSec) * frameCount);
  return Math.min(frameCount - 1, Math.max(0, local));
}

function wrapTau(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

/**
 * Which baked yaw shows a unit with sim `headingRad` when viewed from
 * a camera at horizontal azimuth `camAzimuthRad`.
 *
 * Convention (mirrors the bake turntable): camAzimuth β places the eye
 * at unit + (sinβ, cosβ); screen-right is C = (cosβ, −sinβ) in (x, z).
 * The viewing angle s = atan2(F·C, F·T) with F the unit facing and T
 * the toward-camera direction reproduces exactly the angle the rig was
 * rotated by for cell k, so k = round(s / (τ/yawCount)) mod yawCount.
 */
export function directionIndexFor(
  headingRad: number,
  camAzimuthRad: number,
  yawCount: number,
): number {
  const h = headingRad + camAzimuthRad;
  // F = (cos h, sin h); T = (sinβ, cosβ); C = (cosβ, −sinβ):
  //   F·T = cos(h+β−β)... reduced algebra below to one trig pair:
  //   F·C = cos(h+β), F·T = sin(h+β)  (verified in billboard.test.ts)
  const s = wrapTau(Math.PI / 2 - h);
  const step = (Math.PI * 2) / yawCount;
  return Math.round(s / step) % yawCount;
}

/** Destination typed arrays backing the instanced sprite attributes. */
export interface SpriteAttributeArrays {
  /** xyz ground anchors, capacity ≥ maxInstances × 3. */
  origins: Float32Array;
  /** Baked yaw index per instance. */
  directions: Float32Array;
  /** rgb team tint per instance. */
  tints: Float32Array;
}

/** SoA sample produced by render/mirror.sampleMirror. */
export interface SpriteSampleInput {
  positions: Float32Array;
  headings: Float32Array;
  count: number;
}

/**
 * Everything the attribute fill needs about one unit type's current
 * clip — resolved once per type; the vertex shader performs playback
 * itself from uTime, so no per-instance or per-type animation math
 * runs on the CPU at all.
 */
export interface SpritePlaybackContext {
  readonly yawCount: number;
}

/**
 * Fill the instanced attributes for one unit type for this rendered
 * frame. Per-instance work is limited to cheap scalar stores plus one
 * atan2/round for the view-direction pick; playback evaluation lives
 * ENTIRELY in the vertex shader — asserted by the perf gate in
 * tests/perf/billboard.test.ts.
 *
 * `heights[i]` is the caller's terrain height under sample i; the
 * sprite anchors its feet there.
 */
export function writeSpriteAttributes(
  out: SpriteAttributeArrays,
  samples: SpriteSampleInput,
  heights: Float32Array,
  context: SpritePlaybackContext,
  camAzimuthRad: number,
  tintR: number,
  tintG: number,
  tintB: number,
  maxInstances: number,
): number {
  const count = Math.min(samples.count, maxInstances);
  for (let i = 0; i < count; i++) {
    const o3 = i * 3;
    out.origins[o3] = samples.positions[i * 2]!;
    out.origins[o3 + 1] = heights[i]!;
    out.origins[o3 + 2] = samples.positions[i * 2 + 1]!;
    out.directions[i] = directionIndexFor(
      samples.headings[i]!,
      camAzimuthRad,
      context.yawCount,
    );
    out.tints[o3] = tintR;
    out.tints[o3 + 1] = tintG;
    out.tints[o3 + 2] = tintB;
  }
  return count;
}

/** SPEC §7 near-band clip quantum. */
export const PLAYBACK_QUANTUM_FPS = 15;

// ---- LOD zoom bands (SPEC §7 / M5-T4) -----------------------------------------

/**
 * Far-band trigger: once the camera is ≥ this fraction of the way from
 * fully-zoomed-in to fully-zoomed-out, sprite playback throttles to the
 * far-band rate below (SPEC §7: "far band >60% zoom-out").
 */
export const FAR_BAND_ZOOM_OUT_FRACTION = 0.6;

/**
 * Far-band playback quantum: half the near-band rate — motion still
 * reads at map scale, but frame flips (and their texture fetches)
 * halve exactly when individual sprites are too small to show them.
 */
export const FAR_BAND_QUANTUM_FPS = PLAYBACK_QUANTUM_FPS / 2;

/**
 * Zoom-derived playback quantum for the billboard shader's time
 * quantization (SPEC §7 LOD bands): `viewHeight` between the camera's
 * min/near and max/far frustum heights maps linearly onto zoom-out
 * [0,1]; past {@link FAR_BAND_ZOOM_OUT_FRACTION} the rate drops from
 * the near-band 15 fps to the far-band 7.5 fps. Pure + three-free so
 * the shader feeder and this suite share one definition of the bands.
 */
export function playbackRateForZoom(
  viewHeight: number,
  minHeight: number,
  maxHeight: number,
): number {
  const span = maxHeight - minHeight;
  if (!(span > 0)) return PLAYBACK_QUANTUM_FPS;
  const zoomOut01 = (viewHeight - minHeight) / span;
  return zoomOut01 >= FAR_BAND_ZOOM_OUT_FRACTION
    ? FAR_BAND_QUANTUM_FPS
    : PLAYBACK_QUANTUM_FPS;
}

// ---- Runtime atlas index (wire format shared with tools/atlas-bake) ----------

/** One action row as serialized by the bake tool. */
interface AtlasActionJson {
  name: string;
  slot: number;
  baseFrame: number;
  frameCount: number;
  fps: number;
  duration: number;
  page: number;
}

/** Wire format of `<unitDefId>.frames.json` emitted by the bake tool. */
export interface AtlasIndexJson {
  id: string;
  frameSize: number;
  pageSize: number;
  columns: number;
  rows: number;
  pageCount: number;
  yawCount: number;
  quantumFps: number;
  totalFrames: number;
  actions: AtlasActionJson[];
  /** Image-space [u0, v0, du, dv] per absolute frame (v from TOP). */
  rects: number[][];
}

export interface ParsedAtlasIndex {
  readonly id: string;
  readonly frameSize: number;
  readonly pageSize: number;
  readonly columns: number;
  readonly pageCount: number;
  readonly yawCount: number;
  readonly totalFrames: number;
  readonly actions: readonly (AtlasActionJson & { slot: number })[];
  /**
   * GPU-ready RGBA32F texel per absolute frame: u0, v0, du, dv — with
   * v CONVERTED to GL texture space (three uploads PNGs flipY, so
   * vGl = 1 − imageRow/pageSize; done once here, never in the loop).
   */
  readonly rectTexels: Float32Array;
  /** RGBA32F texel per action slot: baseFrame, frameCount, duration, yawCount. */
  readonly actionTexels: Float32Array;
}

function requireNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`atlas index field "${key}" must be a finite number`);
  }
  return value;
}

/**
 * Validate the bake tool's JSON and precompute the two float textures
 * the unit-sprite shader samples (frame rects + action metadata).
 * Loud failures per the SPEC load discipline.
 */
export function parseAtlasIndex(json: unknown): ParsedAtlasIndex {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("atlas index JSON must be an object");
  }
  const source = json as Record<string, unknown>;
  const id = source.id;
  if (typeof id !== "string" || !id.startsWith("atlas/")) {
    throw new Error('atlas index "id" must start with "atlas/"');
  }
  for (const key of [
    "frameSize",
    "pageSize",
    "columns",
    "rows",
    "pageCount",
    "yawCount",
    "quantumFps",
    "totalFrames",
  ]) {
    requireNumber(source, key);
  }
  const rawActions = source.actions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    throw new Error("atlas index needs a non-empty actions array");
  }
  const actions = rawActions.map((entry, slot) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`action ${String(slot)} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string") {
      throw new Error(`action ${String(slot)} lacks a name`);
    }
    return { ...(record as unknown as AtlasActionJson), slot };
  });
  for (let i = 1; i < actions.length; i++) {
    const prev = actions[i - 1]!;
    const curr = actions[i]!;
    const yawCount = source.yawCount as number;
    if (curr.baseFrame !== prev.baseFrame + prev.frameCount * yawCount) {
      throw new Error(
        `action "${curr.name}" baseFrame is not contiguous after "${prev.name}"`,
      );
    }
  }
  const totalFrames = source.totalFrames as number;
  const rawRects = source.rects;
  if (
    !Array.isArray(rawRects) ||
    rawRects.length !== totalFrames ||
    rawRects.some((r) => !Array.isArray(r) || r.length !== 4)
  ) {
    throw new Error("rects must hold four numbers per absolute frame");
  }

  // JSON rects are IMAGE space (v measured from the page's top row);
  // the shader samples GL texture space, where three.js's flipY PNG
  // upload puts image vImg at vGl = 1 − vImg. Convert once here.
  const rectTexels = new Float32Array(totalFrames * 4);
  for (let abs = 0; abs < totalFrames; abs++) {
    const [u0, vImg0, du, dv] = rawRects[abs]! as number[];
    const o = abs * 4;
    rectTexels[o] = u0!;
    rectTexels[o + 1] = 1 - vImg0! - dv!; // GL bottom edge of the cell
    rectTexels[o + 2] = du!;
    rectTexels[o + 3] = dv!;
  }

  const actionTexels = new Float32Array(actions.length * 4);
  for (const action of actions) {
    actionTexels[action.slot * 4] = action.baseFrame;
    actionTexels[action.slot * 4 + 1] = action.frameCount;
    actionTexels[action.slot * 4 + 2] = action.duration;
    actionTexels[action.slot * 4 + 3] = source.yawCount as number;
  }

  return {
    id,
    frameSize: source.frameSize as number,
    pageSize: source.pageSize as number,
    columns: source.columns as number,
    pageCount: source.pageCount as number,
    yawCount: source.yawCount as number,
    totalFrames,
    actions,
    rectTexels,
    actionTexels,
  };
}

/** Slot index of an action by name (for the uActionSlot uniform). */
export function atlasActionSlot(
  atlas: ParsedAtlasIndex,
  name: string,
): { slot: number; frameCount: number } {
  const found = atlas.actions.find((a) => a.name === name);
  if (!found) {
    throw new Error(
      `atlas ${atlas.id} has no action "${name}" (has: ${atlas.actions
        .map((a) => a.name)
        .join(", ")})`,
    );
  }
  return { slot: found.slot, frameCount: found.frameCount };
}
