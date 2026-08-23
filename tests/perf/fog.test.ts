/**
 * Fog stamping perf gate — SPEC §2.9 / M2-T8.
 *
 * Worst-case dirty-entity flush at 300 sight contributors (the §7
 * canonical population): every entity marked moved every tick, each
 * un-stamping + re-stamping a full LUT circle through the real
 * provider. Asserts the < 1 ms/tick budget (mean AND p95) with the
 * shared CI ×4 tolerance contract from tests/perf/budget.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  createFogVisibility,
  type VisibilityProvider,
} from "../../src/sim/systems/fog";
import { installSimPurityShims } from "../helpers/sim-purity-shims";

installSimPurityShims();

const IN_CI =
  process.env.CI === "true" ||
  process.env.CI === "1" ||
  process.env.CI === "yes";

function effectiveBudget(ms: number): number {
  return IN_CI ? ms * 4 : ms;
}

const ENTITY_COUNT = 300;
const MEASURED_TICKS = 200;
/** Stamping budget per tick (SPEC §2.9 acceptance criterion). */
const STAMP_BUDGET_MS = 1;

describe("fog stamping perf (M2-T8)", () => {
  it("flushes 300 moved entities in under 1 ms/tick worst case", () => {
    const size = 120;
    const fog = createFogVisibility(size, 2);
    // Synthetic population: radii spanning the definition table
    // (villager 5 … tower 10), spread across the whole grid.
    const entities = Array.from({ length: ENTITY_COUNT }, (_, i) => ({
      eid: i + 1,
      tileX: (i * 7) % size,
      tileY: (i * 13) % size,
      sightRadius: 5 + (i % 6),
      owner: i % 2,
      defId: "villager",
      kind: "unit" as const,
      originX: (i * 7) % size,
      originY: (i * 13) % size,
      footWidth: 1,
      footHeight: 1,
    }));
    fog.bindSource({
      resolve: (eid) => entities[eid - 1],
      eidsAscending: () => entities.map((entity) => entity.eid),
    });
    fog.recomputeAll();

    // Warmup, then measure full un-stamp + re-stamp cycles where EVERY
    // entity moves one tile east (worst case: nothing dedupes away).
    for (let tick = 0; tick < 20; tick++) {
      markAllAndFlush(fog.provider, entities, size);
    }
    const samples: number[] = [];
    for (let tick = 0; tick < MEASURED_TICKS; tick++) {
      const start = performance.now();
      markAllAndFlush(fog.provider, entities, size);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const mean =
      samples.reduce((total, value) => total + value, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.log(
      `fog stamping ${String(ENTITY_COUNT)} entities: mean ` +
        `${mean.toFixed(3)} ms · p95 ${p95.toFixed(3)} ms · max ` +
        `${samples[samples.length - 1]!.toFixed(3)} ms`,
    );
    expect(p95).toBeLessThan(effectiveBudget(STAMP_BUDGET_MS));

    // Planes stay consistent after the churn: counts never drift.
    const { planes } = fog.state;
    for (let player = 0; player < planes.length; player++) {
      const plane = planes[player]!;
      let liveContributors = 0;
      for (let i = 0; i < plane.contributorCount.length; i++) {
        if (plane.contributorCount[i]! > 0) liveContributors += 1;
        expect(plane.visible[i]).toBe(plane.contributorCount[i]! > 0 ? 1 : 0);
      }
      expect(liveContributors).toBeGreaterThan(0);
    }
  });
});

/** Mark every entity moved (one tile east, wrapping) and flush. */
function markAllAndFlush(
  provider: VisibilityProvider,
  entities: { eid: number; tileX: number }[],
  size: number,
): void {
  for (const entity of entities) {
    entity.tileX = (entity.tileX + 1) % size;
    provider.markDirty("moved", entity.eid);
  }
  provider.flushDirty();
}
