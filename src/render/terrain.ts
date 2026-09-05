/**
 * Terrain mesh with splat texturing, water shimmer & farm furrows — Issue #75 (V4).
 *
 * One draw call built from a plane subdivided to the exact tile grid:
 * every tile renders as a flat facet displaced by `elevationLevel × ELEVATION_STEP`,
 * with water tiles recessed and animated. Vertical skirts fill terrace drops
 * with textured rock faces.
 *
 * Splat texturing blends AmbientCG Grass, Dirt, Rock, and Poly Haven Leafy Grass
 * based on terrain type and elevation, with farm furrows under farm structures
 * and animated caustics & shimmer on water tiles.
 */

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  Texture,
  TextureLoader,
  UnsignedByteType,
} from "three";
import {
  TERRAIN_DEEP_WATER,
  TERRAIN_WATER,
  type WorldLayers,
} from "../sim/world/layers";
import type { FogShaderUniforms } from "./fogTexture";

import grassUrl from "../assets/models/terrain/ambientcg-grass001/Grass001_1K-JPG_Color.jpg";
import dirtUrl from "../assets/models/terrain/ambientcg-ground110-dirt/Ground110_1K-JPG_Color.jpg";
import rockUrl from "../assets/models/terrain/ambientcg-rock064/Rock064_1K-JPG_Color.jpg";
import forestUrl from "../assets/models/terrain/polyhaven-leafy-grass/leafy_grass_diff_1k.jpg";

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
  terrainTypes: number[];
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
  terrainType: number,
): void {
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const [x, y, z] = corners[i]!;
    scratch.positions.push(x, y, z);
    scratch.normals.push(normal[0], normal[1], normal[2]);
    scratch.colors.push(color.r, color.g, color.b);
    scratch.terrainTypes.push(terrainType);
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
  if (ownY <= neighborY) return;

  const darkened = color.clone().multiplyScalar(0.72);
  const x0 = tx;
  const z0 = ty;
  const ROCK_WALL_TYPE = 6;

  if (dx === 1) {
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
      ROCK_WALL_TYPE,
    );
  } else if (dx === -1) {
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
      ROCK_WALL_TYPE,
    );
  } else if (dy === 1) {
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
      ROCK_WALL_TYPE,
    );
  } else {
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
      ROCK_WALL_TYPE,
    );
  }
}

function loadTerrainTexture(url: string): Texture {
  const loader = new TextureLoader();
  const tex = loader.load(url);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  return tex;
}

export interface TerrainMesh extends Mesh {
  readonly uTime: { value: number };
  updateFarms(
    farmTiles: ReadonlyArray<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>,
  ): void;
}

/**
 * Build the whole terrain as ONE mesh from map layers with splat texturing,
 * dynamic water shimmer, and farm furrow support.
 */
