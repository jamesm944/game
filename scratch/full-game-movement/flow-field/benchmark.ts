/**
 * Reproducible Node-only flow-field microbenchmark. No browser, full-game,
 * worker, steering, or crowd claims are supported by this harness.
 *
 * Run: ./node_modules/.bin/tsx scratch/full-game-movement/flow-field/benchmark.ts
 */
import { cpus, arch, platform, totalmem } from "node:os";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { findPath } from "../../../src/sim/path/astar";
import {
  buildFlowField,
  FlowFieldCache,
  FLOW_UNREACHABLE,
  type FlowField,
  type FlowTile,
} from "./flow-field";

const WIDTH = 120;
const HEIGHT = 120;
const AGENT_COUNT = 256;
const GOAL_COUNT = 8;
const MUTATION_COUNT = 8;
const DEFAULT_ROUNDS = 9;
const WARMUP_ROUNDS = 2;
const QUERY_REPETITIONS = 100;
const ROUTE_REPETITIONS = 10;

type MapKind = "open" | "maze" | "choke";

interface Grid {
  readonly width: number;
  readonly height: number;
  readonly passability: Uint8Array;
}

interface Agent {
  readonly x: number;
  readonly y: number;
  readonly goal: number;
}

interface BenchmarkMap {
  readonly kind: MapKind;
  readonly grid: Grid;
  readonly agents: readonly Agent[];
  readonly goals: readonly FlowTile[];
  readonly mutationTiles: readonly number[];
}

interface Summary {
  readonly samplesMs: readonly number[];
  readonly meanMs: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly batchMeanMs: number;
  readonly perAgentMeanNs: number | null;
}

interface Measurement {
  readonly operation: string;
  readonly rounds: number;
  readonly repetitionsPerSample: number;
  readonly agentsPerBatch: number | null;
  readonly digest: number;
  readonly summary: Summary;
}

function makeMap(kind: MapKind): Grid {
  const passability = new Uint8Array(WIDTH * HEIGHT);
  if (kind === "open") {
    passability.fill(1);
  } else if (kind === "choke") {
    passability.fill(1);
    for (const wallX of [40, 80]) {
      for (let y = 0; y < HEIGHT; y++) {
        if (y % 24 !== 12) passability[y * WIDTH + wallX] = 0;
      }
    }
    for (let x = 1; x < WIDTH - 1; x++) {
      if (x % 20 !== 10) passability[60 * WIDTH + x] = 0;
    }
  } else {
    // Iterative recursive-backtracker maze on odd coordinates. The direction
    // rotations are fixed; no random source or platform-dependent ordering.
    const stack = [1 + WIDTH];
    passability[1 + WIDTH] = 1;
    const offsets = [2, 2 * WIDTH, -2, -2 * WIDTH];
    const between = [1, WIDTH, -1, -WIDTH];
    while (stack.length > 0) {
      const current = stack[stack.length - 1]!;
      const x = current % WIDTH;
      const y = Math.floor(current / WIDTH);
      let carved = false;
      for (let d = 0; d < 4; d++) {
        const direction = (d + (x + y) % 4) % 4;
        const next = current + offsets[direction]!;
        const nx = next % WIDTH;
        const ny = Math.floor(next / WIDTH);
        if (nx <= 0 || nx >= WIDTH - 1 || ny <= 0 || ny >= HEIGHT - 1) continue;
        if (passability[next] === 1) continue;
        passability[current + between[direction]!] = 1;
        passability[next] = 1;
        stack.push(next);
        carved = true;
        break;
      }
      if (!carved) stack.pop();
    }
    // Deterministically open selected wall tiles to create alternate routes.
    for (let y = 1; y < HEIGHT - 1; y++) {
      for (let x = 1; x < WIDTH - 1; x++) {
        const node = y * WIDTH + x;
        if (passability[node] === 0 && (x * 73 + y * 151) % 29 === 0) {
          passability[node] = 1;
        }
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, passability };
}

function selectTiles(grid: Grid, count: number, salt: number): number[] {
  const walkable: number[] = [];
  for (let node = 0; node < grid.passability.length; node++) {
    if (grid.passability[node] === 1) walkable.push(node);
  }
  if (walkable.length < count) throw new Error("not enough walkable benchmark tiles");
  const selected: number[] = [];
  // Coprime-ish strides spread agents/goals without random draws. Collision
  // probing is linear and therefore reproducible across JS engines.
  let cursor = salt % walkable.length;
  const stride = 37 + salt * 2;
  while (selected.length < count) {
    const node = walkable[cursor]!;
    if (!selected.includes(node)) selected.push(node);
    cursor = (cursor + stride) % walkable.length;
  }
  return selected;
}

function prepareMap(kind: MapKind): BenchmarkMap {
  const grid = makeMap(kind);
  const agentTiles = selectTiles(grid, AGENT_COUNT, kind === "open" ? 3 : kind === "maze" ? 5 : 7);
  const goalTiles = selectTiles(grid, GOAL_COUNT, kind === "open" ? 11 : kind === "maze" ? 13 : 17);
  const goals = goalTiles.map((node) => ({ x: node % WIDTH, y: Math.floor(node / WIDTH) }));
  const agents = agentTiles.map((node, index) => ({
    x: node % WIDTH,
    y: Math.floor(node / WIDTH),
    goal: index % GOAL_COUNT,
  }));
  const goalSet = new Set(goalTiles);
  const mutationTiles: number[] = [];
  for (let node = 0; mutationTiles.length < MUTATION_COUNT; node++) {
    if (!goalSet.has(node) && (node * 31 + 17) % 101 < 3) mutationTiles.push(node);
    if (node >= grid.passability.length) throw new Error("not enough mutation candidates");
  }
  return { kind, grid, agents, goals, mutationTiles };
}

function summarize(samples: readonly number[], repetitions: number, agents: number | null): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const batchMeanMs = mean / repetitions;
  return {
    samplesMs: samples,
    meanMs: mean,
    medianMs: median,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    batchMeanMs,
    perAgentMeanNs: agents === null ? null : batchMeanMs * 1e6 / agents,
  };
}

function measure(
  operation: string,
  rounds: number,
  repetitions: number,
  agents: number | null,
  run: () => number,
): Measurement {
  let digest = 0;
  for (let warmup = 0; warmup < WARMUP_ROUNDS; warmup++) digest ^= run();
  const samples: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    for (let repetition = 0; repetition < repetitions; repetition++) digest ^= run();
    samples.push(performance.now() - started);
  }
  return {
    operation,
    rounds,
    repetitionsPerSample: repetitions,
    agentsPerBatch: agents,
    digest,
    summary: summarize(samples, repetitions, agents),
  };
}

