/**
 * Overlay instance packing — M2-T6 (SPEC §7 overlays = 2 extra draw
 * calls).
 *
 * Deliberately THREE-FREE and DOM-free: the per-frame CPU cost of the
 * overlay layers is a flat typed-array attribute fill, exactly like the
 * billboard field (tests/perf/billboard.test.ts pins that discipline).
 * Keeping the packer pure lets node tests assert the write path's
 * semantics (types, capacities, include rule) AND its budget without a
 * browser; the three.js layer in render/healthBars.ts only uploads what
 * this module produced.
 *
 * Health bars appear over units that are damaged OR selected: healthy,
 * unselected units stay clean (AoE2 feel), so a full-health army costs
 * zero overlay instances.
 */

export const HEALTH_BAR_CAPACITY = 512;

/** Height above ground where bars float, in tiles. */
export const HEALTH_BAR_LIFT = 1.7;

/** Destination scratch arrays for one frame of bar instances. */
export interface HealthBarAttributeArrays {
  /** Packed x,y,z origins, capacity ≥ 3·maxInstances. */
  readonly origins: Float32Array;
  /** Health fill fraction per instance, capacity ≥ maxInstances. */
  readonly fractions: Float32Array;
}

/** One frame of overlay input (structurally the mirror sample). */
export interface HealthBarSampleInput {
  /** Packed x,y pairs for every sampled unit. */
  readonly positions: Float32Array;
  /** Health 0..1 per unit rank. */
  readonly hpFractions: Float32Array;
  /** 1 = selected (bars forced on), 0 = damaged-only visibility. */
  readonly selectedFlags: Uint8Array;
  /** Units sampled this frame. */
  readonly count: number;
}

/**
 * Pack health-bar instance attributes for every DAMAGED or SELECTED
 * unit up to `maxInstances`. Returns the number of instances written;
 * `mesh.count` semantics — everything past the return value is stale
 * and must not be drawn. Flat loop, no allocation, no branching beyond
 * the include rule: O(instances) with tiny constants.
 */
export function packHealthBarAttributes(
  arrays: HealthBarAttributeArrays,
  sample: HealthBarSampleInput,
  heights: Float32Array,
  maxInstances: number,
): number {
  const limit = Math.min(
    sample.count,
    maxInstances,
    arrays.fractions.length,
    heights.length,
    arrays.origins.length / 3,
    sample.hpFractions.length,
    sample.selectedFlags.length,
  );
  let written = 0;
  for (let i = 0; i < limit; i++) {
    const hp = sample.hpFractions[i]!;
    if (hp >= 1 && sample.selectedFlags[i] !== 1) continue;
    // Instances compact toward the front but keep their own positions.
    arrays.origins[written * 3] = sample.positions[i * 2]!;
    arrays.origins[written * 3 + 1] = heights[i]! + HEALTH_BAR_LIFT;
    arrays.origins[written * 3 + 2] = sample.positions[i * 2 + 1]!;
    arrays.fractions[written] = hp;
    written++;
  }
  return written;
}
