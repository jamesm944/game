import { writeFileSync } from "node:fs";
import { recastCore } from "../../full-game-movement/recast-integration/recast-runtime";
import type { PathRequest } from "../../../src/sim/path/protocol";
import { initializeRecast } from "./incremental-candidate";
import { RecastRouteEngine } from "./incremental-engine";
import { buildMesh, destroyMesh, type MeshEntry } from "./tile-cache-state";

await initializeRecast();
const width = 120;
const passable = new Uint8Array(width * width).fill(1);
for (let y = 0; y < width; y += 1) if (y < 59 || y >= 63) passable[y * width + 60] = 0;
const request: PathRequest = { kind: "path", id: 1, dueTick: 2, startX: 47, startY: 42, goalX: 80, goalY: 60, passable, passableVersion: 0, seed: 169 };
const owner = new RecastRouteEngine();
const incremental = buildMesh(request, () => 0, width, true, false, owner.metrics)!;
const full = buildMesh(request, () => 0, width, false, false, owner.metrics)!;

function probe(entry: MeshEntry, label: string) {
  const start = entry.query.findClosestPoint({ x: 47.5, y: 0, z: 42.5 }, { halfExtents: { x: 2, y: 2, z: 2 } });
  const end = entry.query.findClosestPoint({ x: 80.5, y: 0, z: 60.5 }, { halfExtents: { x: 2, y: 2, z: 2 } });
  const path = entry.query.findPath(start.polyRef, end.polyRef, start.point, end.point, { maxPathPolys: 2048 });
  const straight = entry.query.findStraightPath(start.point, end.point, path.polys, { maxStraightPathPoints: 2048 });
  const points = Array.from({ length: straight.straightPathCount }, (_, index) => ({
    x: straight.straightPath.get(index * 3), z: straight.straightPath.get(index * 3 + 2),
  }));
  const wallCenter = entry.query.findClosestPoint({ x: 60.5, y: 0, z: 50.5 }, { halfExtents: { x: 0.01, y: 0.01, z: 0.01 } });
  const left = entry.query.findClosestPoint({ x: 59.5, y: 0, z: 50.5 }, { halfExtents: { x: 0.1, y: 0.1, z: 0.1 } });
  const ray = entry.query.raycast(left.polyRef, left.point, { x: 61.5, y: 0, z: 50.5 });
  const tile = entry.navMesh.getTileAt(7, 6, 0);
  const header = tile?.header();
  const [positions, indices] = recastCore.getNavMeshPositionsAndIndices(entry.navMesh);
  let coveringTriangles = 0;
  const px = 60.5;
  const pz = 50.5;
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = indices.slice(index, index + 3).map((vertex) => ({ x: positions[vertex * 3]!, z: positions[vertex * 3 + 2]! }));
    const [a, b, c] = triangle;
    const sign = (p: {x:number;z:number}, q: {x:number;z:number}, r: {x:number;z:number}) => (p.x-r.x)*(q.z-r.z)-(q.x-r.x)*(p.z-r.z);
    const p = { x: px, z: pz };
    const d1 = sign(p, a!, b!);
    const d2 = sign(p, b!, c!);
    const d3 = sign(p, c!, a!);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) coveringTriangles += 1;
  }
  const result = {
    label,
    points,
    wallCenter: { success: wallCenter.success, point: wallCenter.point, polyRef: wallCenter.polyRef },
    raycast: { success: ray.success, t: ray.t, hitNormal: ray.hitNormal, path: ray.path },
    tile: header ? { polyCount: header.polyCount(), vertCount: header.vertCount() } : null,
    coveringTriangles,
    geometryCounts: { vertices: positions.length / 3, triangles: indices.length / 3 },
  };
  path.polys.destroy();
  straight.straightPath.destroy();
  straight.straightPathFlags.destroy();
  straight.straightPathRefs.destroy();
  return result;
}
const output = [probe(incremental, "incremental"), probe(full, "full")];
writeFileSync(new URL("./results/mesh-diagnosis.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
destroyMesh(incremental);
destroyMesh(full);
owner.dispose();
