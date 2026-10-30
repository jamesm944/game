/**
 * #164 completion probe: W1 tail attribution, W2 combat+fog scaling,
 * isolated PopBrain/fog scaling laws, input latency, memory + snapshot
 * bytes. Run with: npx tsx --expose-gc scratch/deep-sim-workloads/workloads.ts <mode> [args]
 * Modes: tail <pops> | combat <villagers> <knightsPerSide> |
 *        brain <pops> <nodes> | fog <contributors> <size> | latency <pops>
 * Prints one JSON line per run. CPU ms comes from process.cpuUsage so a
 * loaded machine inflates wall percentiles far more than CPU means.
 */
import { spawnResourceNode, spawnUnit } from "../../src/sim/components";
import { spawnCombatUnit } from "../../src/sim/components/combat";
import {
  RESOURCE_FOOD,
  RESOURCE_WOOD,
} from "../../src/sim/components/economy";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
import { step } from "../../src/sim/core/world";
import { AI_PLAYER } from "../../src/sim/ai/bootstrap";
import { createSkirmishWorld } from "../../src/game/session";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import { scatterResourceNodes } from "../../src/sim/mapgen/resources";
import { createFogVisibility } from "../../src/sim/systems/fog";
import {
  M3_BUDGET_CLOCK,
  spawnRinged,
  stampVillageBuilding,
} from "../../tests/helpers/budget-scenario-m3";
import { captureSimSnapshot } from "../../src/sim/mirror";

const NAMES = [
  "movement", "gather", "placement", "construction", "training",
  "production", "age", "combat", "injuries", "skills", "equipment",
  "victory", "needs", "lifecycle", "households", "school", "knowledge",
  "culture", "relics", "market", "mass", "social", "morale",
  "schedules", "popbrain", "management", "companies", "aiPlanner",
  "scenario",
];

function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3),
    p50: +pct(s, 0.5).toFixed(3),
    p95: +pct(s, 0.95).toFixed(3),
    p99: +pct(s, 0.99).toFixed(3),
    max: +s[s.length - 1]!.toFixed(3),
  };
}
/** Fixed pure-JS spin kernel: load calibration (perf-baseline-2026-10). */
function calibrateMs(): number {
  let acc = 0;
  const t0 = performance.now();
  for (let i = 0; i < 2_000_000; i++) acc += Math.sqrt(i % 97) * 1.0001;
  if (acc < 0) throw new Error("unreachable");
  return +(performance.now() - t0).toFixed(2);
}
function memNow() {
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  return {
    heapMB: +(m.heapUsed / 1048576).toFixed(1),
    rssMB: +(m.rss / 1048576).toFixed(1),
  };
}
function townAnchor(
  world: { entities: Set<number>; rowsByComponentId: Map<number, Map<number, number[]>> },
  comps: { buildingId: number; positionId: number },
  player: number,
): { x: number; y: number } {
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (!row || row[0] !== player) continue;
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (pos) return { x: pos[0]!, y: pos[1]! };
  }
  throw new Error("no building anchor");
}

/** Build the scaled M3 deep-Pop village (same recipe as scaling.ts). */
function buildVillage(pops: number) {
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
    lifecycleConfig: M3_BUDGET_CLOCK,
  });
  const { world, comps } = session;
  for (const ledger of world.rowsByComponentId.get(comps.stockpileId)!.values()) {
    [4000, 4000, 500, 0, 0, 0, 0].forEach((v, i) => (ledger[i + 1] = v));
  }
  const anchor = townAnchor(world, comps, PLAYER_ONE);
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const houses = Math.max(4, Math.ceil(pops / 6));
  for (const d of [
    ...Array<string>(Math.min(houses, 12)).fill("house"),
    "school", "church", "tavern",
  ]) {
    try {
      stampVillageBuilding(world, comps, d, anchor.x, anchor.y, rects);
    } catch {
      break;
    }
  }
  const nodeCount = Math.max(60, Math.ceil(pops / 5));
  const nodes = scatterResourceNodes(world.layers, 0x51ed270b, {
    count: nodeCount,
    minSpacing: 3,
  }).filter(
    (n) =>
      world.layers.derivedPassability[n.tileY * world.layers.size + n.tileX] === 1 &&
      Math.max(
        Math.abs(n.tileX - Math.floor(anchor.x)),
        Math.abs(n.tileY - Math.floor(anchor.y)),
      ) > 6,
  );
  const nodeIds = nodes.map((n, i) =>
    spawnResourceNode(world, comps, n.tileX, n.tileY,
      i % 2 === 0 ? RESOURCE_FOOD : RESOURCE_WOOD, n.amount * 40),
  );
  const ids: number[] = [];
  spawnRinged(world, comps, anchor.x, anchor.y, pops, 2, (x, y) => {
    ids.push(spawnUnit(world, comps, x, y, {
      ownerId: PLAYER_ONE, identity: true, body: true, morale: true,
    }));
  });
  for (let f = 0; f < pops; f += 10) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: { entityIds: ids.slice(f, f + 10), nodeId: nodeIds[(f / 10) % nodeIds.length]! },
    });
  }
  return { session, world, comps, ids, nodeIds };
}