export function buildTerrainMesh(
  layers: WorldLayers,
  fog?: FogShaderUniforms | undefined,
): TerrainMesh {
  const size = layers.size;

  const plane = new PlaneGeometry(size, size, size, size);
  plane.rotateX(-Math.PI / 2);
  plane.translate(size / 2, 0, size / 2);
  const tops = plane.toNonIndexed();
  plane.dispose();

  const topPositions = tops.getAttribute("position") as BufferAttribute;
  const vertexCount = topPositions.count;
  const topColors = new Float32Array(vertexCount * 3);
  const topTerrainTypes = new Float32Array(vertexCount);
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

    const y = tileTopY(layers, tileIndex);
    const tType = layers.terrainType[tileIndex]!;

    for (let v = 0; v < 3; v++) {
      topPositions.setY(base + v, y);
      topTerrainTypes[base + v] = tType;
    }

    const brightness = 0.92 + hash01(tileIndex) * 0.14;
    scratchColor.setHex(TERRAIN_HEX[tType]!);
    scratchColor.multiplyScalar(brightness);
    for (let v = 0; v < 3; v++) {
      const o = (base + v) * 3;
      topColors[o] = scratchColor.r;
      topColors[o + 1] = scratchColor.g;
      topColors[o + 2] = scratchColor.b;
    }
  }

  // Skirts
  const walls: MeshScratch = {
    positions: [],
    normals: [],
    colors: [],
    terrainTypes: [],
  };
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

  const merged = new BufferGeometry();
  const totalVertices = vertexCount + walls.positions.length / 3;

  const positions = new Float32Array(totalVertices * 3);
  positions.set(topPositions.array as Float32Array, 0);
  positions.set(walls.positions, vertexCount * 3);

  const normals = new Float32Array(totalVertices * 3);
  for (let i = 0; i < vertexCount; i++) {
    normals[i * 3] = 0;
    normals[i * 3 + 1] = 1;
    normals[i * 3 + 2] = 0;
  }
  normals.set(walls.normals, vertexCount * 3);

  const colors = new Float32Array(totalVertices * 3);
  colors.set(topColors, 0);
  colors.set(walls.colors, topColors.length);

  const terrainTypes = new Float32Array(totalVertices);
  terrainTypes.set(topTerrainTypes, 0);
  terrainTypes.set(walls.terrainTypes, vertexCount);

  merged.setAttribute("position", new BufferAttribute(positions, 3));
  merged.setAttribute("normal", new BufferAttribute(normals, 3));
  merged.setAttribute("color", new BufferAttribute(colors, 3));
  merged.setAttribute("aTerrainType", new BufferAttribute(terrainTypes, 1));
  tops.dispose();

  // Load textures
  const texGrass = loadTerrainTexture(grassUrl);
  const texDirt = loadTerrainTexture(dirtUrl);
  const texRock = loadTerrainTexture(rockUrl);
  const texForest = loadTerrainTexture(forestUrl);

  const farmData = new Uint8Array(size * size);
  const farmTexture = new DataTexture(
    farmData,
    size,
    size,
    RedFormat,
    UnsignedByteType,
  );
  farmTexture.minFilter = LinearFilter;
  farmTexture.magFilter = LinearFilter;
  farmTexture.wrapS = ClampToEdgeWrapping;
  farmTexture.wrapT = ClampToEdgeWrapping;
  farmTexture.needsUpdate = true;

  const uTime = { value: 0 };

  const material = new MeshLambertMaterial({ vertexColors: true });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTexGrass = { value: texGrass };
    shader.uniforms.uTexDirt = { value: texDirt };
    shader.uniforms.uTexRock = { value: texRock };
    shader.uniforms.uTexForest = { value: texForest };
    shader.uniforms.uFarmMask = { value: farmTexture };
    shader.uniforms.uTime = uTime;
    shader.uniforms.uFogMapSize = { value: size };

    if (fog) {
      shader.uniforms.uFogCurr = fog.uFogCurr;
      shader.uniforms.uFogPrev = fog.uFogPrev;
      shader.uniforms.uBlend = fog.uBlend;
    }

    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      /* glsl */ `
      attribute float aTerrainType;
      varying float vTerrainType;
      varying vec2 vWorldUv;
      varying vec3 vWorldPos;
      varying vec2 vFogUv;
      uniform float uFogMapSize;
      void main() {`,
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>
      vTerrainType = aTerrainType;
      vWorldPos = position;
      vWorldUv = position.xz;
      vFogUv = position.xz / uFogMapSize;`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      /* glsl */ `
      uniform sampler2D uTexGrass;
      uniform sampler2D uTexDirt;
      uniform sampler2D uTexRock;
      uniform sampler2D uTexForest;
      uniform sampler2D uFarmMask;
      uniform sampler2D uFogCurr;
      uniform sampler2D uFogPrev;
      uniform float uBlend;
      uniform float uTime;
      uniform float uFogMapSize;

      varying float vTerrainType;
      varying vec2 vWorldUv;
      varying vec3 vWorldPos;
      varying vec2 vFogUv;
      void main() {`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      /* glsl */ `
      #include <color_fragment>
      // Seamless world-aligned UVs
      vec2 uvGrass = vWorldUv * 0.22;
      vec2 uvDirt = vWorldUv * 0.22;
      vec2 uvRock = vWorldPos.xz * 0.22 + vec2(vWorldPos.y * 0.45, 0.0);
      vec2 uvForest = vWorldUv * 0.22;

      vec4 colGrass = texture2D(uTexGrass, uvGrass);
      vec4 colDirt = texture2D(uTexDirt, uvDirt);
      vec4 colRock = texture2D(uTexRock, uvRock);
      vec4 colForest = texture2D(uTexForest, uvForest);

      vec3 texColor = colGrass.rgb;

      if (vTerrainType > 5.5) {
        // Rock cliff / terrace skirts
        texColor = colRock.rgb * 0.85;
      } else if (vTerrainType > 4.5) {
        // Forest floor
        texColor = colForest.rgb * 0.92;
      } else if (vTerrainType > 3.5) {
        // Dirt / paths
        texColor = colDirt.rgb;
      } else if (vTerrainType > 2.5) {
        // Grass: blend with leafy grass for natural micro-variation
        float variation = sin(vWorldUv.x * 0.45) * cos(vWorldUv.y * 0.45);
        texColor = mix(colGrass.rgb, colForest.rgb, clamp(variation * 0.45 + 0.25, 0.0, 0.45));
      } else if (vTerrainType > 1.5) {
        // Shore
        texColor = mix(colDirt.rgb, vec3(0.82, 0.72, 0.52), 0.5);
      } else {
        // Water (animated caustics, wave shimmer & sun sparkle)
        float wave1 = sin(vWorldUv.x * 3.5 + uTime * 2.2);
        float wave2 = cos(vWorldUv.y * 3.5 + uTime * 1.8);
        float wave3 = sin((vWorldUv.x + vWorldUv.y) * 6.0 - uTime * 2.8) * 0.4;
        float shimmer = (wave1 + wave2 + wave3) * 0.45;
        vec3 deepWater = vec3(0.07, 0.18, 0.32);
        vec3 shallowWater = vec3(0.16, 0.38, 0.56);
        vec3 waterBase = vTerrainType < 0.5 ? deepWater : shallowWater;
        float sparkle = pow(max(0.0, shimmer), 3.0) * 0.4;
        texColor = waterBase + vec3(sparkle * 0.35, sparkle * 0.7, sparkle * 0.95);
      }

      // Farm furrow pattern
      float farmFlag = texture2D(uFarmMask, vFogUv).r;
      if (farmFlag > 0.5 && vTerrainType > 1.5) {
        float furrow = sin(vWorldUv.x * 14.0) * 0.16;
        vec3 soil = vec3(0.40, 0.28, 0.18) + furrow;
        texColor = mix(texColor, soil, 0.75);
      }

      // Preserve vertex color jitter and palette calibration
      diffuseColor.rgb = texColor * vColor.rgb * 1.38;

      // Fog of war dimming
      if (uFogMapSize > 0.0) {
        vec4 fogCurrTexel = texture2D(uFogCurr, vFogUv);
        vec4 fogPrevTexel = texture2D(uFogPrev, vFogUv);
        float fogExplored = mix(fogPrevTexel.r, fogCurrTexel.r, uBlend);
        float fogVisible = mix(fogPrevTexel.g, fogCurrTexel.g, uBlend);
        float isExplored = step(0.0005, fogExplored);
        float isVisible = clamp(fogVisible * 255.0, 0.0, 1.0);
        float fogBrightness = mix(0.55, 1.0, isVisible) * isExplored;
        diffuseColor.rgb *= fogBrightness;
      }`,
    );
  };

  const baseMesh = new Mesh(merged, material);
  const mesh = Object.assign(baseMesh, {
    uTime,
    updateFarms(
      farmTiles: ReadonlyArray<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>,
    ): void {
      farmData.fill(0);
      for (const f of farmTiles) {
        for (let dy = 0; dy < f.height; dy++) {
          for (let dx = 0; dx < f.width; dx++) {
            const x = f.x + dx;
            const y = f.y + dy;
            if (x >= 0 && y >= 0 && x < size && y < size) {
              farmData[y * size + x] = 255;
            }
          }
        }
      }
      farmTexture.needsUpdate = true;
    },
  });

  return mesh;
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
