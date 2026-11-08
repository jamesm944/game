import { readActivityQueue, defineSimComponents, spawnUnit, type SimComponents } from "../../../../src/sim/components";
import { createPlayerStockpile } from "../../../../src/sim/core/stockpile";
import { RESOURCE_COUNT } from "../../../../src/sim/components/economy";
import { serializePrngState } from "../../../../src/sim/core/prng";
import { computeWorldDigest, createWorld, registerSystem, step, type World } from "../../../../src/sim/core/world";
import { createMovementDiagnostics, createMovementSystem } from "../../../../src/sim/systems/movement";
import { createPlacementSystem } from "../../../../src/sim/systems/placement";
import { buildLayers, layersHash, TERRAIN_DEEP_WATER, TERRAIN_GRASS } from "../../../../src/sim/world/layers";
import { SchedulerInstrumentation } from "../../../full-game-movement/harness/instrumentation";
import type {
  BenchmarkResult,
  CrowdStates,
  GroupSpec,
  MutationMetric,
  PathRequestMetric,
  ReplayMilestone,
  RunOptions,
  ScenarioSpec,
  TickMetric,
  UnitCompletion,
} from "../../../full-game-movement/harness/types";
import type { PathRequest, PathResponse } from "../../../../src/sim/path/protocol";
import type { CombinedRecastCandidate } from "./adapter";
import { installVersionedSnapshotScheduler } from "./snapshot-cache";

export interface AsyncRunOptions extends RunOptions {
  /** Yield after every attempted step so worker messages can reach the page. */
  readonly yieldFrame?: () => Promise<void>;
  /** Real-worker compute time is not inferred on the main thread. */
  readonly omitComputeMs?: boolean;
  readonly onProgress?: (tick: number, frame: number, pending: number) => void;
}

export function macrotaskYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface OrderTrack {
  readonly id: number;
  readonly tick: number;
  readonly eids: readonly number[];
  readonly destination: { readonly x: number; readonly y: number };
  requestId?: number;
  applyTick?: number;
  readonly outcomes: Map<number, UnitCompletion["outcome"]>;
  readonly completionTicks: Map<number, number>;
}

function makeLayers(scenario: ScenarioSpec) {
  const count = scenario.size * scenario.size;
  const terrain = new Uint8Array(count);
  terrain.fill(TERRAIN_GRASS);
  for (const rect of scenario.map.blocked) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        if (x < 0 || y < 0 || x >= scenario.size || y >= scenario.size) {
          throw new Error(`${scenario.name}: blocked rectangle escapes map`);
        }
        terrain[y * scenario.size + x] = TERRAIN_DEEP_WATER;
      }
    }
  }
  return buildLayers(terrain, new Uint8Array(count));
}