/** Wrap every system + the fog flush; returns per-tick cost matrix. */
function instrument(world: ReturnType<typeof buildVillage>["world"]) {
  const systems = world.systems as unknown as ((...a: unknown[]) => void)[];
  const n = systems.length;
  const matrix: Float64Array[] = [];
  let row = new Float64Array(n + 1); // last slot = fog flush
  const wrapped = systems.map((fn, i) => (...a: unknown[]) => {
    const s = performance.now();
    fn(...a);
    row[i] = row[i]! + (performance.now() - s);
  });
  const vis = world.visibility as unknown as { flushDirty: () => void };
  const origFlush = vis.flushDirty.bind(vis);
  vis.flushDirty = () => {
    const s = performance.now();
    origFlush();
    row[n] = row[n]! + (performance.now() - s);
  };
  return {
    install() {
      for (let i = 0; i < n; i++) systems[i] = wrapped[i]!;
    },
    beginTick() {
      row = new Float64Array(n + 1);
    },
    endTick() {
      matrix.push(row);
    },
    matrix,
    count: n,
  };
}

function topSystems(matrix: Float64Array[], n: number, k = 6) {
  const totals = new Float64Array(n + 1);
  for (const r of matrix) for (let i = 0; i <= n; i++) totals[i] = totals[i]! + r[i]!;
  return [...totals]
    .map((t, i) => ({
      system: i === n ? "fogFlush" : NAMES[i] ?? String(i),
      meanMs: +(t / matrix.length).toFixed(4),
    }))
    .sort((a, b) => b.meanMs - a.meanMs)
    .slice(0, k);
}

function snapshotBytes(world: never, comps: never) {
  const frame = captureSimSnapshot(world, comps);
  const c = frame.count;
  const logical =
    c * 4 + // eids Int32
    c * 8 + // positions 2xFloat32
    c * 4 + // headings
    c * 4 + // hpFractions
    (frame.defCodes ? c : 0) +
    (frame.activityCodes ? c : 0) +
    (frame.ownerIds ? c : 0);
  return { count: c, logicalBytes: logical };
}

function runTail(pops: number): void {
  const { world, comps } = buildVillage(pops);
  for (let i = 0; i < 150; i++) step(world);
  const inst = instrument(world);
  inst.install();
  const wall: number[] = [];
  const cpu: number[] = [];
  const tickNos: number[] = [];
  const MEASURED = 600;
  for (let i = 0; i < MEASURED; i++) {
    inst.beginTick();
    const c0 = process.cpuUsage();
    const s = performance.now();
    step(world);
    const w = performance.now() - s;
    const c = process.cpuUsage(c0);
    inst.endTick();
    wall.push(w);
    cpu.push((c.user + c.system) / 1000);
    tickNos.push(world.tick);
  }
  // Worst-30 ticks by CPU (load-resistant): attribute by dominant system.
  const order = cpu.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const worst = order.slice(0, 30).map(([cpuMs, i]) => {
    const r = inst.matrix[i]!;
    let dom = 0;
    for (let j = 1; j < r.length; j++) if (r[j]! > r[dom]!) dom = j;
    return {
      tick: tickNos[i]!,
      tickModDay: tickNos[i]! % M3_BUDGET_CLOCK.dayTicks,
      wallMs: +wall[i]!.toFixed(2),
      cpuMs: +cpuMs.toFixed(2),
      dominant: dom === inst.count ? "fogFlush" : NAMES[dom],
      dominantMs: +r[dom]!.toFixed(2),
    };
  });
  const domCounts: Record<string, number> = {};
  for (const w of worst) domCounts[w.dominant!] = (domCounts[w.dominant!] ?? 0) + 1;
  let frame = captureSimSnapshot(world, comps);
  const mirrorSamples: number[] = [];
  for (let k = 0; k < 11; k++) {
    const s = performance.now();
    frame = captureSimSnapshot(world, comps, { reusable: frame });
    mirrorSamples.push(performance.now() - s);
  }
  console.log(JSON.stringify({
    mode: "tail", pops, entities: world.entities.size,
    mapSize: world.layers.size, calibMs: calibrateMs(),
    wall: stats(wall), cpu: stats(cpu),
    topSystems: topSystems(inst.matrix, inst.count),
    worstDomCounts: domCounts, worst10: worst.slice(0, 10),
    mirror: stats(mirrorSamples),
    snapshot: snapshotBytes(world as never, comps as never),
    mem: memNow(),
  }));
}

