/**
 * Terrain mesh — M1-T6.
 *
 * One draw call built from a plane subdivided to the exact tile grid:
 * every tile renders as a flat facet displaced by
 * `elevationLevel × ELEVATION_STEP` (SPEC ticket: visualize integer
 * elevation as steps), with water tiles recessed and tinted toward
 * blue. Wherever a tile sits higher than a neighbor, a vertical skirt
 * fills the drop so terraces read as solid ground instead of holes.
 *
 * COLORING — flat-shaded vertex colors now, splat later: SPEC §6 lists
 * ambientCG Ground/Rock + Poly Haven grass/furrow as the CC0 splat
 * sources, but fetching/packaging textures is deliberately deferred
 * (no network dependency in a render-skeleton ticket). The palette +
 * deterministic per-tile brightness jitter below keeps the visual read
 * until that pass lands. TODO(splat): replace per-facet vertex colors
 * with a 512px splat-map material keyed by terrain id (§6 manifest).
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
} from "three";
import {
  TERRAIN_DEEP_WATER,
  TERRAIN_WATER,
  type WorldLayers,
} from "../sim/world/layers";
import { injectTerrainFog, type FogShaderUniforms } from "./fogTexture";

/** Vertical world units per integer elevation level (ticket constant). */
export const ELEVATION_STEP = 0.25;
/** Water surfaces sit slightly below their tile's elevation datum. */
const WATER_RECESS = 0.15;
/** How far below a border tile's top its outer skirt extends. */
const BORDER_SKIRT_DROP = 2;

/**
 * Flat palette indexed by the STABLE terrain ids in layers.ts (deep
 * water … forest floor). Never renumber the enum — these follow it.
 */
const TERRAIN_HEX: readonly number[] = [
  0x16324a, // deep-water
  0x2e648c, // water
  0xc7ae7e, // shore
  0x59853f, // grass
  0x8a6f47, // dirt
  0x39562e, // forest-floor
];

