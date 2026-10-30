import { performance } from 'node:perf_hooks';
import { findPath } from '../../../src/sim/path/astar';
import { createPathEngine } from '../../../src/sim/path/engine';
import { RecastNavigation } from '../../donor-audit/browser/voidstrike/src/engine/pathfinding/RecastNavigation';
import PF from 'pathfinding';

export interface FixtureMap {
  id: string;
  description: string;
  width: number;
  height: number;
  walkable: number[];
  vertexHeights: number[];
  requests: PathRequestFixture[];
  mutations: MutationFixture[];
}
export interface PathRequestFixture {
  id: string;
  start: [number, number];
  goal: [number, number];
  expectedReachable: boolean;
}
export interface MutationFixture {
  id: string;
  operation: string;
  rect: { x: number; y: number; width: number; height: number };
  expectedReachableAfter: boolean;
}
export interface QueryOutput {
  reportedSuccess: boolean;
  points: [number, number][];
  rawGridCost?: number;
}
export interface Adapter {
  name: string;
  setupMs: number;
  setup(): Promise<void>;
  query(request: PathRequestFixture): QueryOutput;
  repeatedGroup(request: PathRequestFixture, count: number): { outputs: QueryOutput[]; cacheHits: number | null };
  addMutation(mutation: MutationFixture): void;
  removeMutation(mutation: MutationFixture): void;
  rebuildWithMutation?(mutation: MutationFixture): Promise<void>;
  dispose(): void;
}

function center(point: [number, number]): [number, number] {
  return [point[0] + 0.5, point[1] + 0.5];
}
function geometry(map: FixtureMap, blockedMutation?: MutationFixture) {
  const blocked = new Uint8Array(map.walkable);
  if (blockedMutation) {
    const { x, y, width, height } = blockedMutation.rect;
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) blocked[yy * map.width + xx] = 0;
  }
  const positions: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (blocked[y * map.width + x] !== 1) continue;
      const base = positions.length / 3;
      const h = (xx: number, yy: number) => map.vertexHeights[yy * (map.width + 1) + xx];
      positions.push(
        x, h(x, y), y,
        x + 1, h(x + 1, y), y,
        x + 1, h(x + 1, y + 1), y + 1,
        x, h(x, y + 1), y + 1,
      );
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
function applyGridMutation(bytes: Uint8Array, map: FixtureMap, mutation: MutationFixture, value: 0 | 1) {
  const { x, y, width, height } = mutation.rect;
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) bytes[yy * map.width + xx] = value;
}

export class ProjectAStarAdapter implements Adapter {
  name = 'project-integer-a-star';
  setupMs = 0;
  private bytes!: Uint8Array;
  private version = 0;
  constructor(private map: FixtureMap) {}
  async setup() {
    const start = performance.now();
    this.bytes = Uint8Array.from(this.map.walkable);
    this.setupMs = performance.now() - start;
  }
  query(request: PathRequestFixture): QueryOutput {
    const result = findPath({
      passability: this.bytes,
      width: this.map.width,
      startX: request.start[0], startY: request.start[1],
      goalX: request.goal[0], goalY: request.goal[1],
    });
    if (!result) return { reportedSuccess: false, points: [] };
    const points: [number, number][] = [];
    for (let i = 0; i < result.waypoints.length; i += 2) points.push([result.waypoints[i] + 0.5, result.waypoints[i + 1] + 0.5]);
    return { reportedSuccess: true, points, rawGridCost: result.cost / 1000 };
  }
  repeatedGroup(request: PathRequestFixture, count: number) {
    const engine = createPathEngine();
    const outputs: QueryOutput[] = [];
    for (let i = 0; i < count; i++) {
      const response = engine.handle({
        kind: 'path', id: i, dueTick: i + 2,
        startX: request.start[0], startY: request.start[1], goalX: request.goal[0], goalY: request.goal[1],
        passable: this.bytes, passableVersion: this.version, seed: 0x162 + i,
      });
      const points: [number, number][] = [];
      for (let p = 0; p < response.waypoints.length; p += 2) points.push([response.waypoints[p] + 0.5, response.waypoints[p + 1] + 0.5]);
      outputs.push({ reportedSuccess: response.ok, points, rawGridCost: response.cost / 1000 });
    }
    return { outputs, cacheHits: count - 1 };
  }
  addMutation(mutation: MutationFixture) { applyGridMutation(this.bytes, this.map, mutation, 0); this.version++; }
  removeMutation(mutation: MutationFixture) { applyGridMutation(this.bytes, this.map, mutation, 1); this.version++; }
  dispose() {}
}

