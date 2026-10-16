/**
 * Double-buffered render mirror — SPEC §2.1 ("render reads and
 * interpolates, writes nothing back") / §2.10 ("ambient loops … reading
 * the double-buffered mirror").
 *
 * Two SoA buffers hold the last two post-step snapshots produced by
 * `sim/mirror.captureSimSnapshot`: A is the newest (tickA), B the
 * previous (tickB). `sampleMirror` lerps position linearly and heading
 * along the shortest arc so units never spin the long way round across
 * a tick boundary.
 *
 * Deliberately THREE-FREE: this module is plain typed-array arithmetic,
 * which keeps it importable (and perf-testable) headlessly in node —
 * the seam rule bans sim→render imports, not node→render ones, but a
 * three-free mirror means the hot path has zero DOM coupling at all.
 */

import type { SimSnapshotFrame } from "../sim/mirror";
import {
  minuteOfDay,
  DEFAULT_LIFECYCLE_CONFIG,
} from "../sim/systems/lifecycle";

/** One SoA buffer of unit state, indexed by ascending-eid rank. */
export interface MirrorBuffer {
  tick: number;
  count: number;
  // Arrays are mirror-owned and grow in place on push; mutable so
  // pushFrame can swap/grow them without reallocating the buffer object.
  eids: Int32Array;
  positions: Float32Array;
  headings: Float32Array;
  /** Health 0..1 per rank (M2-T6 overlay feed). */
  hpFractions: Float32Array;
  defCodes: Uint8Array;
  activityCodes: Uint8Array;
  ownerIds: Uint8Array;
}

export interface RenderMirror {
  /** Newest buffer's tick (-1 before the first push). */
  tickA: number;
  /** Previous buffer's tick (-1 until two frames are held). */
  tickB: number;
  readonly bufferA: MirrorBuffer;
  readonly bufferB: MirrorBuffer;
}

/** Destination scratch for an allocation-free sample pass. */
export interface MirrorSampleOut {
  /** Packed x,y pairs; written up to returned count × 2. */
  positions: Float32Array;
  /** Facing radians; written up to returned count. */
  headings: Float32Array;
  /** Health 0..1; written up to returned count (M2-T6 overlays). */
  hpFractions: Float32Array;
  /** Unit def codes; written up to returned count. */
  defCodes?: Uint8Array | undefined;
  /** Unit activity codes; written up to returned count. */
  activityCodes?: Uint8Array | undefined;
  /** Unit owner ids; written up to returned count. */
  ownerIds?: Uint8Array | undefined;
  /**
   * RGB lighting tint [r,g,b] ∈ [0,1]³ mapped from the newest buffer's
   * sim-clock minute of day (M3-T6, §2.4 "visual = lighting tint on
   * render mirror only"). Optional: callers that provide the buffer get
   * it filled each sample; the sim stays numeric and render-only.
   */
  lightTint?: Float32Array | undefined;
}

const TICK_UNSET = -1;

/**
 * Day/night lighting keyframes (M3-T6): sim-clock minute → [r,g,b]
 * ambient/sky tint, linearly interpolated between stops and wrapping at
 * midnight. RENDER-SIDE ONLY — the sim tracks integer minutes and never
 * sees a color. Stops: deep night → pre-dawn → warm sunrise → full day
 * → golden sunset → violet dusk → back to night.
 */
const LIGHTING_KEYFRAMES: readonly {
  readonly minute: number;
  readonly tint: readonly [number, number, number];
}[] = [
  { minute: 0, tint: [0.38, 0.44, 0.65] },
  { minute: 240, tint: [0.38, 0.44, 0.65] },
  { minute: 300, tint: [0.65, 0.56, 0.6] },
  { minute: 360, tint: [1.0, 0.85, 0.68] },
  { minute: 480, tint: [1.0, 1.0, 1.0] },
  { minute: 1080, tint: [1.0, 1.0, 1.0] },
  { minute: 1140, tint: [1.0, 0.78, 0.58] },
  { minute: 1260, tint: [0.55, 0.48, 0.65] },
  { minute: 1320, tint: [0.38, 0.44, 0.65] },
  { minute: 1440, tint: [0.38, 0.44, 0.65] },
];

/**
 * Lighting tint for a sim-clock minute (0–1439, clamped): pure lerp
 * across {@link LIGHTING_KEYFRAMES}. Exported for headless tests of the
 * render-only table.
 */
