/**
 * M4-T1 golden harness — SPEC §2.7 delegated management / issue #56.
 *
 * A five-Pop village under the full delegation roster (movement +
 * gather + production + needs + management; recipes age-unlocked by
 * injection). The cast:
 *
 *   foremanA    — appointed foreman of kitchenA (serving XP probe)
 *   managerFood — food-domain manager obeying strategy sliders (XP probe)
 *   w1 / w2     — the delegable labor pool
 *   w3          — pulled onto the UNMANAGED sawpit by a DIRECT order at
 *                 tick 300, crossing domains against continued food
 *                 pressure: the override rule in front of the camera.
 *
 * Timeline: appointments land on ticks 1–2, the slider shift [3,1]
 * consolidates both kitchens' crafters onto kitchenA by its next
 * staggered think, and the tick-300 direct order fences w3 behind an
 * OrderLock that never drops while the sawpit chain lives.
 *
 * Pinned here:
 * - milestone digests every 150th tick plus final;
 * - a legible per-milestone trace: staffing counts per workplace,
 *   live lock count, and both serving-Pops' Management-skill XP;
 * - semantic gates: saturation under the foreman, post-slider
 *   consolidation [2·kitchenA, 0·kitchenB], the override sticking to
 *   the end, and strictly growing service XP;
 * - extended determinism canary: two identical runs agree byte-for-byte.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defineSimComponents,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  PLAYER_ONE,
  createCommodityStockpile,
  createDropOffPoint,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../../src/sim/core/world";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createGatherDiagnostics,
  createGatherSystem,
} from "../../../src/sim/systems/gather";
import {
  createProductionDiagnostics,
  createProductionSystem,
} from "../../../src/sim/systems/production";
import { createNeedsSystem } from "../../../src/sim/systems/needs";
import { createManagementSystem } from "../../../src/sim/systems/management";
import { stampFinishedBuilding } from "../../../src/sim/systems/placement";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

interface GoldenCommand {
  readonly tick: number;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly startingResources: number[];
  readonly dropOff: [number, number];
  readonly workplaces: Record<string, [number, number]>;
  readonly popSpawns: Record<string, [number, number]>;
  readonly commands: GoldenCommand[];
  readonly traceWorkplaces: string[];
  readonly xpProbes: string[];
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  const box = raw as Record<string, unknown>;
  const pair = (value: unknown): [number, number] => {
    const list = value as unknown[];
    return [Number(list[0]), Number(list[1])];
  };
  return {
    name: String(box.name),
    seed: Number(box.seed),
    size: Number(box.size),
    ticks: Number(box.ticks),
    milestoneEvery: Number(box.milestoneEvery),
    startingResources: box.startingResources as number[],
    dropOff: pair(box.dropOff),
    workplaces: Object.fromEntries(
      Object.entries(box.workplaces as Record<string, unknown>).map(
        ([key, value]) => [key, pair(value)],
      ),
    ),
    popSpawns: Object.fromEntries(
      Object.entries(box.popSpawns as Record<string, unknown>).map(
        ([key, value]) => [key, pair(value)],
      ),
    ) as GoldenCase["popSpawns"],
    commands: (box.commands as GoldenCommand[]).map((command) => ({
      tick: Number(command.tick),
      kind: command.kind,
      data: command.data,
    })),
    traceWorkplaces: box.traceWorkplaces as string[],
    xpProbes: box.xpProbes as string[],
  };
}

/** One milestone's worth of legible delegation state. */
export interface DelegationSample {
  readonly tick: number;
  /** Live crafter count per traced workplace, case-file order. */
  readonly staffing: number[];
  /** Pops currently fenced behind a direct-order lock. */
  readonly locks: number;
  /** Serving-Pops' Management-skill XP (0 before first service). */
  readonly xp: number[];
  readonly digest: string;
}

export interface DelegationRunState {
  readonly digests: { tick: number; digest: string }[];
  readonly trace: DelegationSample[];
  readonly endStaffing: number[];
  readonly endLocks: number;
  readonly endXp: number[];
}