export class PathFindingJsAdapter implements Adapter {
  name = 'pathfinding-js-0.4.18';
  setupMs = 0;
  private grid!: PF.Grid;
  private finder = new PF.AStarFinder({ diagonalMovement: PF.DiagonalMovement.OnlyWhenNoObstacles });
  constructor(private map: FixtureMap) {}
  async setup() {
    const start = performance.now();
    this.grid = new PF.Grid(this.map.width, this.map.height);
    for (let y = 0; y < this.map.height; y++) for (let x = 0; x < this.map.width; x++) this.grid.setWalkableAt(x, y, this.map.walkable[y * this.map.width + x] === 1);
    this.setupMs = performance.now() - start;
  }
  query(request: PathRequestFixture): QueryOutput {
    // PathFinding.js mutates search-node state; cloning is part of each native request.
    const raw = this.finder.findPath(request.start[0], request.start[1], request.goal[0], request.goal[1], this.grid.clone());
    return { reportedSuccess: raw.length > 0, points: raw.map(([x, y]) => [x + 0.5, y + 0.5]) };
  }
  repeatedGroup(request: PathRequestFixture, count: number) {
    return { outputs: Array.from({ length: count }, () => this.query(request)), cacheHits: null };
  }
  addMutation(mutation: MutationFixture) {
    const { x, y, width, height } = mutation.rect;
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) this.grid.setWalkableAt(xx, yy, false);
  }
  removeMutation(mutation: MutationFixture) {
    const { x, y, width, height } = mutation.rect;
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) this.grid.setWalkableAt(xx, yy, true);
  }
  dispose() {}
}

export class VoidstrikeRecastAdapter implements Adapter {
  name = 'voidstrike-recast-detour-0.43.0';
  setupMs = 0;
  private navigation!: RecastNavigation;
  private obstacleId = 162000;
  constructor(private map: FixtureMap) {}
  private heightAt(x: number, y: number) {
    const xx = Math.max(0, Math.min(this.map.width - 0.000001, x));
    const yy = Math.max(0, Math.min(this.map.height - 0.000001, y));
    const x0 = Math.floor(xx), y0 = Math.floor(yy), fx = xx - x0, fy = yy - y0;
    const stride = this.map.width + 1;
    const h00 = this.map.vertexHeights[y0 * stride + x0];
    const h10 = this.map.vertexHeights[y0 * stride + x0 + 1];
    const h01 = this.map.vertexHeights[(y0 + 1) * stride + x0];
    const h11 = this.map.vertexHeights[(y0 + 1) * stride + x0 + 1];
    return h00 * (1-fx) * (1-fy) + h10 * fx * (1-fy) + h01 * (1-fx) * fy + h11 * fx * fy;
  }
  private async generate(map: FixtureMap, mutation?: MutationFixture) {
    this.navigation = RecastNavigation.getInstance();
    this.navigation.setTerrainHeightProvider((x, y) => this.heightAt(x, y));
    const mesh = geometry(map, mutation);
    const ok = await this.navigation.generateFromGeometry(mesh.positions, mesh.indices, map.width, map.height);
    if (!ok) throw new Error(`Recast navmesh generation failed for ${map.id}`);
  }
  async setup() {
    const start = performance.now();
    await this.generate(this.map);
    this.setupMs = performance.now() - start;
  }
  query(request: PathRequestFixture): QueryOutput {
    const [sx, sy] = center(request.start), [gx, gy] = center(request.goal);
    const result = this.navigation.findPath(sx, sy, gx, gy);
    return { reportedSuccess: result.found, points: result.path.map((p) => [p.x, p.y]) };
  }
  repeatedGroup(request: PathRequestFixture, count: number) {
    return { outputs: Array.from({ length: count }, () => this.query(request)), cacheHits: null };
  }
  addMutation(mutation: MutationFixture) {
    const { x, y, width, height } = mutation.rect;
    this.navigation.addBoxObstacle(this.obstacleId, x + width / 2, y + height / 2, width, height);
  }
  removeMutation() { this.navigation.removeObstacle(this.obstacleId); }
  async rebuildWithMutation(mutation: MutationFixture) {
    RecastNavigation.resetInstance();
    await this.generate(this.map, mutation);
  }
  dispose() { RecastNavigation.resetInstance(); }
}