function groupPopulation(spec: ScenarioSpec, group: GroupSpec, population: number, index: number): number {
  const shares = spec.groups.reduce((sum, entry) => sum + entry.share, 0);
  const exact = (population * group.share) / shares;
  const base = Math.floor(exact);
  const fractional = exact - base;
  const ranked = spec.groups
    .map((entry, i) => ({ i, fraction: (population * entry.share) / shares - Math.floor((population * entry.share) / shares) }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  const allocatedBase = spec.groups.reduce((sum, entry) => sum + Math.floor((population * entry.share) / shares), 0);
  const remainderRank = ranked.findIndex((entry) => entry.i === index);
  return base + (remainderRank < population - allocatedBase ? 1 : 0);
}

function spawnGroups(world: World, comps: SimComponents, scenario: ScenarioSpec, population: number): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  scenario.groups.forEach((group, index) => {
    const target = groupPopulation(scenario, group, population, index);
    const ids: number[] = [];
    outer: for (let y = group.spawn.y; y < group.spawn.y + group.spawn.height; y += 1) {
      for (let x = group.spawn.x; x < group.spawn.x + group.spawn.width; x += 1) {
        if (x < 0 || y < 0 || x >= scenario.size || y >= scenario.size) continue;
        if (world.layers.derivedPassability[y * scenario.size + x] !== 1) continue;
        ids.push(spawnUnit(world, comps, x + 0.5, y + 0.5));
        if (ids.length === target) break outer;
      }
    }
    if (ids.length !== target) {
      throw new Error(`${scenario.name}: public spawn APIs placed ${ids.length}/${target} units in ${group.id}`);
    }
    groups.set(group.id, ids);
  });
  return groups;
}

async function fullStateHash(world: World, worldDigest: string, mapHash: string): Promise<string> {
  const canonical = JSON.stringify([world.tick, worldDigest, mapHash, serializePrngState(world.prng.getState())]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export async function runBenchmarkAsync(options: AsyncRunOptions): Promise<BenchmarkResult> {
  const { scenario, population } = options;
  const yieldFrame = options.yieldFrame ?? macrotaskYield;
  if (!Number.isInteger(population) || population < 1) throw new Error("population must be a positive integer");
  const ticks = options.ticks ?? scenario.ticks;
  const digestEvery = options.digestEvery ?? 60;
  const maxFrames = options.maxFrames ?? ticks * 30 + 100;
  const layers = makeLayers(scenario);
  const initialMapHash = layersHash(layers);
  let frame = 0;
  let boundaryTick = 1;
  const orders: OrderTrack[] = [];
  const orderByRequest = new Map<number, OrderTrack>();
  const activeOrder = new Map<number, OrderTrack>();
  const latestOrder = new Map<number, OrderTrack>();

  const instrumentation = new SchedulerInstrumentation({
    adapter: options.candidate,
    evidenceClass: options.evidenceClass,
    boundaryTick: () => boundaryTick,
    frame: () => frame,
    onRequest(metric: PathRequestMetric, request: PathRequest) {
      const order = orders.find(
        (entry) =>
          entry.requestId === undefined &&
          entry.tick === metric.issueTick &&
          Math.floor(entry.destination.x) === request.goalX &&
          Math.floor(entry.destination.y) === request.goalY,
      );
      if (order) {
        order.requestId = request.id;
        orderByRequest.set(request.id, order);
        (metric as { commandTick?: number }).commandTick = order.tick;
      }
    },
    onApply(metric: PathRequestMetric, response: PathResponse) {
      const order = orderByRequest.get(metric.id);
      if (!order) return;
      if (metric.applyTick !== undefined) order.applyTick = metric.applyTick;
      for (const eid of order.eids) {
        const previous = activeOrder.get(eid);
        if (previous && previous !== order && !previous.outcomes.has(eid)) {
          previous.outcomes.set(eid, "replaced");
        }
        if (!response.ok) {
          order.outcomes.set(eid, "no-path");
          activeOrder.delete(eid);
        } else {
          activeOrder.set(eid, order);
        }
      }
    },
    onDiscard(metric: PathRequestMetric) {
      const order = orderByRequest.get(metric.id);
      if (!order) return;
      if (metric.applyTick !== undefined) order.applyTick = metric.applyTick;
      for (const eid of order.eids) {
        if (!order.outcomes.has(eid)) order.outcomes.set(eid, "stale-cancelled");
        if (activeOrder.get(eid) === order) activeOrder.delete(eid);
      }
    },
  });
  const scheduler = instrumentation.scheduler;
  const versionedCandidate = options.candidate as CombinedRecastCandidate;
  if (versionedCandidate.id !== "combined-exact-tile-recast-versioned-snapshots" || !versionedCandidate.snapshots) {
    throw new Error("snapshot async runner requires the combined Recast candidate");
  }
  installVersionedSnapshotScheduler(scheduler, versionedCandidate.snapshots);
  const world = createWorld(scenario.seed, { layers, pathScheduler: scheduler });
  const comps = defineSimComponents(world);
  const diagnostics = createMovementDiagnostics();
  registerSystem(world, createMovementSystem(comps, scheduler, diagnostics));
  const mutations: MutationMetric[] = [];
  const buildingRevisionBefore = new Map<number, number>();

  registerSystem(world, (current, commands) => {
    for (const command of commands) {
      if (command.kind !== "benchmarkTerrain") continue;
      const mutation = scenario.terrainMutations.find((entry) => entry.targetTick === command.targetTick);
      if (!mutation) throw new Error(`unrecorded terrain mutation at ${command.targetTick}`);
      const revisionBefore = scheduler.passabilityVersion;
      let changedTiles = 0;
      for (const tile of mutation.tiles) {
        const index = tile.y * current.layers.size + tile.x;
        if (current.layers.derivedPassability[index] !== mutation.passable) {
          current.layers.derivedPassability[index] = mutation.passable;
          current.layers.terrainType[index] = mutation.passable === 1 ? TERRAIN_GRASS : TERRAIN_DEEP_WATER;
          changedTiles += 1;
        }
      }
      if (changedTiles > 0) scheduler.setPassabilityVersion(revisionBefore + 1);
      mutations.push({
        tick: current.tick,
        kind: "terrain",
        revisionBefore,
        revisionAfter: scheduler.passabilityVersion,
        changedTiles,
      });
    }
  });
  registerSystem(world, (current, commands) => {
    if (commands.some((command) => command.kind === "placeBuilding")) {
      buildingRevisionBefore.set(current.tick, scheduler.passabilityVersion);
    }
  });
  registerSystem(world, createPlacementSystem(comps));

  if (scenario.buildingMutations.length > 0) {
    createPlayerStockpile(world, comps, 0, new Array<number>(RESOURCE_COUNT).fill(1_000_000));
  }
  const groups = spawnGroups(world, comps, scenario, population);
  const unitIds = [...groups.values()].flat().sort((a, b) => a - b);

  for (const trace of scenario.commands) {
    for (const groupId of trace.groupIds) {
      const group = scenario.groups.find((entry) => entry.id === groupId)!;
      const eids = groups.get(groupId)!;
      const order: OrderTrack = {
        id: orders.length + 1,
        tick: trace.targetTick,
        eids,
        destination: group.destination,
        outcomes: new Map(),
        completionTicks: new Map(),
      };
      orders.push(order);
      for (const eid of eids) latestOrder.set(eid, order);
      world.inbox.submit({
        kind: "groupMove",
        targetTick: trace.targetTick,
        data: { entityIds: eids, x: group.destination.x, y: group.destination.y },
      });
    }
  }
  for (const mutation of scenario.terrainMutations) {
    world.inbox.submit({ kind: "benchmarkTerrain", targetTick: mutation.targetTick, data: {} });
  }
  for (const mutation of scenario.buildingMutations) {
    world.inbox.submit({
      kind: "placeBuilding",
      targetTick: mutation.targetTick,
      data: { defId: mutation.defId, tileX: mutation.tileX, tileY: mutation.tileY },
    });
  }

  const milestones: ReplayMilestone[] = [];
  const tickMetrics: TickMetric[] = [];
  let maxQueueDepth = scheduler.pendingCount;
  const started = performance.now();
  while (world.tick < ticks && frame < maxFrames) {
    frame += 1;
    boundaryTick = world.tick + 1;
    options.candidate.beforeFrame?.();
    const stepStarted = performance.now();
    const before = world.tick;
    step(world);
    const wallMs = performance.now() - stepStarted;
    const queueDepth = scheduler.pendingCount;
    maxQueueDepth = Math.max(maxQueueDepth, queueDepth);
    tickMetrics.push({ tick: world.tick, wallMs, queueDepth, blockedTicks: scheduler.blockedTicks, passabilityVersion: scheduler.passabilityVersion });
    if (world.tick === before) {
      options.onProgress?.(world.tick, frame, queueDepth);
      await yieldFrame();
      continue;
    }

    const buildingBefore = buildingRevisionBefore.get(world.tick);
    if (buildingBefore !== undefined) {
      const buildingCount = scenario.buildingMutations.filter((entry) => entry.targetTick === world.tick).length;
      mutations.push({
        tick: world.tick,
        kind: "building",
        revisionBefore: buildingBefore,
        revisionAfter: scheduler.passabilityVersion,
        changedTiles: (scheduler.passabilityVersion - buildingBefore) * 4,
      });
      if (buildingCount !== scheduler.passabilityVersion - buildingBefore) {
        throw new Error(`${scenario.name}: building revision mismatch at ${world.tick}`);
      }
    }

    for (const [eid, order] of activeOrder) {
      if (order.outcomes.has(eid) || order.applyTick === undefined) continue;
      if (readActivityQueue(world, comps, eid).length === 0) {
        order.outcomes.set(eid, "completed");
        order.completionTicks.set(eid, world.tick);
        activeOrder.delete(eid);
      }
    }
    if (world.tick % digestEvery === 0 || world.tick === ticks) {
      const worldDigest = computeWorldDigest(world);
      const mapHash = layersHash(world.layers);
      milestones.push({ tick: world.tick, worldDigest, layersHash: mapHash, fullStateHash: await fullStateHash(world, worldDigest, mapHash) });
    }
    options.onProgress?.(world.tick, frame, queueDepth);
    await yieldFrame();
  }
  const wallClockMs = performance.now() - started;
  options.candidate.dispose?.();
  if (world.tick !== ticks) {
    throw new Error(`${scenario.name} population=${population}: reached tick ${world.tick}/${ticks} after ${frame}/${maxFrames} frames; ${scheduler.pendingCount} paths pending`);
  }

  const requests = options.omitComputeMs
    ? instrumentation.requests.map((request) => {
        const { computeMs: _notMeasured, ...withoutCompute } = request;
        return withoutCompute;
      })
    : instrumentation.requests;
  for (const mutation of mutations) {
    const recovery = requests.find(
      (request) =>
        request.outcome === "applied" &&
        request.issueTick >= mutation.tick &&
        request.passableVersion >= mutation.revisionAfter &&
        request.applyTick !== undefined,
    );
    if (recovery?.applyTick !== undefined) (mutation as { firstRecoveryApplyTick?: number }).firstRecoveryApplyTick = recovery.applyTick;
  }
  const completions: UnitCompletion[] = [];
  for (const order of orders) {
    for (const eid of order.eids) {
      completions.push({
        eid,
        commandTick: order.tick,
        ...(order.applyTick !== undefined ? { applyTick: order.applyTick } : {}),
        ...(order.completionTicks.has(eid) ? { completionTick: order.completionTicks.get(eid)! } : {}),
        outcome: order.outcomes.get(eid) ?? "active-at-cutoff",
      });
    }
  }

  const crowdStates = {
    completed: 0,
    moving: 0,
    stalled: 0,
    propagatedParked: 0,
    parkedNoActivity: 0,
    awaitingGroupPath: 0,
    otherActivity: 0,
  };
  for (const eid of unitIds) {
    const queue = readActivityQueue(world, comps, eid);
    const velocity = world.rowsByComponentId.get(comps.velocityId)!.get(eid)!;
    const latest = latestOrder.get(eid)!;
    if (latest.applyTick === undefined && latest.outcomes.get(eid) === undefined) crowdStates.awaitingGroupPath += 1;
    if (queue.length === 0) {
      if (latest.outcomes.get(eid) === "completed") crowdStates.completed += 1;
      else crowdStates.parkedNoActivity += 1;
    } else if (queue[0]!.kind !== "move" && queue[0]!.kind !== "attackMove") {
      crowdStates.otherActivity += 1;
    } else if (velocity[7] !== 0) {
      crowdStates.propagatedParked += 1;
    } else if (velocity[2]! > 0) {
      crowdStates.stalled += 1;
    } else {
      crowdStates.moving += 1;
    }
  }

  const finalWorldDigest = computeWorldDigest(world);
  const finalMapHash = layersHash(world.layers);
  if (milestones.at(-1)?.tick !== world.tick) {
    milestones.push({ tick: world.tick, worldDigest: finalWorldDigest, layersHash: finalMapHash, fullStateHash: await fullStateHash(world, finalWorldDigest, finalMapHash) });
  }
  const applyCosts = requests.flatMap((request) => request.applyCostMs === undefined ? [] : [request.applyCostMs]);
  const tickWall = tickMetrics.map((metric) => metric.wallMs);
  const units = unitIds.map((eid) => {
    const position = world.rowsByComponentId.get(comps.positionId)!.get(eid)!;
    const velocity = world.rowsByComponentId.get(comps.velocityId)!.get(eid)!;
    const queue = readActivityQueue(world, comps, eid);
    const head = queue[0];
    const movement = head && (head.kind === "move" || head.kind === "attackMove") ? head : undefined;
    return {
      eid,
      x: position[0]!,
      y: position[1]!,
      speed: velocity[1]!,
      stalledTicks: velocity[2]!,
      propagatedParked: velocity[7]!,
      ...(head ? { activityKind: head.kind as string } : {}),
      activityCount: queue.length,
      ...(movement ? {
        waypointCursor: movement.cursor,
        waypointCount: movement.waypoints.length / 2,
        targetX: movement.waypoints[movement.cursor],
        targetY: movement.waypoints[movement.cursor + 1],
      } : {}),
    };
  });
  return {
    schemaVersion: 1,
    scenario,
    candidate: options.candidate.id,
    evidenceClass: options.evidenceClass,
    population,
    requestedTicks: ticks,
    finalTick: world.tick,
    frames: frame,
    wallClockMs,
    simulatedSeconds: world.tick / 30,
    initialMapHash,
    finalMapHash,
    finalWorldDigest,
    finalFullStateHash: milestones.at(-1)!.fullStateHash,
    milestones,
    pathRequests: requests,
    completions,
    units,
    crowdStates,
    movementDiagnostics: { ...diagnostics },
    scheduler: {
      blockedTicks: scheduler.blockedTicks,
      finalQueueDepth: scheduler.pendingCount,
      maxQueueDepth,
      meanQueueDepth: tickMetrics.reduce((sum, metric) => sum + metric.queueDepth, 0) / tickMetrics.length,
    },
    timing: {
      meanTickMs: tickWall.reduce((sum, value) => sum + value, 0) / tickWall.length,
      p95TickMs: percentile95(tickWall),
      maxTickMs: Math.max(...tickWall),
      totalApplyCostMs: applyCosts.reduce((sum, value) => sum + value, 0),
      maxApplyCostMs: applyCosts.length > 0 ? Math.max(...applyCosts) : 0,
    },
    mutations,
    ticks: tickMetrics,
    candidateMetrics: options.candidate.candidateMetrics?.() ?? {},
  };
}
