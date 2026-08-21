import { describe, expect, it } from "vitest";
import {
  computeDigest,
  digestInputBytes,
  fnv1a64,
  fnv1a64Hex,
  formatDigest,
  FNV_OFFSET_BASIS,
  type DigestComponentSource,
} from "../src/sim/core/digest";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const UTF8 = new TextEncoder();
const bytesOf = (text: string): Uint8Array => UTF8.encode(text);

function source(
  name: string,
  rows: Record<number, number[]>,
): DigestComponentSource {
  const eids = Object.keys(rows)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    name,
    eidsAscending: eids,
    valuesFor: (eid) => {
      const values = rows[eid];
      if (!values) throw new Error(`missing row ${String(eid)}`);
      return values;
    },
  };
}

describe("fnv1a64 raw byte hashing", () => {
  it("matches published reference vectors", () => {
    // Official FNV test vectors (draft-eastlake-fnv).
    expect(fnv1a64(new Uint8Array(0))).toBe(FNV_OFFSET_BASIS);
    expect(formatDigest(fnv1a64(new Uint8Array(0)))).toBe(
      "fnv1a64:cbf29ce484222325",
    );
    expect(fnv1a64(bytesOf("a")).toString(16)).toBe("af63dc4c8601ec8c");
    expect(fnv1a64(bytesOf("foobar")).toString(16)).toBe("85944171f73967e8");
  });

  it("hashes binary Uint8Array input directly (map.bin contract)", () => {
    expect(fnv1a64Hex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toMatch(
      /^fnv1a64:[0-9a-f]{16}$/,
    );
    // Same bytes via a string must hash identically to raw bytes.
    expect(fnv1a64(bytesOf("foobar"))).toBe(fnv1a64(UTF8.encode("foobar")));
    // Any single-byte change flips the hash.
    expect(fnv1a64(new Uint8Array([1, 2, 3]))).not.toBe(
      fnv1a64(new Uint8Array([1, 2, 4])),
    );
  });

  it("renders u64 hashes zero-padded lowercase", () => {
    expect(formatDigest(0n)).toBe("fnv1a64:0000000000000000");
    expect(formatDigest(0xffffffffffffffffn)).toBe("fnv1a64:ffffffffffffffff");
    expect(() => formatDigest(-1n)).toThrow(/not a u64/);
  });
});

describe("digest recipe", () => {
  it("produces the canonical digest format", () => {
    const digest = computeDigest([source("mass", { 1: [5] })]);
    expect(digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("distinguishes -0.0 from +0.0 via exact f64 bit patterns", () => {
    const negativeZero = computeDigest([source("mass", { 1: [-0] })]);
    const positiveZero = computeDigest([source("mass", { 1: [0] })]);
    expect(negativeZero).not.toEqual(positiveZero);

    // And the sign bit is literally present in the hashed stream.
    const negBytes = [...digestInputBytes([source("mass", { 1: [-0] })])];
    const posBytes = [...digestInputBytes([source("mass", { 1: [0] })])];
    expect(negBytes.slice(-9, -1).join(",")).toBe(
      [0x80, 0, 0, 0, 0, 0, 0, 0].join(","),
    );
    expect(posBytes.slice(-9, -1).every((b) => b === 0)).toBe(true);
  });

  it("preserves full f64 precision without decimal round-trips", () => {
    // Awkward magnitudes that decimal text hashing would mangle or merge.
    const awkward = [
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      1 / 3,
      Math.PI * 1e300,
      -123456.7890123456789,
    ];
    const digests = awkward.map(
      (value) => computeDigest([source("f", { 1: [value] })]) as string,
    );
    expect(new Set(digests).size).toBe(awkward.length);

    // Stability: identical state rebuilds to the identical digest.
    expect(computeDigest([source("f", { 1: awkward })])).toBe(
      computeDigest([source("f", { 1: awkward })]),
    );

    // NaN canonicalizes deterministically instead of throwing.
    expect(computeDigest([source("f", { 1: [Number.NaN] })])).toBe(
      computeDigest([source("f", { 1: [Number.NaN] })]),
    );
  });

  it("encodes lines as componentName:eid:<f64 bytes> with separators", () => {
    const stream = [...digestInputBytes([source("hp", { 12: [1.5, -2] })])]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const expected =
      Buffer.from("hp:12:", "utf8").toString("hex") +
      // 1.5 = 0x3FF8000000000000 big-endian
      "3ff8000000000000" +
      "2c" +
      // -2 = 0xC000000000000000 big-endian
      "c000000000000000" +
      "0a";
    expect(stream).toBe(expected);
  });

  it("iterates components then entities in canonical order", () => {
    const alphaThenBeta = computeDigest([
      source("alpha", { 2: [1], 10: [2] }),
      source("beta", { 2: [3] }),
    ]);
    // Same content, different component order → different digest.
    const betaThenAlpha = computeDigest([
      source("beta", { 2: [3] }),
      source("alpha", { 2: [1], 10: [2] }),
    ]);
    expect(alphaThenBeta).not.toEqual(betaThenAlpha);
    // Same order, rebuilt → identical (stability across runs).
    expect(
      computeDigest([
        source("alpha", { 2: [1], 10: [2] }),
        source("beta", { 2: [3] }),
      ]),
    ).toEqual(alphaThenBeta);
    // Entity order within a component matters too.
    expect(
      computeDigest([
        source("alpha", { 10: [2], 2: [1] }),
        source("beta", { 2: [3] }),
      ]),
    ).toEqual(alphaThenBeta);
  });

  it("rejects non-finite floats other than NaN and unsorted eids", () => {
    expect(() =>
      computeDigest([source("mass", { 1: [Number.POSITIVE_INFINITY] })]),
    ).toThrow(/non-finite float/);

    const outOfOrder: DigestComponentSource = {
      name: "mass",
      eidsAscending: [5, 3],
      valuesFor: (eid) => [eid],
    };
    expect(() => digestInputBytes([outOfOrder])).toThrow(/eids must ascend/);
  });

  it("hashes empty world state to the offset basis", () => {
    expect(computeDigest([])).toBe("fnv1a64:cbf29ce484222325");
    expect(computeDigest([source("empty", {})])).toBe(
      "fnv1a64:cbf29ce484222325",
    );
  });
});
