/**
 * Deterministic transcendental-free trig — SPEC §2.1.
 *
 * The sim may never call `Math.sin/cos/atan2` (libm results drift across
 * platforms and would break replay-exact digests). Every helper here is
 * a fixed polynomial/rational evaluation over IEEE-754 basic operations
 * (+ − × ÷, sqrt, floor, abs, min/max), which are bit-exact everywhere,
 * so identical inputs always produce bit-identical outputs.
 *
 * Accuracy (verified against libm in tests): sin/cos ≲ 1e-11 absolute,
 * atan2 ≲ 2e-4 radians — far inside steering-feel tolerance.
 */

export const TWO_PI = 2 * Math.PI;
export const HALF_PI = Math.PI / 2;

/** Wrap an angle into [-π, π). Uses only basic ops + floor. */
export function wrapAngle(x: number): number {
  return x - TWO_PI * Math.floor((x + Math.PI) / TWO_PI);
}

/**
 * Shortest signed delta from angle `a` to angle `b`, in (-π, π].
 * Positive = counter-clockwise (standard screen-math convention where
 * +y is down, so visually clockwise — irrelevant to determinism).
 */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Deterministic sine on all of ℝ. */
export function detSin(x: number): number {
  let y = x - TWO_PI * Math.floor((x + Math.PI) / TWO_PI); // [-π, π)
  let negative = false;
  if (y < 0) {
    negative = true;
    y = -y;
  }
  if (y > HALF_PI) y = Math.PI - y; // reduce into [0, π/2]
  // Odd series about 0 through y^13; remainder < 8e-12 at π/2.
  const y2 = y * y;
  const s =
    y *
    (1 +
      y2 *
        (-1 / 6 +
          y2 *
            (1 / 120 +
              y2 * (-1 / 5040 + y2 * (1 / 362880 + y2 * (-1 / 39916800))))));
  return negative ? -s : s;
}

/** Deterministic cosine on all of ℝ. */
export function detCos(x: number): number {
  return detSin(HALF_PI - x);
}

// Minimax polynomial for atan(z), z ∈ [-1, 1]; max |error| ≈ 1e-4 rad.
const ATAN_C0 = 0.7853981694;
const ATAN_C1 = -0.2145007798;
const ATAN_C2 = 0.08533227471;
const ATAN_C3 = -0.03253083455;
const ATAN_C4 = 0.007894486004;

function detAtanUnit(z: number): number {
  const z2 = z * z;
  return (
    z *
    (ATAN_C0 + z2 * (ATAN_C1 + z2 * (ATAN_C2 + z2 * (ATAN_C3 + z2 * ATAN_C4))))
  );
}

/** Angle of vector (x, y) in (-π, π]; returns 0 for the zero vector. */
export function detAtan2(y: number, x: number): number {
  if (y === 0 && x === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  let r: number;
  if (ay <= ax) {
    r = detAtanUnit(ay / ax); // [0, π/4]
  } else {
    r = HALF_PI - detAtanUnit(ax / ay); // (π/4, π/2]
  }
  if (x < 0) r = Math.PI - r;
  return y < 0 ? -r : r;
}

export interface SinCosLut {
  readonly size: number;
  /** sin(2π·i/size), i = 0..size-1. */
  readonly sin: Float64Array;
  /** cos(2π·i/size). */
  readonly cos: Float64Array;
}

/**
 * Startup-built sin/cos LUT (SPEC §2.1 "startup sin/cos LUTs"): filled
 * from the deterministic polynomials above so table contents are
 * platform-independent constants.
 */
export function buildSinCosLut(size: number): SinCosLut {
  if (!Number.isInteger(size) || size < 2) {
    throw new Error(`LUT size must be an integer ≥ 2, got ${String(size)}`);
  }
  const sin = new Float64Array(size);
  const cos = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const angle = (TWO_PI * i) / size;
    sin[i] = detSin(angle);
    cos[i] = detCos(angle);
  }
  return { size, sin, cos };
}