function runCombat(villagers: number, knightsPerSide: number): void {
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
  });
  const { world, comps } = session;
  for (const ledger of world.rowsByComponentId.get(comps.stockpileId)!.values()) {
    [6000, 6000, 2000, 0, 0, 0, 0].forEach((v, i) => (ledger[i + 1] = v));
  }
  const pTown = townAnchor(world, comps, PLAYER_ONE);
  const aTown = townAnchor(world, comps, AI_PLAYER);
  const nodes = scatterResourceNodes(world.layers, 0x1234abcd, {
    count: Math.max(40, Math.ceil(villagers / 8)),
    minSpacing: 3,
  }).filter(
    (n) =>
      world.layers.derivedPassability[n.tileY * world.layers.size + n.tileX] === 1 &&
      Math.max(Math.abs(n.tileX - Math.floor(pTown.x)), Math.abs(n.tileY - Math.floor(pTown.y))) > 6,
  );
  const nodeIds = nodes.map((n) =>
    spawnResourceNode(world, comps, n.tileX, n.tileY, RESOURCE_WOOD, n.amount * 40));
  const vIds: number[] = [];
  spawnRinged(world, comps, pTown.x, pTown.y, villagers, 2, (x, y) => {
    vIds.push(spawnUnit(world, comps, x, y));
  });
  for (let f = 0; f < villagers; f += 10) {
    world.inbox.submit({ kind: "gather", targetTick: world.tick + 1,
      data: { entityIds: vIds.slice(f, f + 10), nodeId: nodeIds[(f / 10) % nodeIds.length]! } });
  }
  const pk: number[] = [];
  const ak: number[] = [];
  spawnRinged(world, comps, pTown.x, pTown.y, knightsPerSide, 14, (x, y) => {
    pk.push(spawnCombatUnit(world, comps, "knight", x, y, PLAYER_ONE));
  });
  spawnRinged(world, comps, aTown.x, aTown.y, knightsPerSide, 2, (x, y) => {
    ak.push(spawnCombatUnit(world, comps, "knight", x, y, AI_PLAYER));
  });
  const living = (eids: number[]) =>
    eids.filter((eid) => world.rowsByComponentId.get(comps.combatId)?.has(eid));
  const centroid = (eids: number[]) => {
    let sx = 0, sy = 0, n = 0;
    for (const eid of eids) {
      const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      if (pos) { sx += pos[0]!; sy += pos[1]!; n++; }
    }
    return n ? { x: sx / n, y: sy / n } : undefined;
  };
  const issue = () => {
    const lp = living(pk), la = living(ak);
    const tp = centroid(la), ta = centroid(lp);
    if (tp && lp.length) world.inbox.submit({ kind: "attackMove", targetTick: world.tick + 1, data: { ids: lp, x: tp.x, y: tp.y } });
    if (ta && la.length) world.inbox.submit({ kind: "attackMove", targetTick: world.tick + 1, data: { ids: la, x: ta.x, y: ta.y } });
  };
  for (let i = 0; i < 120; i++) { if (world.tick % 45 === 0) issue(); step(world); }
  const inst = instrument(world);
  inst.install();
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let i = 0; i < 300; i++) {
    if (world.tick % 45 === 0) issue();
    inst.beginTick();
    const c0 = process.cpuUsage();
    const s = performance.now();
    step(world);
    wall.push(performance.now() - s);
    const c = process.cpuUsage(c0);
    cpu.push((c.user + c.system) / 1000);
    inst.endTick();
  }
  console.log(JSON.stringify({
    mode: "combat", villagers, knightsPerSide,
    entities: world.entities.size, mapSize: world.layers.size,
    calibMs: calibrateMs(), wall: stats(wall), cpu: stats(cpu),
    topSystems: topSystems(inst.matrix, inst.count),
    survivors: [living(pk).length, living(ak).length],
    snapshot: snapshotBytes(world as never, comps as never),
    mem: memNow(),
  }));
}

