/**
 * Worker-side path engine — the pure brain of `src/sim/path.worker.ts`.
 *
 * Same bytes in, same bytes out (ADR-0004): a response depends only on
 * its request contents. Every request gets its own sfc32 stream seeded
 * by `request.seed` (the canonical heap ordering never draws from it,
 * but the stream exists so future tie-break randomness stays
 * replay-stable).
 *
 * The LRU cache (32 entries, SPEC §2.2) short-circuits repeat searches
 * and is invalidated by passability version bumps. Its key is the
 * SPEC's `(goalTile, passabilityVersion)` PLUS the start tile: an A*
 * polyline is a function of both endpoints, and serving one unit
 * another unit's route (same goal, different start) deadlocks segment
 * validation into endless re-paths. Start-inclusion keeps the cache a
 * pure accelerator — hits are byte-identical to fresh searches, so it
 * stays invisible to determinism. (Phase-2 flow fields are the truly
 * start-independent artifacts and will key exactly `(goalTile,
 * version)`.)
 */

import { createPrng } from "../core/prng";
import { findPath } from "./astar";
import type { PathRequest, PathResponse } from "./protocol";

/** LRU capacity — SPEC §2.2: 32 entries keyed (goalTile, version). */
export const PATH_CACHE_CAPACITY = 32;

interface CachedPath {
  readonly ok: boolean;
  readonly waypoints: Int16Array;
  readonly cost: number;
}

export interface PathEngine {
  /** Compute (or cache-fetch) the response for exactly one request. */
  handle(request: PathRequest): PathResponse;
  /** Current LRU occupancy (tests/telemetry). */
  readonly cacheSize: number;
}

/** Flat tile index of the goal — half of the cache key. */
export function goalTileOf(
  goalX: number,
  goalY: number,
  width: number,
): number {
  return goalY * width + goalX;
}

function requireSquareGrid(bytes: Uint8Array): number {
  const width = Math.sqrt(bytes.length);
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(
      `passable snapshot must be a square grid, got length ${String(bytes.length)}`,
    );
  }
  return width;
}

export function createPathEngine(): PathEngine {
  // Map iteration order is insertion order: re-setting a key on a hit
  // refreshes recency, and eviction always takes the first key.
  const cache = new Map<string, CachedPath>();

  const handle = (request: PathRequest): PathResponse => {
    const width = requireSquareGrid(request.passable);
    const key = `${request.passableVersion}:${String(goalTileOf(request.goalX, request.goalY, width))}:${String(goalTileOf(request.startX, request.startY, width))}`;
    let cached = cache.get(key);
    if (cached === undefined) {
      const result = findPath({
        passability: request.passable,
        width,
        startX: request.startX,
        startY: request.startY,
        goalX: request.goalX,
        goalY: request.goalY,
        rng: createPrng(request.seed),
      });
      cached = result
        ? {
            ok: true,
            waypoints: Int16Array.from(result.waypoints),
            cost: result.cost,
          }
        : { ok: false, waypoints: new Int16Array(0), cost: 0 };
      cache.set(key, cached);
      while (cache.size > PATH_CACHE_CAPACITY) {
        const oldest = cache.keys().next();
        if (oldest.done === true) break;
        cache.delete(oldest.value);
      }
    } else {
      // Refresh recency for the LRU discipline.
      cache.delete(key);
      cache.set(key, cached);
    }
    // Copy out: in-process transports share this engine with the sim,
    // and callers may retain or mutate their response arrays.
    return {
      kind: "path",
      id: request.id,
      ok: cached.ok,
      waypoints: cached.waypoints.slice(),
      cost: cached.cost,
    };
  };

  return {
    handle,
    get cacheSize(): number {
      return cache.size;
    },
  };
}