function runScenario(fixture: GoldenCase): DelegationRunState {
  const world = createWorld(fixture.seed, {
    size: fixture.size,
    layers: buildLayers(
      new Uint8Array(fixture.size * fixture.size).fill(TERRAIN_GRASS),
      new Uint8Array(fixture.size * fixture.size),
    ),
    pathScheduler: new PathScheduler(createSynchronousPathTransport()),
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, world.pathScheduler!));
  registerSystem(
    world,
    createGatherSystem(comps, world.pathScheduler!, createGatherDiagnostics()),
  );
  registerSystem(
    world,
    createProductionSystem(comps, createProductionDiagnostics(), {
      isRecipeUnlocked: () => true,
    }),
  );
  registerSystem(world, createNeedsSystem(comps));
  registerSystem(
    world,
    createManagementSystem({ comps, players: [PLAYER_ONE] }),
  );

  createPlayerStockpile(world, comps, PLAYER_ONE, fixture.startingResources);
  createCommodityStockpile(world, comps, PLAYER_ONE);
  createDropOffPoint(
    world,
    comps,
    fixture.dropOff[0],
    fixture.dropOff[1],
    PLAYER_ONE,
  );

  // Buildings first (lower eids), then Pops in case-file order — both
  // ascensions are load-bearing for the trace ordering.
  const workplaceEid = new Map<string, number>();
  for (const [key, tile] of Object.entries(fixture.workplaces)) {
    const defId = key === "sawpit" ? "sawpit" : "kitchen";
    const siteEid = stampSite(world, comps, defId, tile[0], tile[1]);
    workplaceEid.set(key, siteEid);
  }
  const popEid = new Map<string, number>();
  for (const [key, spot] of Object.entries(fixture.popSpawns)) {
    popEid.set(
      key,
      spawnUnit(world, comps, spot[0], spot[1], { identity: true }),
    );
  }

  const scheduled = [...fixture.commands]
    .sort((a, b) => a.tick - b.tick)
    .map((command) => ({
      tick: command.tick,
      kind: command.kind,
      data: resolveRefs(command.data, popEid, workplaceEid),
    }));
  let commandIndex = 0;

  const digests: { tick: number; digest: string }[] = [];
  const trace: DelegationSample[] = [];

  while (world.tick < fixture.ticks) {
    // Case-file commands enter the shared inbox BEFORE their target
    // boundary: a submission after that tick's drain would be late.
    const nextTick = world.tick + 1;
    while (
      commandIndex < scheduled.length &&
      scheduled[commandIndex]!.tick <= nextTick
    ) {
      const command = scheduled[commandIndex++]!;
      world.inbox.submit({
        kind: command.kind,
        targetTick: Math.max(command.tick, nextTick),
        data: command.data,
      });
    }
    step(world);
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      const lockRows = world.rowsByComponentId.get(comps.orderLockId)!;
      const skillRows = world.rowsByComponentId.get(comps.managementSkillId)!;
      trace.push({
        tick,
        staffing: fixture.traceWorkplaces.map(
          (key) =>
            [...world.rowsByComponentId.get(comps.productionJobId)!].filter(
              ([, row]) => row[0] === workplaceEid.get(key),
            ).length,
        ),
        locks: lockRows.size,
        xp: fixture.xpProbes.map(
          (key) => skillRows.get(popEid.get(key)!)?.[0] ?? 0,
        ),
        digest: computeWorldDigest(world),
      });
      digests.push({ tick, digest: computeWorldDigest(world) });
    }
  }

  const last = trace[trace.length - 1]!;
  return {
    digests,
    trace,
    endStaffing: last.staffing,
    endLocks: last.locks,
    endXp: last.xp,
  };
}

/** Resolve symbolic command refs ("foremanA") into entity ids. */
function resolveRefs(
  data: Record<string, unknown>,
  pops: Map<string, number>,
  buildings: Map<string, number>,
): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const pop = pops.get(value);
      if (pop !== undefined) return pop;
      const building = buildings.get(value);
      if (building !== undefined) return building;
    }
    if (Array.isArray(value)) return value.map(resolve);
    return value;
  };
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, resolve(value)]),
  );
}

function stampSite(
  world: World,
  comps: SimComponents,
  defId: string,
  tileX: number,
  tileY: number,
): number {
  return stampFinishedBuilding(world, comps, defId, tileX, tileY, {
    playerId: PLAYER_ONE,
  });
}

installSimPurityShims();

describe("golden harness m4t1", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests plus the delegation trace", () => {
    const run = runScenario(fixture);

    const expectedTicks: number[] = [];
    for (
      let tick = fixture.milestoneEvery;
      tick <= fixture.ticks;
      tick += fixture.milestoneEvery
    ) {
      expectedTicks.push(tick);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
    expect(run.trace).toMatchSnapshot();
  });

  it("saturates, obeys the sliders, and honors the override", () => {
    const run = runScenario(fixture);
    const staffingAt = (tick: number): number[] | undefined =>
      run.trace.find((sample) => sample.tick >= tick)?.staffing;

    // SATURATION × SLIDERS: kitchenA is staffed from the foreman's
    // earliest thinks; the tick-60 slider shift then consolidates both
    // kitchens' crafters onto kitchenA, so even the FIRST milestone
    // (tick 150) already shows the post-shift [2·A, 0·B] bench shape.
    const firstMilestone = run.trace[0]!;
    expect(firstMilestone.tick).toBe(fixture.milestoneEvery);
    expect(firstMilestone.staffing[0]).toBeGreaterThanOrEqual(1);
    expect(firstMilestone.staffing).toEqual([2, 0, 0]);

    // OVERRIDE: w3's direct sawpit order sticks through continued food
    // pressure; exactly one lock lives while the chain runs.
    expect(staffingAt(450)?.[2]).toBe(1);
    expect(run.endStaffing).toEqual([2, 0, 1]);
    expect(run.endLocks).toBe(1);

    // SERVICE XP: both officers grew their Management skill on the job.
    expect(run.endXp[0]).toBeGreaterThan(0);
    expect(run.endXp[1]).toBeGreaterThan(0);

    // And the milestones all carry well-formed digests.
    expect(run.digests.length).toBe(fixture.ticks / fixture.milestoneEvery);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture);
    const second = runScenario(fixture);
    expect(second).toEqual(first);
  });
});