function runAStarBatch(map: BenchmarkMap): number {
  let digest = 0;
  for (const agent of map.agents) {
    const goal = map.goals[agent.goal]!;
    const result = findPath({
      passability: map.grid.passability,
      width: WIDTH,
      startX: agent.x,
      startY: agent.y,
      goalX: goal.x,
      goalY: goal.y,
    });
    digest = (digest + (result === null ? -1 : result.cost)) | 0;
  }
  return digest;
}

function buildFields(map: BenchmarkMap): FlowField[] {
  return map.goals.map((goal) => buildFlowField({
    passability: map.grid.passability,
    width: WIDTH,
    goals: [goal],
  }));
}

function queryFields(map: BenchmarkMap, fields: readonly FlowField[]): number {
  let digest = 0;
  for (const agent of map.agents) {
    const field = fields[agent.goal]!;
    digest = (digest + field.costAt(agent.x, agent.y) + field.directionAt(agent.x, agent.y) + 2) | 0;
  }
  return digest;
}

function traceRoutes(map: BenchmarkMap, fields: readonly FlowField[]): number {
  let digest = 0;
  for (const agent of map.agents) {
    const route = fields[agent.goal]!.traceRoute(agent.x, agent.y);
    digest = (digest + (route === null ? -1 : route.cost + route.tiles.length)) | 0;
  }
  return digest;
}

function mutationMaps(map: BenchmarkMap): Uint8Array[] {
  const snapshots: Uint8Array[] = [];
  let current = map.grid.passability.slice();
  for (const node of map.mutationTiles) {
    current = current.slice();
    current[node] = current[node] === 1 ? 0 : 1;
    snapshots.push(current);
  }
  return snapshots;
}

function runFlowMutations(map: BenchmarkMap, snapshots: readonly Uint8Array[]): number {
  const cache = new FlowFieldCache(map.grid.passability, WIDTH, 0, GOAL_COUNT);
  let digest = 0;
  for (let revision = 0; revision < snapshots.length; revision++) {
    cache.updatePassability(snapshots[revision]!, revision + 1);
    const fields = map.goals.map((goal) => cache.getField([goal]));
    digest ^= queryFields(map, fields);
  }
  return digest;
}