function runFog(contributors: number, size: number): void {
  const fog = createFogVisibility(size, 2);
  const entities = Array.from({ length: contributors }, (_, i) => ({
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
    // Fresh copy per resolve, like production createRowEntityResolver.
    // Returning the mutated entity itself (as tests/perf/fog.test.ts
    // does) makes sameStamp(previous, current) compare an object to
    // itself, so every re-stamp is skipped and only queue overhead is
    // measured.
    resolve: (eid: number) => ({ ...entities[eid - 1]! }),
    eidsAscending: () => entities.map((e) => e.eid),
  });
  const r0 = performance.now();
  fog.recomputeAll();
  const recomputeMs = +(performance.now() - r0).toFixed(3);
  const flushAll = () => {
    for (const e of entities) {
      e.tileX = (e.tileX + 1) % size;
      fog.provider.markDirty("moved", e.eid);
    }
    fog.provider.flushDirty();
  };
  for (let i = 0; i < 20; i++) flushAll();
  const samples: number[] = [];
  const c0 = process.cpuUsage();
  for (let i = 0; i < 200; i++) {
    const s = performance.now();
    flushAll();
    samples.push(performance.now() - s);
  }
  const c = process.cpuUsage(c0);
  console.log(JSON.stringify({
    mode: "fog", contributors, size, calibMs: calibrateMs(),
    wall: stats(samples), recomputeAllMs: recomputeMs,
    cpuMeanMs: +(((c.user + c.system) / 1000) / 200).toFixed(3),
    usPerContributor: +((stats(samples).mean * 1000) / contributors).toFixed(2),
    planeBytes: 2 * size * size * 4, // explored u8 + visible u8 + count u16
  }));
}

/** Isolated PopBrain: flat world, brain only (popbrain-budget pattern). */
async function runBrain(pops: number, nodes: number): Promise<void> {
  const { defineSimComponents, spawnUnit: su, spawnResourceNode: srn } =
    await import("../../src/sim/components");
  const { createPlayerStockpile } = await import("../../src/sim/core/stockpile");
  const { createWorld, registerSystem, step: st } = await import("../../src/sim/core/world");
  const { TERRAIN_GRASS, buildLayers } = await import("../../src/sim/world/layers");
  const { createPopBrainDiagnostics, createPopBrainSystem } =
    await import("../../src/sim/ai/popBrain");
  const SIZE = 256;
  const world = createWorld(20260906, {
    size: SIZE,
    layers: buildLayers(
      new Uint8Array(SIZE * SIZE).fill(TERRAIN_GRASS),
      new Uint8Array(SIZE * SIZE),
    ),
  });
  const comps = defineSimComponents(world);
  const brain = createPopBrainDiagnostics();
  registerSystem(world, createPopBrainSystem({ comps, players: [PLAYER_ONE], diagnostics: brain }));
  createPlayerStockpile(world, comps, PLAYER_ONE, [5000, 5000, 1000, 0, 0, 0, 0]);
  for (let i = 0; i < nodes; i++) {
    srn(world, comps, 20 + (i % 100), 20 + Math.floor(i / 100), i % 7, 9999);
  }
  for (let i = 0; i < pops; i++) {
    su(world, comps, 12 + (i % 100), 120 + Math.floor(i / 100), { identity: true });
  }
  for (let i = 0; i < 60; i++) st(world);
  const thinks0 = brain.thinks;
  const samples: number[] = [];
  const c0 = process.cpuUsage();
  for (let i = 0; i < 300; i++) {
    const s = performance.now();
    st(world);
    samples.push(performance.now() - s);
  }
  const c = process.cpuUsage(c0);
  const thinks = brain.thinks - thinks0;
  console.log(JSON.stringify({
    mode: "brain", pops, nodes, calibMs: calibrateMs(),
    wall: stats(samples),
    cpuMeanMs: +(((c.user + c.system) / 1000) / 300).toFixed(3),
    thinksPerTick: +(thinks / 300).toFixed(1),
    usPerThink: +((stats(samples).mean * 1000) / (thinks / 300)).toFixed(2),
    scoresPerTick: Math.round((thinks / 300) * nodes),
    mem: memNow(),
  }));
}

/**
 * Input latency: submit a gather order (targetTick = tick+1, the only
 * legal form — inbox throws on late commands), then count ticks until
 * (a) the AssignedNode row exists (command applied) and (b) the mirror
 * snapshot shows ACTIVITY_WALK (effect visible to the renderer).
 */
function runLatency(pops: number): void {
  const { world, comps, nodeIds } = buildVillage(pops);
  for (let i = 0; i < 300; i++) step(world);
  const toApplied: number[] = [];
  const toVisible: number[] = [];
  const wallMs: number[] = [];
  let frame = captureSimSnapshot(world, comps);
  const anchor = townAnchor(world, comps, PLAYER_ONE);
  const size = world.layers.size;
  // First passable tiles ring-scanned from the town: fresh-probe spawn
  // points (a newly spawned unit is idle and static by construction).
  const spawnTiles: { x: number; y: number }[] = [];
  outer: for (let ring = 30; ring < 60; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = Math.floor(anchor.x) + dx;
        const y = Math.floor(anchor.y) + dy;
        if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) continue;
        if (world.layers.derivedPassability[y * size + x] !== 1) continue;
        spawnTiles.push({ x: x + 0.5, y: y + 0.5 });
        if (spawnTiles.length >= 20) break outer;
      }
    }
  }
  for (let probe = 0; probe < spawnTiles.length; probe++) {
    const tile = spawnTiles[probe]!;
    const target = spawnUnit(world, comps, tile.x, tile.y, {
      ownerId: PLAYER_ONE, identity: true, body: true, morale: true,
    });
    step(world); // settle spawn (fog stamp, brain registration)
    frame = captureSimSnapshot(world, comps, { reusable: frame });
    const rank0 = frame.eids.indexOf(target);
    if (rank0 < 0) continue;
    const baseX = frame.positions[2 * rank0]!;
    const baseY = frame.positions[2 * rank0 + 1]!;
    const nodeId = nodeIds[(probe * 7) % nodeIds.length]!;
    const submitTick = world.tick;
    world.inbox.submit({ kind: "gather", targetTick: submitTick + 1,
      data: { entityIds: [target], nodeId } });
    let appliedAt = -1;
    let visibleAt = -1;
    let wall = 0;
    for (let t = 0; t < 90 && visibleAt < 0; t++) {
      const s = performance.now();
      step(world);
      frame = captureSimSnapshot(world, comps, { reusable: frame });
      wall += performance.now() - s;
      if (appliedAt < 0 && world.rowsByComponentId.get(comps.assignedNodeId)?.get(target)?.[0] === nodeId) {
        appliedAt = world.tick - submitTick;
      }
      const rank = frame.eids.indexOf(target);
      if (rank >= 0) {
        const moved =
          Math.abs(frame.positions[2 * rank]! - baseX) +
            Math.abs(frame.positions[2 * rank + 1]! - baseY) > 0.001;
        if (moved || (frame.activityCodes?.[rank] ?? 0) !== 0) {
          visibleAt = world.tick - submitTick;
        }
      }
    }
    if (appliedAt >= 0) toApplied.push(appliedAt);
    if (visibleAt >= 0) { toVisible.push(visibleAt); wallMs.push(+wall.toFixed(2)); }
    for (let i = 0; i < 10; i++) step(world);
  }
  console.log(JSON.stringify({
    mode: "latency", pops, calibMs: calibrateMs(),
    probesApplied: toApplied.length, probesVisible: toVisible.length,
    ticksToApplied: toApplied.length ? stats(toApplied) : null,
    ticksToVisible: toVisible.length ? stats(toVisible) : null,
    wallMsToVisible: wallMs.length ? stats(wallMs) : null,
    noteMsPerTickAt30Hz: 33.33,
  }));
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "tail") runTail(Number(a));
else if (mode === "combat") runCombat(Number(a), Number(b));
else if (mode === "fog") runFog(Number(a), Number(b));
else if (mode === "brain") await runBrain(Number(a), Number(b));
else if (mode === "latency") runLatency(Number(a));
else throw new Error(`unknown mode ${String(mode)}`);
