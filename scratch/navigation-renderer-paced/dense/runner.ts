import { readActivityQueue, spawnResourceNode, spawnUnit } from "../../../src/sim/components";
import { spawnCombatUnit, readCombatEvents } from "../../../src/sim/components/combat";
import { RESOURCE_WOOD } from "../../../src/sim/components/economy";
import { depositIntoStockpile } from "../../../src/sim/core/stockpile";
import { serializePrngState } from "../../../src/sim/core/prng";
import { computeWorldDigest, registerSystem, step, TICK_DT_MS } from "../../../src/sim/core/world";
import { layersHash } from "../../../src/sim/world/layers";
import { validatePlacement } from "../../../src/sim/systems/placement";
import { issueAttackMove, issueGather, issueGroupMove } from "../../../src/ui/orders";
import { createSkirmishWorld } from "./session";
import { createQueueCandidate, type QueueCandidate, type RequestIdentity } from "./adapter";
import type { CleanPathRequest } from "./clean-scheduler";
import type { QueuePolicy } from "./protocol";

export const DENSE_SEED = 20260822;
export interface DenseRunOptions {
  readonly policy: QueuePolicy;
  readonly ticks: number;
  readonly localWorkerDelayMs?: number;
  readonly rendererPaced: boolean;
  readonly waitFrame: () => Promise<number>;
  readonly createRender?: (session: ReturnType<typeof createSkirmishWorld>) => Promise<(now: number, alpha: number) => void>;
  readonly onProgress?: (tick: number, frames: number, pending: number) => void;
}
interface Metric {
  id: number; issueTick: number; dueTick: number; passableVersion: number;
  issueWallMs: number; responseMs?: number; responseFrame?: number; applyTick?: number;
  applyCostMs?: number; computeMs?: number; issueToApplyTicks?: number;
  outcome: "pending" | "applied" | "stale-discarded"; ok?: boolean;
  requestClass?: "leader" | "repath"; groupKey?: string; commandTick?: number;
}
interface PlannedLeader { tick: number; x: number; y: number; orderId: number; used: boolean; }
export interface FrameMetric {
  frame: number; tick: number; rafTimestampMs: number; frameIntervalMs: number;
  clampedDeltaMs: number; steps: number; blockedAttempts: number;
  simulationCpuMs: number; renderCpuMs: number; drawCalls: number; triangles: number;
}