export function lightingTintAtMinute(minute: number, out: Float32Array): void {
  const m = Math.min(Math.max(Math.floor(minute), 0), 1439);
  let lo = LIGHTING_KEYFRAMES[0]!;
  let hi = LIGHTING_KEYFRAMES[LIGHTING_KEYFRAMES.length - 1]!;
  for (let i = 0; i < LIGHTING_KEYFRAMES.length - 1; i++) {
    const a = LIGHTING_KEYFRAMES[i]!;
    const b = LIGHTING_KEYFRAMES[i + 1]!;
    if (m >= a.minute && m <= b.minute) {
      lo = a;
      hi = b;
      break;
    }
  }
  const span = Math.max(1, hi.minute - lo.minute);
  const t = Math.min(1, Math.max(0, (m - lo.minute) / span));
  out[0] = lo.tint[0] + (hi.tint[0] - lo.tint[0]) * t;
  out[1] = lo.tint[1] + (hi.tint[1] - lo.tint[1]) * t;
  out[2] = lo.tint[2] + (hi.tint[2] - lo.tint[2]) * t;
}

/** Convenience wrapper mapping a world tick through the §2.4 clock. */
export function lightingTintAtTick(tick: number, out: Float32Array): void {
  lightingTintAtMinute(minuteOfDay(tick, DEFAULT_LIFECYCLE_CONFIG), out);
}

function ensureF32(array: Float32Array, needed: number): Float32Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 256);
  while (capacity < needed) capacity *= 2;
  const grown = new Float32Array(capacity);
  grown.set(array);
  return grown;
}

function ensureI32(array: Int32Array, needed: number): Int32Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 256);
  while (capacity < needed) capacity *= 2;
  const grown = new Int32Array(capacity);
  grown.set(array);
  return grown;
}

function ensureU8(array: Uint8Array, needed: number): Uint8Array {
  if (array.length >= needed) return array;
  let capacity = Math.max(array.length, 256);
  while (capacity < needed) capacity *= 2;
  const grown = new Uint8Array(capacity);
  grown.set(array);
  return grown;
}

function emptyBuffer(): MirrorBuffer {
  return {
    tick: TICK_UNSET,
    count: 0,
    eids: new Int32Array(0),
    positions: new Float32Array(0),
    headings: new Float32Array(0),
    hpFractions: new Float32Array(0),
    defCodes: new Uint8Array(0),
    activityCodes: new Uint8Array(0),
    ownerIds: new Uint8Array(0),
  };
}

export function createRenderMirror(): RenderMirror {
  return {
    tickA: TICK_UNSET,
    tickB: TICK_UNSET,
    bufferA: emptyBuffer(),
    bufferB: emptyBuffer(),
  };
}

/** Wrap any angle into [-π, π). */
function wrapPi(angle: number): number {
  const tau = Math.PI * 2;
  return ((((angle + Math.PI) % tau) + tau) % tau) - Math.PI;
}

/**
 * Push a freshly captured frame: B ← A, A ← frame. Each buffer owns its
 * storage exclusively (memcpy, never shared references), so producers
 * may reuse one staging frame across every capture.
 */
export function pushFrame(mirror: RenderMirror, frame: SimSnapshotFrame): void {
  const a = mirror.bufferA;
  const b = mirror.bufferB;

  // Retire A into B: copy into B's OWN grown arrays — assigning the
  // array objects themselves would alias whenever A skips regrowth.
  b.eids = ensureI32(b.eids, Math.max(a.count, 1));
  b.positions = ensureF32(b.positions, Math.max(a.count * 2, 2));
  b.headings = ensureF32(b.headings, Math.max(a.count, 1));
  b.hpFractions = ensureF32(b.hpFractions, Math.max(a.count, 1));
  b.eids.set(a.eids.subarray(0, a.count));
  b.positions.set(a.positions.subarray(0, a.count * 2));
  b.headings.set(a.headings.subarray(0, a.count));
  b.hpFractions.set(a.hpFractions.subarray(0, a.count));
  if (frame.defCodes) {
    b.defCodes = ensureU8(b.defCodes, Math.max(a.count, 1));
    b.defCodes.set(a.defCodes.subarray(0, a.count));
  }
  if (frame.activityCodes) {
    b.activityCodes = ensureU8(b.activityCodes, Math.max(a.count, 1));
    b.activityCodes.set(a.activityCodes.subarray(0, a.count));
  }
  if (frame.ownerIds) {
    b.ownerIds = ensureU8(b.ownerIds, Math.max(a.count, 1));
    b.ownerIds.set(a.ownerIds.subarray(0, a.count));
  }
  b.tick = a.tick;
  b.count = a.count;

  // Refill A from the fresh frame.
  a.eids = ensureI32(a.eids, Math.max(frame.count, 1));
  a.positions = ensureF32(a.positions, Math.max(frame.count * 2, 2));
  a.headings = ensureF32(a.headings, Math.max(frame.count, 1));
  a.hpFractions = ensureF32(a.hpFractions, Math.max(frame.count, 1));
  a.eids.set(frame.eids.subarray(0, frame.count));
  a.positions.set(frame.positions.subarray(0, frame.count * 2));
  a.headings.set(frame.headings.subarray(0, frame.count));
  a.hpFractions.set(frame.hpFractions.subarray(0, frame.count));
  if (frame.defCodes) {
    a.defCodes = ensureU8(a.defCodes, Math.max(frame.count, 1));
    a.defCodes.set(frame.defCodes.subarray(0, frame.count));
  }
  if (frame.activityCodes) {
    a.activityCodes = ensureU8(a.activityCodes, Math.max(frame.count, 1));
    a.activityCodes.set(frame.activityCodes.subarray(0, frame.count));
  }
  if (frame.ownerIds) {
    a.ownerIds = ensureU8(a.ownerIds, Math.max(frame.count, 1));
    a.ownerIds.set(frame.ownerIds.subarray(0, frame.count));
  }
  a.tick = frame.tick;
  a.count = frame.count;

  mirror.tickA = a.tick;
  mirror.tickB = b.tick;
}

