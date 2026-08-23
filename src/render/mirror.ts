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
}

const TICK_UNSET = -1;

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

function emptyBuffer(): MirrorBuffer {
  return {
    tick: TICK_UNSET,
    count: 0,
    eids: new Int32Array(0),
    positions: new Float32Array(0),
    headings: new Float32Array(0),
    hpFractions: new Float32Array(0),
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
  return copied;
}
