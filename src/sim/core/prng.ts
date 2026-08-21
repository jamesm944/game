/**
 * sfc32 PRNG seeded via splitmix32 — SPEC §2.1.
 *
 * The sim may never touch `Math.random` or the clock; every stochastic
 * decision flows through a Prng instance whose full 4×u32 state can be
 * serialized into saves and restored bit-exactly (SPEC §2.12).
 */

/** Raw sfc32 state: four unsigned 32-bit words. */
export type Sfc32State = readonly [number, number, number, number];

export interface Prng {
  /** Next raw u32 draw. */
  nextU32(): number;
  /** Next uniform float in [0, 1). */
  nextFloat(): number;
  /** Snapshot of the full 4×u32 state for save/restore. */
  getState(): Sfc32State;
}

/**
 * splitmix32: expands a single u32 seed into an arbitrary stream of
 * well-distributed u32 words used to fill the sfc32 state.
 */
export function splitmix32(seed: number): () => number {
  let z = seed >>> 0;
  return () => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z ^ (z >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * Discarded draws after seeding so weak initial state cannot leak into
 * early outputs. Fixed constant: changing it changes every sequence.
 */
export const SFC32_WARMUP_ROUNDS = 12;

class Sfc32Prng implements Prng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(state: Sfc32State) {
    this.#a = state[0] >>> 0;
    this.#b = state[1] >>> 0;
    this.#c = state[2] >>> 0;
    this.#d = state[3] >>> 0;
  }

  nextU32(): number {
    const t = (this.#a + this.#b) | 0;
    const nextA = this.#b ^ (this.#b >>> 9);
    const nextB = (this.#c + (this.#c << 3)) | 0;
    const rotatedC = (this.#c << 21) | (this.#c >>> 11) | 0;
    const nextD = (this.#d + 1) | 0;
    const out = (t + nextD) | 0;
    this.#a = nextA;
    this.#b = nextB;
    this.#c = (rotatedC + out) | 0;
    this.#d = nextD;
    return out >>> 0;
  }

  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }

  getState(): Sfc32State {
    // Internal words are signed int32 (from |0 arithmetic); expose them
    // canonicalized as u32 so serialization round-trips bit-exactly.
    return [this.#a >>> 0, this.#b >>> 0, this.#c >>> 0, this.#d >>> 0];
  }
}

/** Build a warm-started sfc32 from the u32 game seed via splitmix32. */
export function createPrng(seed: number): Prng {
  const nextSeed = splitmix32(seed);
  const prng = new Sfc32Prng([nextSeed(), nextSeed(), nextSeed(), nextSeed()]);
  for (let i = 0; i < SFC32_WARMUP_ROUNDS; i++) prng.nextU32();
  return prng;
}

/** Rebuild a Prng from an exact serialized state — no re-warmup. */
export function restorePrng(serialized: string): Prng {
  return new Sfc32Prng(deserializePrngState(serialized));
}

const STATE_WORD_PATTERN = /^[0-9a-f]{8}$/;

/** Serialize the 4×u32 state as `word:word:word:word` lowercase hex. */
export function serializePrngState(state: Sfc32State): string {
  return state
    .map((word) => {
      if (!Number.isInteger(word) || word < 0 || word > 0xffffffff) {
        throw new Error(`prng state word out of u32 range: ${String(word)}`);
      }
      return (word >>> 0).toString(16).padStart(8, "0");
    })
    .join(":");
}

/** Parse a `serializePrngState` string back into exact u32 words. */
export function deserializePrngState(serialized: string): Sfc32State {
  const parts = serialized.split(":");
  if (parts.length !== 4 || !parts.every((p) => STATE_WORD_PATTERN.test(p))) {
    throw new Error(`malformed prng state: ${JSON.stringify(serialized)}`);
  }
  return [
    parseInt(parts[0]!, 16),
    parseInt(parts[1]!, 16),
    parseInt(parts[2]!, 16),
    parseInt(parts[3]!, 16),
  ] as const;
}
