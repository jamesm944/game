/**
 * FNV-1a-64 digest serializer — SPEC §7.
 *
 * Canonical state snapshot: components in alphabetical registry order ×
 * entities in ascending eid order, one line per (component, entity) of
 * the form `componentName:eid:v1,v2,...`.
 *
 * Hashed byte layout per line: UTF-8 of `componentName:eid:` then each
 * float as its exact IEEE-754 f64 bit pattern (big-endian), values
 * separated by 0x2C, line terminated by 0x0A. Floats never pass through
 * decimal text so `-0`/`+0`, NaN payloads and full 2⁵³ precision survive
 * hashing bit-exactly.
 */

export const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
export const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;
const UTF8_ENCODER = new TextEncoder();
const FLOAT_SCRATCH = new DataView(new ArrayBuffer(8));

/** Raw FNV-1a-64 over arbitrary bytes (map.bin layers hash here later). */
export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash;
}

const DIGEST_PREFIX = "fnv1a64:" as const;

/** Render a u64 hash as the canonical `fnv1a64:<16 lowercase hex>`. */
export function formatDigest(hash: bigint): string {
  if (hash < 0n || hash > FNV_MASK) {
    throw new Error(`not a u64 value: ${hash}`);
  }
  return `${DIGEST_PREFIX}${hash.toString(16).padStart(16, "0")}`;
}

/** Convenience wrapper hashing raw bytes straight to the digest string. */
export function fnv1a64Hex(bytes: Uint8Array): string {
  return formatDigest(fnv1a64(bytes));
}

/** What the digest recipe iterates: one component's live rows. */
export interface DigestComponentSource {
  readonly name: string;
  /** Entity ids holding this component, ascending. */
  readonly eidsAscending: readonly number[];
  /** Component values for one entity, in canonical field order. */
  valuesFor(eid: number): readonly number[];
}

function appendFloat64(out: number[], value: number): void {
  if (!Number.isNaN(value) && !Number.isFinite(value)) {
    throw new Error(`cannot digest non-finite float: ${String(value)}`);
  }
  // NaN folds to its single hardware quiet pattern here, keeping the
  // stream well-defined even after bad arithmetic upstream.
  FLOAT_SCRATCH.setFloat64(0, value, false);
  const bits = FLOAT_SCRATCH.getBigUint64(0, false);
  for (let shift = 56; shift >= 0; shift -= 8) {
    out.push(Number((bits >> BigInt(shift)) & 0xffn));
  }
}

/** The exact byte stream the digest hashes — exposed for debugging/diffs. */
export function digestInputBytes(
  components: readonly DigestComponentSource[],
): Uint8Array {
  const out: number[] = [];
  for (const component of components) {
    let previousEid = -1;
    for (const eid of component.eidsAscending) {
      if (!Number.isInteger(eid) || eid <= previousEid) {
        throw new Error(
          `component ${JSON.stringify(component.name)}: eids must ascend strictly (${String(eid)} after ${String(previousEid)})`,
        );
      }
      previousEid = eid;
      out.push(...UTF8_ENCODER.encode(`${component.name}:${eid}:`));
      const values = component.valuesFor(eid);
      for (let i = 0; i < values.length; i++) {
        if (i > 0) out.push(0x2c);
        appendFloat64(out, values[i]!);
      }
      out.push(0x0a);
    }
  }
  return Uint8Array.from(out);
}

/** SPEC §7 state digest over the given component sources. */
export function computeDigest(
  components: readonly DigestComponentSource[],
): string {
  return fnv1a64Hex(digestInputBytes(components));
}
