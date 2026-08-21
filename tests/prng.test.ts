import { describe, expect, it } from "vitest";
import {
  createPrng,
  deserializePrngState,
  restorePrng,
  serializePrngState,
  SFC32_WARMUP_ROUNDS,
  splitmix32,
  type Prng,
} from "../src/sim/core/prng";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function drawSequence(prng: Prng, count: number): number[] {
  return Array.from({ length: count }, () => prng.nextU32());
}

describe("sfc32 prng", () => {
  it("produces a stable sequence for the same seed across runs", () => {
    const a = drawSequence(createPrng(12345), 1000);
    const b = drawSequence(createPrng(12345), 1000);
    expect(a).toEqual(b);
  });

  it("matches pinned reference outputs for seed 12345", () => {
    const prng = createPrng(12345);
    const firstFive = drawSequence(prng, 5);
    expect(firstFive).toEqual([
      1399635887, 83665100, 1191331904, 1206599336, 2617022538,
    ]);
    // Pinned full-state snapshot: catches any accidental algorithm drift.
    expect(serializePrngState(prng.getState())).toBe(
      "48df73c0:50ee5341:8b24d47c:1ec7439e",
    );
  });

  it("diverges immediately for different seeds", () => {
    const a = drawSequence(createPrng(1), 64);
    const b = drawSequence(createPrng(2), 64);
    expect(a).not.toEqual(b);
  });

  it("emits u32-range integers and [0,1) floats", () => {
    const prng = createPrng(987654321);
    for (let i = 0; i < 10_000; i++) {
      const raw = prng.nextU32();
      expect(raw).toBeGreaterThanOrEqual(0);
      expect(raw).toBeLessThanOrEqual(0xffffffff);
      const float = prng.nextFloat();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
  });

  it("warms up the seed before first use", () => {
    expect(SFC32_WARMUP_ROUNDS).toBeGreaterThan(0);
    const seeded = splitmix32(42);
    const coldState = [seeded(), seeded(), seeded(), seeded()] as const;
    const cold = drawSequence(restorePrng(serializePrngState(coldState)), 8);
    const warm = drawSequence(createPrng(42), 8);
    expect(warm).not.toEqual(cold);
  });

  it("round-trips state through serialize/deserialize mid-stream", () => {
    const original = createPrng(20260821);
    for (let i = 0; i < 37; i++) original.nextU32();
    const saved = serializePrngState(original.getState());
    const continuedA = drawSequence(original, 20);

    const restored = restorePrng(saved);
    const continuedB = drawSequence(restored, 20);

    expect(continuedB).toEqual(continuedA);
  });

  it("restores exactly after float draws too", () => {
    const original = createPrng(7);
    for (let i = 0; i < 5; i++) original.nextFloat();
    const saved = serializePrngState(original.getState());
    const continuedA = drawSequence(original, 10);

    const clone = restorePrng(saved);
    const continuedB = drawSequence(clone, 10);

    expect(continuedB).toEqual(continuedA);
  });

  it("deserializes exact u32 words including boundary values", () => {
    expect(deserializePrngState("00000000:ffffffff:80000000:00000001")).toEqual(
      [0, 0xffffffff, 0x80000000, 1],
    );
  });

  it("throws on malformed or out-of-range state strings", () => {
    expect(() => deserializePrngState("nope")).toThrow(/malformed prng state/);
    expect(() => deserializePrngState("48df73c0:50ee5341:8b24d47c")).toThrow(
      /malformed prng state/,
    );
    expect(() =>
      serializePrngState([-1, 0, 0, 0] as unknown as readonly [
        number,
        number,
        number,
        number,
      ]),
    ).toThrow(/out of u32 range/);
  });
});