/**
 * Interpolate every live unit between buffers B and A at parameter
 * alpha ∈ [0,1] (alpha = accumulator/TICK_DT_MS, per SPEC §2.1), writing
 * packed x,y + heading into `out`. Returns the number of entities
 * written (≤ out capacities).
 *
 * Population changed between the two ticks (spawn/death)? Indices past
 * the shared prefix have no stable partner, so those entities render at
 * their newest positions uninterpolated — cheaper than eid matching and
 * visually invisible at 30 Hz.
 */
export function sampleMirror(
  mirror: RenderMirror,
  alpha: number,
  out: MirrorSampleOut,
): number {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const a = mirror.bufferA;
  const b = mirror.bufferB;

  const capacity = Math.min(
    out.positions.length >> 1,
    out.headings.length,
    out.hpFractions.length,
    a.positions.length >> 1,
    a.headings.length,
    a.hpFractions.length,
  );
  const shared =
    b.count > 0 && a.tick === b.tick + 1 ? Math.min(a.count, b.count) : 0;
  const interpolated = Math.min(shared, capacity);
  const copied = Math.min(Math.max(a.count, 0), capacity);

  const outPos = out.positions;
  const outHead = out.headings;
  const outHp = out.hpFractions;
  const posA = a.positions;
  const posB = b.positions;
  const headA = a.headings;
  const headB = b.headings;
  const hpA = a.hpFractions;
  const hpB = b.hpFractions;

  // Interpolated prefix: both buffers describe the same ascending-eid
  // ranks, so plain index pairing is exact.
  for (let i = 0; i < interpolated; i++) {
    const p = i * 2;
    outPos[p] = posB[p]! + (posA[p]! - posB[p]!) * t;
    outPos[p + 1] = posB[p + 1]! + (posA[p + 1]! - posB[p + 1]!) * t;
    const delta = wrapPi(headA[i]! - headB[i]!);
    outHead[i] = headB[i]! + delta * t;
    outHp[i] = hpB[i]! + (hpA[i]! - hpB[i]!) * t;
  }
  // Tail beyond the shared prefix: newest state verbatim.
  for (let i = interpolated; i < copied; i++) {
    const p = i * 2;
    outPos[p] = posA[p]!;
    outPos[p + 1] = posA[p + 1]!;
    outHead[i] = headA[i]!;
    outHp[i] = hpA[i]!;
  }
  if (out.defCodes) {
    if (a.defCodes && a.defCodes.length >= copied) {
      out.defCodes.set(a.defCodes.subarray(0, copied));
    } else {
      out.defCodes.fill(8, 0, copied);
    }
  }
  if (out.activityCodes && a.activityCodes.length >= copied) {
    out.activityCodes.set(a.activityCodes.subarray(0, copied));
  }
  if (out.ownerIds && a.ownerIds.length >= copied) {
    out.ownerIds.set(a.ownerIds.subarray(0, copied));
  }
  // M3-T6: day/night tint rides the newest buffer's tick — render-side
  // only, no interpolation (the sim clock is integer minutes).
  if (out.lightTint !== undefined && a.tick >= 0) {
    lightingTintAtTick(a.tick, out.lightTint);
  }
  return copied;
}