/** Deterministic hash → [0, 1); render-side only, sim never sees it. */
function hash01(n: number): number {
  let z = (n ^ 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return ((z ^ (z >>> 16)) >>> 0) / 0xffffffff;
}

/** Top surface height (three.js Y) for one tile index. */
function tileTopY(layers: WorldLayers, tileIndex: number): number {
  const level = layers.elevationLevel[tileIndex]!;
  const isWater =
    layers.terrainType[tileIndex] === TERRAIN_DEEP_WATER ||
    layers.terrainType[tileIndex] === TERRAIN_WATER;
  return level * ELEVATION_STEP - (isWater ? WATER_RECESS : 0);
}

/** Neighbor tile index or undefined past the border. */
function neighbor(
  layers: WorldLayers,
  tx: number,
  ty: number,
  dx: number,
  dy: number,
): number | undefined {
  const nx = tx + dx;
  const ny = ty + dy;
  if (nx < 0 || ny < 0 || nx >= layers.size || ny >= layers.size)
    return undefined;
  return ny * layers.size + nx;
}

interface MeshScratch {
  positions: number[];
  normals: number[];
  colors: number[];
}

function pushQuad(
  scratch: MeshScratch,
  corners: readonly [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
  normal: readonly [number, number, number],
  color: Color,
): void {
  // Two triangles: 0-1-2 and 0-2-3 wound for the given normal.
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const [x, y, z] = corners[i]!;
    scratch.positions.push(x, y, z);
    scratch.normals.push(normal[0], normal[1], normal[2]);
    scratch.colors.push(color.r, color.g, color.b);
  }
}

/** Append a vertical wall between this tile's top and a lower neighbor. */
function pushWall(
  scratch: MeshScratch,
  layers: WorldLayers,
  tx: number,
  ty: number,
  dx: number,
  dy: number,
  ownY: number,
  color: Color,
): void {
  const neighborIndex = neighbor(layers, tx, ty, dx, dy);
  const neighborY =
    neighborIndex === undefined
      ? ownY - BORDER_SKIRT_DROP
      : tileTopY(layers, neighborIndex);
  if (ownY <= neighborY) return; // flat or uphill: nothing to fill

  const darkened = color.clone().multiplyScalar(0.72);
  const x0 = tx;
  const z0 = ty;
  // Wall runs along the shared edge; winding chosen per direction so
  // the face points AWAY from the taller tile (outward).
  if (dx === 1) {
    // East edge, outward normal +X.
    pushQuad(
      scratch,
      [
        [x0 + 1, neighborY, z0],
        [x0 + 1, neighborY, z0 + 1],
        [x0 + 1, ownY, z0 + 1],
        [x0 + 1, ownY, z0],
      ],
      [1, 0, 0],
      darkened,
    );
  } else if (dx === -1) {
    // West edge, outward normal −X.
    pushQuad(
      scratch,
      [
        [x0, neighborY, z0 + 1],
        [x0, neighborY, z0],
        [x0, ownY, z0],
        [x0, ownY, z0 + 1],
      ],
      [-1, 0, 0],
      darkened,
    );
  } else if (dy === 1) {
    // South edge (+Z), outward normal +Z.
    pushQuad(
      scratch,
      [
        [x0 + 1, neighborY, z0 + 1],
        [x0, neighborY, z0 + 1],
        [x0, ownY, z0 + 1],
        [x0 + 1, ownY, z0 + 1],
      ],
      [0, 0, 1],
      darkened,
    );
  } else {
    // North edge (−Z), outward normal −Z.
    pushQuad(
      scratch,
      [
        [x0, neighborY, z0],
        [x0 + 1, neighborY, z0],
        [x0 + 1, ownY, z0],
        [x0, ownY, z0],
      ],
      [0, 0, -1],
      darkened,
    );
  }
}

/**
 * Build the whole terrain as ONE mesh from map layers. Sim coordinates
 * map identically into the XZ plane: tile (tx, ty) occupies
 * x ∈ [tx, tx+1], z ∈ [ty, ty+1], matching camera/render conventions.
 *
 * Pass `fog` to dim/black out terrain per the fog-of-war planes
 * (SPEC §2.9 / M2-T8): brightness = mix(EXPLORED_DIM, 1, texel.g) *
 * step(0.5, texel.r) sampled from the RG DataTexture handoff with
 * temporal uBlend smoothing. Omit it for the unfogged M1 look.
 */
export function buildTerrainMesh(
  layers: WorldLayers,
  fog?: FogShaderUniforms | undefined,
): Mesh {
  const size = layers.size;

  // Tops: plane subdivided to the tile grid, un-indexed so each facet
  // carries its own flat color + straight-up normal (flat shading).
  const plane = new PlaneGeometry(size, size, size, size);
  plane.rotateX(-Math.PI / 2);
  plane.translate(size / 2, 0, size / 2);
  const tops = plane.toNonIndexed();
  plane.dispose();

  const topPositions = tops.getAttribute("position") as BufferAttribute;
  const vertexCount = topPositions.count;
  const topColors = new Float32Array(vertexCount * 3);
  const scratchColor = new Color();

  for (let tri = 0; tri < vertexCount / 3; tri++) {
    const base = tri * 3;
    const cx =
      (topPositions.getX(base)! +
        topPositions.getX(base + 1)! +
        topPositions.getX(base + 2)!) /
      3;
    const cz =
      (topPositions.getZ(base)! +
        topPositions.getZ(base + 1)! +
        topPositions.getZ(base + 2)!) /
      3;
    const tx = Math.min(size - 1, Math.max(0, Math.floor(cx)));
    const ty = Math.min(size - 1, Math.max(0, Math.floor(cz)));
    const tileIndex = ty * size + tx;

    // Flatten the facet onto its tile's terrace height…
    const y = tileTopY(layers, tileIndex);
    for (let v = 0; v < 3; v++) topPositions.setY(base + v, y);

    // …and paint it with the palette plus deterministic brightness
    // jitter (hash of tile index — stable across reloads/rebuilds).
    const brightness = 0.92 + hash01(tileIndex) * 0.14;
    scratchColor.setHex(TERRAIN_HEX[layers.terrainType[tileIndex]!]!);
    scratchColor.multiplyScalar(brightness);
    for (let v = 0; v < 3; v++) {
      const o = (base + v) * 3;
      topColors[o] = scratchColor.r;
      topColors[o + 1] = scratchColor.g;
      topColors[o + 2] = scratchColor.b;
    }
  }
  tops.setAttribute("color", new BufferAttribute(topColors, 3));

  // Skirts: walk every tile once; each wall is owned by its taller
  // side, so no interior wall can be emitted twice.
  const walls: MeshScratch = { positions: [], normals: [], colors: [] };
  const wallColor = new Color();
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const idx = ty * size + tx;
      const y = tileTopY(layers, idx);
      wallColor.setHex(TERRAIN_HEX[layers.terrainType[idx]!]!);
      pushWall(walls, layers, tx, ty, 1, 0, y, wallColor);
      pushWall(walls, layers, tx, ty, -1, 0, y, wallColor);
      pushWall(walls, layers, tx, ty, 0, 1, y, wallColor);
      pushWall(walls, layers, tx, ty, 0, -1, y, wallColor);
    }
  }

  // Merge tops + skirts into one geometry (one draw call total).
  const merged = new BufferGeometry();
  const positions = new Float32Array(vertexCount * 3 + walls.positions.length);
  positions.set(topPositions.array as Float32Array, 0);
  positions.set(walls.positions, vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3 + walls.normals.length);
  for (let i = 0; i < vertexCount; i++) {
    normals[i * 3] = 0;
    normals[i * 3 + 1] = 1;
    normals[i * 3 + 2] = 0;
  }
  normals.set(walls.normals, vertexCount * 3);
  const colors = new Float32Array(topColors.length + walls.colors.length);
  colors.set(topColors, 0);
  colors.set(walls.colors, topColors.length);
  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.setAttribute("normal", new BufferAttribute(normals, 3));
  merged.setAttribute("color", new BufferAttribute(colors, 3));
  tops.dispose();

  const material = new MeshLambertMaterial({ vertexColors: true });
  if (fog) injectTerrainFog(material, fog, size);

  return new Mesh(merged, material);
}

/**
 * Ground height under a sim coordinate — used to plant entities on
 * terraces. Out-of-bounds reads clamp to the border tile.
 */
export function terrainHeightAt(
  layers: WorldLayers,
  x: number,
  y: number,
): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const cx = Math.min(layers.size - 1, Math.max(0, tx));
  const cy = Math.min(layers.size - 1, Math.max(0, ty));
  return tileTopY(layers, cy * layers.size + cx);
}
