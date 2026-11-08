/**
 * #164 scaling probe: the M3 deep-sim village at N named Pops, with a
 * per-system wall-time breakdown. Usage:
 *   npx tsx scratch/deep-sim-workloads/scaling.ts 300 1000 2000
 * Prints one JSON line per population to stdout.
 */
import { buildingDefOf } from "../../src/data/definitions";
import {
  populationOf,
  spawnResourceNode,
  spawnUnit,
} from "../../src/sim/components";
import {
  RESOURCE_FOOD,
  RESOURCE_WOOD,
} from "../../src/sim/components/economy";
import { PLAYER_ONE } from "../../src/sim/core/stockpile";
import { step } from "../../src/sim/core/world";
import { createSkirmishWorld } from "../../src/game/session";
import { createSynchronousPathTransport } from "../../src/sim/path/scheduler";
import { scatterResourceNodes } from "../../src/sim/mapgen/resources";
import {
  M3_BUDGET_CLOCK,
  spawnRinged,
  stampVillageBuilding,
} from "../../tests/helpers/budget-scenario-m3";
import { captureSimSnapshot } from "../../src/sim/mirror";
void buildingDefOf;

const WARMUP = 150;
const MEASURED = 600;

function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

function run(pops: number): void {
  const session = createSkirmishWorld(20260902, {
    createTransport: createSynchronousPathTransport,
    lifecycleConfig: M3_BUDGET_CLOCK,
  });
  const { world, comps } = session;
  for (const ledger of world.rowsByComponentId.get(comps.stockpileId)!.values()) {
    [4000, 4000, 500, 0, 0, 0, 0].forEach((v, i) => (ledger[i + 1] = v));
  }
  let anchor = { x: 0, y: 0 };
  for (const eid of world.entities) {
    const row = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (!row || row[0] !== PLAYER_ONE) continue;
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!pos) continue;
    anchor = { x: pos[0]!, y: pos[1]! };
    break;
  }
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const houses = Math.max(4, Math.ceil(pops / 6));
  const defs = [
    ...Array<string>(Math.min(houses, 12)).fill("house"),
    "school",
    "church",
    "tavern",
  ];
  for (const d of defs) {
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
      world.layers.derivedPassability[n.tileY * world.layers.size + n.tileX] ===
        1 &&
      Math.max(
        Math.abs(n.tileX - Math.floor(anchor.x)),
        Math.abs(n.tileY - Math.floor(anchor.y)),
      ) > 6,
  );
  const nodeIds = nodes.map((n, i) =>
    spawnResourceNode(
      world,
      comps,
      n.tileX,
      n.tileY,
      i % 2 === 0 ? RESOURCE_FOOD : RESOURCE_WOOD,
      n.amount * 40,
    ),
  );
  const ids: number[] = [];
  spawnRinged(world, comps, anchor.x, anchor.y, pops, 2, (x, y) => {
    ids.push(
      spawnUnit(world, comps, x, y, {
        ownerId: PLAYER_ONE,
        identity: true,
        body: true,
        morale: true,
      }),
    );
  });
  for (let f = 0; f < pops; f += 10) {
    world.inbox.submit({
      kind: "gather",
      targetTick: world.tick + 1,
      data: {
        entityIds: ids.slice(f, f + 10),
        nodeId: nodeIds[(f / 10) % nodeIds.length]!,
      },
    });
  }

  const systems = world.systems as unknown as ((...a: unknown[]) => void)[];
  const perSystem = systems.map(() => 0);
  const wrapped = systems.map((fn, i) => (...a: unknown[]) => {
    const s = performance.now();
    fn(...a);
    perSystem[i] = perSystem[i]! + (performance.now() - s);
  });
  const original = [...systems];
  for (let i = 0; i < WARMUP; i++) step(world);
  for (let i = 0; i < systems.length; i++) systems[i] = wrapped[i]!;
  perSystem.fill(0);

  const samples: number[] = [];
  for (let i = 0; i < MEASURED; i++) {
    const s = performance.now();
    step(world);
    samples.push(performance.now() - s);
  }
  const NAMES = [
    "movement", "gather", "placement", "construction", "training",
    "production", "age", "combat", "injuries", "skills", "equipment",
    "victory", "needs", "lifecycle", "households", "school", "knowledge",
    "culture", "relics", "market", "mass", "social", "morale",
    "schedules", "popbrain", "management", "companies", "aiPlanner",
    "scenario",
  ];
  const names = original.map((_, i) => `${String(i)}:${NAMES[i] ?? "?"}`);
  const top = perSystem
    .map((t, i) => ({ system: names[i]!, meanMs: +(t / MEASURED).toFixed(4) }))
    .sort((a, b) => b.meanMs - a.meanMs)
    .slice(0, 8);
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  let frame = captureSimSnapshot(world, comps);
  captureSimSnapshot(world, comps, { reusable: frame });
  let mirror = Infinity;
  for (let k = 0; k < 5; k++) {
    const s = performance.now();
    frame = captureSimSnapshot(world, comps, { reusable: frame });
    mirror = Math.min(mirror, performance.now() - s);
  }
  console.log(
    JSON.stringify({
      requested: pops,
      spawned: ids.length,
      populationEnd: populationOf(world, comps, PLAYER_ONE),
      entities: world.entities.size,
      measuredTicks: MEASURED,
      meanMs: +mean.toFixed(3),
      p50Ms: +pct(samples, 0.5).toFixed(3),
      p95Ms: +pct(samples, 0.95).toFixed(3),
      p99Ms: +pct(samples, 0.99).toFixed(3),
      maxMs: +samples[samples.length - 1]!.toFixed(3),
      mirrorCopyMs: +mirror.toFixed(3),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      topSystems: top,
    }),
  );
}

for (const arg of process.argv.slice(2)) run(Number.parseInt(arg, 10));