function runAStarMutations(map: BenchmarkMap, snapshots: readonly Uint8Array[]): number {
  let digest = 0;
  for (const snapshot of snapshots) {
    const mutated = { ...map, grid: { ...map.grid, passability: snapshot } };
    digest ^= runAStarBatch(mutated);
  }
  return digest;
}

function validatePairs(map: BenchmarkMap, fields: readonly FlowField[]): void {
  for (const agent of map.agents) {
    const goal = map.goals[agent.goal]!;
    const astar = findPath({
      passability: map.grid.passability,
      width: WIDTH,
      startX: agent.x,
      startY: agent.y,
      goalX: goal.x,
      goalY: goal.y,
    });
    const flowCost = fields[agent.goal]!.costAt(agent.x, agent.y);
    const astarCost = astar === null ? FLOW_UNREACHABLE : astar.cost;
    if (flowCost !== astarCost) {
      throw new Error(`${map.kind} cost mismatch at (${agent.x},${agent.y}): ${flowCost} != ${astarCost}`);
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const roundsArg = process.argv.indexOf("--rounds");
const rounds = roundsArg >= 0 ? Number(process.argv[roundsArg + 1]) : DEFAULT_ROUNDS;
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
const startedAt = new Date().toISOString();
const maps = [prepareMap("open"), prepareMap("maze"), prepareMap("choke")];
const results = [];

for (const map of maps) {
  const fields = buildFields(map);
  validatePairs(map, fields);
  const snapshots = mutationMaps(map);
  const walkable = map.grid.passability.reduce((sum, value) => sum + (value === 1 ? 1 : 0), 0);
  const measurements = [
    measure("astar_per_agent_256", rounds, 1, AGENT_COUNT, () => runAStarBatch(map)),
    measure("flow_build_8_fields", rounds, 1, null, () => {
      const built = buildFields(map);
      return built.reduce((sum, f) => sum + f.integration[0]!, 0);
    }),
    measure("flow_cold_build_8_and_query_256", rounds, 1, AGENT_COUNT, () => {
      return queryFields(map, buildFields(map));
    }),
    measure("flow_cached_cost_direction_query_256", rounds, QUERY_REPETITIONS, AGENT_COUNT, () => {
      return queryFields(map, fields);
    }),
    measure("flow_cached_raw_route_256", rounds, ROUTE_REPETITIONS, AGENT_COUNT, () => {
      return traceRoutes(map, fields);
    }),
    measure("flow_8_revisions_rebuild_8_fields_and_query_256", rounds, 1, AGENT_COUNT * MUTATION_COUNT, () => {
      return runFlowMutations(map, snapshots);
    }),
    measure("astar_8_revisions_per_agent_256", rounds, 1, AGENT_COUNT * MUTATION_COUNT, () => {
      return runAStarMutations(map, snapshots);
    }),
  ];
  results.push({
    map: map.kind,
    cells: WIDTH * HEIGHT,
    walkable,
    agents: AGENT_COUNT,
    destinations: GOAL_COUNT,
    mutationRevisions: MUTATION_COUNT,
    mutationTiles: map.mutationTiles,
    goalTiles: map.goals.map((goal) => goal.y * WIDTH + goal.x),
    agentTiles: map.agents.map((agent) => agent.y * WIDTH + agent.x),
    measurements,
  });
  console.log(`${map.kind}: ${measurements.map((m) => `${m.operation}=${m.summary.batchMeanMs.toFixed(4)}ms`).join(", ")}`);
}

const output = {
  schemaVersion: 1,
  startedAt,
  command: "./node_modules/.bin/tsx scratch/full-game-movement/flow-field/benchmark.ts",
  configuration: {
    width: WIDTH,
    height: HEIGHT,
    agentCount: AGENT_COUNT,
    goalCount: GOAL_COUNT,
    rounds,
    warmupRounds: WARMUP_ROUNDS,
    queryRepetitions: QUERY_REPETITIONS,
    routeRepetitions: ROUTE_REPETITIONS,
    mutationCount: MUTATION_COUNT,
    timing: "process.hrtime-backed performance.now(); synchronous serial Node execution",
  },
  environment: {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  scope: "Node microbenchmark only; no full-game, browser, worker, crowd, or steering measurement",
  results,
};
const outputPath = resolve(here, "benchmark-results.json");
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${outputPath}`);