async function hashWorld(world: ReturnType<typeof createSkirmishWorld>["world"]) {
  const worldDigest = computeWorldDigest(world); const mapHash = layersHash(world.layers);
  const canonical = JSON.stringify([world.tick, worldDigest, mapHash, serializePrngState(world.prng.getState())]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return { tick: world.tick, worldDigest, mapHash,
    fullStateHash: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("") };
}

export async function runDenseBenchmark(options: DenseRunOptions) {
  const planned: PlannedLeader[] = [];
  const metrics: Metric[] = []; const byId = new Map<number, Metric>();
  let frame = 0, boundaryTick = 1;
  function classify(request: CleanPathRequest): RequestIdentity {
    const issueTick = request.dueTick - 2;
    const order = planned.find((p) => !p.used && p.tick === issueTick &&
      Math.floor(p.x) === request.goalX && Math.floor(p.y) === request.goalY);
    if (order) { order.used = true; return { requestClass: "leader", groupKey: `order:${order.orderId}` }; }
    return { requestClass: "repath", groupKey: `unshared-repath:${request.id}` };
  }
  const activeCandidate = createQueueCandidate(options.policy, classify, options.localWorkerDelayMs === undefined
    ? undefined : (await import("./adapter")).createLocalQueueWorkerFactory(options.localWorkerDelayMs));
  const session = createSkirmishWorld(DENSE_SEED, {
    createTransport: () => activeCandidate.createTransport({
      onRequest(request, identity) {
        const metric: Metric = { id: request.id, issueTick: request.dueTick - 2, dueTick: request.dueTick,
          passableVersion: request.passableVersion, issueWallMs: performance.now(), outcome: "pending",
          requestClass: identity.requestClass, groupKey: identity.groupKey };
        if (identity.requestClass === "leader") metric.commandTick = request.dueTick - 2;
        metrics.push(metric); byId.set(request.id, metric);
      },
      onResponse(response, computeMs) {
        const metric = byId.get(response.id); if (!metric || metric.responseMs !== undefined) return;
        metric.responseMs = performance.now() - metric.issueWallMs;
        metric.responseFrame = frame; metric.computeMs = computeMs; metric.ok = response.ok;
      },
    }), aiDifficulty: "normal", aiStrategy: "fast-castle-knights", spawnRelics: true,
  });
  const { world, comps, scheduler } = session;
  const render = options.createRender ? await options.createRender(session) : undefined;
  const originalRequest = scheduler.requestPath.bind(scheduler);
  scheduler.requestPath = (input, requestOptions) => {
    let id = 0;
    const result = originalRequest(input, { ...requestOptions,
      onApply(response) {
        const started = performance.now();
        try { requestOptions.onApply(response); }
        finally { const m = byId.get(id); if (m) { m.outcome = "applied"; m.applyTick = boundaryTick;
          m.issueToApplyTicks = boundaryTick - m.issueTick; m.applyCostMs = performance.now() - started; m.ok = response.ok; } }
      },
      onDiscard() { requestOptions.onDiscard?.(); const m = byId.get(id); if (m) {
        m.outcome = "stale-discarded"; m.applyTick = boundaryTick; m.issueToApplyTicks = boundaryTick - m.issueTick; } },
    }); id = result; return result;
  };

  // Exactly 1,000 initial mobile units: 60% villagers, 20% friendly and 20% enemy soldiers.
  const villagers: number[] = [], friendly: number[] = [], enemy: number[] = [];
  const initialMobile = () => world.rowsByComponentId.get(comps.unitTagId)?.size ?? 0;
  for (const [eid] of world.rowsByComponentId.get(comps.unitTagId) ?? []) {
    if (world.rowsByComponentId.get(comps.combatId)?.has(eid)) {
      const owner = world.rowsByComponentId.get(comps.combatId)!.get(eid)![1];
      (owner === 0 ? friendly : enemy).push(eid);
    } else villagers.push(eid);
  }
  const open: Array<{ x: number; y: number }> = [];
  for (let y = 16; y < world.layers.size - 16; y += 1) for (let x = 16; x < world.layers.size - 16; x += 1) {
    if (world.layers.derivedPassability[y * world.layers.size + x] === 1) open.push({ x: x + 0.5, y: y + 0.5 });
  }
  if (open.length < 1400) throw new Error("dense map lacks open tiles");
  let cursor = 0;
  while (initialMobile() < 1000) {
    const n = initialMobile(); const p = open[(cursor * 37 + 101) % open.length]!; cursor += 1;
    const role = n % 5;
    if (role < 3) villagers.push(spawnUnit(world, comps, p.x, p.y, { ownerId: 0 }));
    else if (role === 3) friendly.push(spawnCombatUnit(world, comps, "militia", p.x, p.y, 0));
    else enemy.push(spawnCombatUnit(world, comps, "militia", p.x, p.y, 1));
  }
  const nodes: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    const p = open[(i * 71 + 503) % open.length]!;
    nodes.push(spawnResourceNode(world, comps, Math.floor(p.x), Math.floor(p.y), RESOURCE_WOOD, 100000));
  }
  depositIntoStockpile(world, comps, 0, RESOURCE_WOOD, 100000);

  // Representative repeated gathering, combat, movement, and placement commands.
  for (let i = 0; i < villagers.length; i += 1) {
    issueGather(world.inbox, 0, [villagers[i]!], nodes[i % nodes.length]!);
  }
  const mobileGroups = [friendly, enemy, villagers.slice(0, 100), villagers.slice(100, 200)];
  for (const [g, ids] of mobileGroups.entries()) {
    for (const tick of [30, 630, 1230, 1830, 2430, 3030]) {
      const p = open[(g * 911 + tick * 3 + 1709) % open.length]!;
      planned.push({ tick, x: p.x, y: p.y, orderId: planned.length + 1, used: false });
      if (g < 2) issueAttackMove(world.inbox, tick - 1, ids, p.x, p.y);
      else issueGroupMove(world.inbox, tick - 1, ids, p.x, p.y);
    }
  }
  // Direct battles ensure combat damage/death as well as attack-move path traffic.
  const pairs = Math.min(friendly.length, enemy.length);
  world.inbox.submit({ kind: "attack", targetTick: 90,
    data: { attackerIds: friendly.slice(0, pairs), targetId: enemy[0]! } });
  world.inbox.submit({ kind: "attack", targetTick: 91,
    data: { attackerIds: enemy.slice(0, pairs), targetId: friendly[0]! } });
  let placementsSubmitted = 0;
  const placementTicks = [300, 900, 1500, 2100, 2700, 3300];
  registerSystem(world, (current) => {
    const targetTick = current.tick + 1;
    if (!placementTicks.includes(targetTick)) return;
    for (let i = 0; i < open.length; i += 1) {
      const p = open[(i * 17 + targetTick) % open.length]!;
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (validatePlacement(current, comps, "house", x, y, 0).ok) {
        current.inbox.submit({ kind: "placeBuilding", targetTick,
          data: { defId: "house", tileX: x, tileY: y, playerId: 0 } });
        placementsSubmitted += 1; return;
      }
    }
    throw new Error(`no placement at ${targetTick}`);
  });

  const frames: FrameMetric[] = [], ticks: Array<{ tick: number; cpuMs: number; queueDepth: number; blockedTicks: number }> = [];
  const milestones = []; let accumulator = 0, lastFrame: number | undefined, previousRaf: number | undefined;
  const started = performance.now(); const maxFrames = options.ticks * 20 + 120;
  while (world.tick < options.ticks && frame < maxFrames) {
    const now = await options.waitFrame(); frame += 1;
    const rawDelta = lastFrame === undefined ? 0 : now - lastFrame; lastFrame = now;
    const clampedDelta = options.rendererPaced ? Math.min(Math.max(rawDelta, 0), 250) : TICK_DT_MS;
    accumulator += clampedDelta;
    let steps = 0, blockedAttempts = 0, simulationCpuMs = 0;
    while (accumulator >= TICK_DT_MS && steps < 5 && world.tick < options.ticks) {
      boundaryTick = world.tick + 1; const before = world.tick; const cpu = performance.now();
      step(world); simulationCpuMs += performance.now() - cpu;
      ticks.push({ tick: world.tick, cpuMs: performance.now() - cpu, queueDepth: scheduler.pendingCount, blockedTicks: scheduler.blockedTicks });
      if (world.tick === before) blockedAttempts += 1;
      accumulator -= TICK_DT_MS; steps += 1;
    }
    if (steps === 5 && accumulator > TICK_DT_MS) accumulator = 0;
    const renderStarted = performance.now(); render?.(now, Math.min(accumulator / TICK_DT_MS, 1));
    const renderCpuMs = performance.now() - renderStarted;
    const renderInfo = (globalThis as { __denseRenderInfo?: { calls: number; triangles: number } }).__denseRenderInfo;
    frames.push({ frame, tick: world.tick, rafTimestampMs: now,
      frameIntervalMs: previousRaf === undefined ? 0 : now - previousRaf,
      clampedDeltaMs: clampedDelta, steps, blockedAttempts, simulationCpuMs, renderCpuMs,
      drawCalls: renderInfo?.calls ?? 0, triangles: renderInfo?.triangles ?? 0 });
    previousRaf = now;
    if (world.tick % 600 === 0 && world.tick > 0 && milestones.at(-1)?.tick !== world.tick) milestones.push(await hashWorld(world));
    if (frame % 300 === 0) options.onProgress?.(world.tick, frame, scheduler.pendingCount);
  }
  const wallClockMs = performance.now() - started;
  if (world.tick !== options.ticks) throw new Error(`dense run stopped at ${world.tick}/${options.ticks}, frames ${frame}`);
  if (milestones.at(-1)?.tick !== world.tick) milestones.push(await hashWorld(world));
  const initialIds = [...villagers, ...friendly, ...enemy].sort((a, b) => a - b);
  const outcomes = initialIds.map((eid) => {
    if (!world.entities.includes(eid)) return { eid, outcome: "dead" as const };
    const queue = readActivityQueue(world, comps, eid);
    return { eid, outcome: queue.length === 0 ? "completed" as const : "active-at-cutoff" as const,
      activityKind: queue[0]?.kind ?? "idle" };
  });
  const combatEvents = [...readCombatEvents(world, comps, 0), ...readCombatEvents(world, comps, 1)];
  const protocol = activeCandidate.protocol();
  const result = {
    schema: "wayfinder-172-renderer-paced-dense-v1", policy: options.policy,
    rendererPaced: options.rendererPaced, pacing: options.rendererPaced
      ? "requestAnimationFrame; wall-delta clamp 250ms; fixed 30Hz accumulator; max 5 steps/frame; backlog shed"
      : "unpaced Node logical oracle; one fixed tick per microtask",
    seed: DENSE_SEED, requestedTicks: options.ticks, finalTick: world.tick, frameCount: frame, wallClockMs,
    workload: { initialMobileUnits: 1000, initialVillagers: villagers.length, initialFriendlySoldiers: friendly.length,
      initialEnemySoldiers: enemy.length, resourceNodes: nodes.length, gatherCommands: villagers.length,
      leaderOrders: planned.length, directAttackCommands: 2, placementCommands: placementsSubmitted,
      productionSystems: "full createSkirmishWorld roster including AI, movement, gather, placement, construction, combat, lifecycle and economy" },
    scheduler: { blockedTicks: scheduler.blockedTicks, finalQueueDepth: scheduler.pendingCount },
    finalFullStateHash: milestones.at(-1)!.fullStateHash, finalWorldDigest: milestones.at(-1)!.worldDigest,
    finalMapHash: milestones.at(-1)!.mapHash, milestones,
    requests: metrics.map(({ issueWallMs: _issueWallMs, ...m }) => ({ ...m })), frames, ticks,
    outcomes, outcomeCounts: outcomes.reduce<Record<string, number>>((counts, o) => {
      counts[o.outcome] = (counts[o.outcome] ?? 0) + 1; return counts; }, {}),
    combat: { eventCount: combatEvents.length, damageEvents: combatEvents.filter((e) => e.kind === 0).length,
      deathEvents: combatEvents.filter((e) => e.kind === 1).length },
    candidateMetrics: activeCandidate.telemetry(), protocol,
  };
  activeCandidate.dispose();
  return result;
}
