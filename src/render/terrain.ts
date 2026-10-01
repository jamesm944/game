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
  RGBAFormat,
  RepeatWrapping,
  Texture,
  TextureLoader,
  UnsignedByteType,
} from "three";
import {
  TERRAIN_DEEP_WATER,
  TERRAIN_WATER,
  TERRAIN_SHORE,
  TERRAIN_GRASS,
  TERRAIN_DIRT,
  TERRAIN_FOREST_FLOOR,
  type WorldLayers,
} from "../sim/world/layers";
import type { FogShaderUniforms } from "./fogTexture";
import {
  createWaterUniforms,
  WATER_FRAGMENT_GLSL,
  type WaterUniforms,
} from "./water";

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
export const TERRAIN_HEX: readonly number[] = [
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
  _color?: Color,
): void {
  const neighborIndex = neighbor(layers, tx, ty, dx, dy);
  const neighborY =
    neighborIndex === undefined
      ? ownY - BORDER_SKIRT_DROP
      : tileTopY(layers, neighborIndex);
  if (ownY <= neighborY) return;

  const brightness = 0.94 + hash01(tx * 31 + ty * 17) * 0.12;
  const rockTint = new Color(0.88, 0.85, 0.82).multiplyScalar(brightness);
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
      rockTint,
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
      rockTint,
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
      rockTint,
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
      rockTint,
      ROCK_WALL_TYPE,
    );
  }
}

function loadTerrainTexture(url: string): Texture {
  if (typeof document === "undefined") {
    const tex = new Texture();
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    return tex;
  }
  const loader = new TextureLoader();
  const tex = loader.load(url);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  return tex;
}

export interface TerrainMesh extends Mesh {
  readonly uTime: { value: number };
  readonly waterUniforms: WaterUniforms;
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
 * Create a GPU splatmap texture (size × size, RGBA) encoding terrain weights:
 * R = Shore (Sand)
 * G = Grass
 * B = Dirt
 * A = Forest Floor
 * Bilinear filtering produces smooth, seamless transitions across tile boundaries.
 */
export function createSplatTexture(layers: WorldLayers): DataTexture {
  const size = layers.size;
  const splatData = new Uint8Array(size * size * 4);
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const idx = ty * size + tx;
      const t = layers.terrainType[idx]!;
      const offset = idx * 4;
      switch (t) {
        case TERRAIN_SHORE:
          splatData[offset] = 255;
          break;
        case TERRAIN_GRASS:
          splatData[offset + 1] = 255;
          break;
        case TERRAIN_DIRT:
          splatData[offset + 2] = 255;
          break;
        case TERRAIN_FOREST_FLOOR:
          splatData[offset + 3] = 255;
          break;
      }
    }
  }
  const tex = new DataTexture(
    splatData,
    size,
    size,
    RGBAFormat,
    UnsignedByteType,
  );
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
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

    const brightness = 0.94 + hash01(tileIndex) * 0.12;
    scratchColor.setRGB(brightness, brightness, brightness);
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
  const splatTexture = createSplatTexture(layers);

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
  const waterUniforms = createWaterUniforms();

  const material = new MeshLambertMaterial({ vertexColors: true });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTexGrass = { value: texGrass };
    shader.uniforms.uTexDirt = { value: texDirt };
    shader.uniforms.uTexRock = { value: texRock };
    shader.uniforms.uTexForest = { value: texForest };
    shader.uniforms.uSplatMap = { value: splatTexture };
    shader.uniforms.uFarmMask = { value: farmTexture };
    shader.uniforms.uTime = uTime;
    shader.uniforms.uFogMapSize = { value: size };

    shader.uniforms.uSunDir = waterUniforms.uSunDir;
    shader.uniforms.uSunColor = waterUniforms.uSunColor;
    shader.uniforms.uSkyColor = waterUniforms.uSkyColor;
    shader.uniforms.uWaterDeepColor = waterUniforms.uWaterDeepColor;
    shader.uniforms.uWaterShallowColor = waterUniforms.uWaterShallowColor;
    shader.uniforms.uFoamColor = waterUniforms.uFoamColor;

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
      uniform float uTime;
      void main() {`,
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>
      vTerrainType = aTerrainType;
      if (aTerrainType < 1.5) {
        float waveTime = uTime * 2.0;
        float waveDisp = sin(position.x * 2.2 + waveTime) * cos(position.z * 2.2 + waveTime * 0.8) * 0.035;
        transformed.y += waveDisp;
      }
      vWorldPos = transformed;
      vWorldUv = transformed.xz;
      vFogUv = transformed.xz / uFogMapSize;`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      /* glsl */ `
      uniform sampler2D uTexGrass;
      uniform sampler2D uTexDirt;
      uniform sampler2D uTexRock;
      uniform sampler2D uTexForest;
      uniform sampler2D uSplatMap;
      uniform sampler2D uFarmMask;
      uniform sampler2D uFogCurr;
      uniform sampler2D uFogPrev;
      uniform float uBlend;
      uniform float uTime;
      uniform float uFogMapSize;

      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uWaterDeepColor;
      uniform vec3 uWaterShallowColor;
      uniform vec3 uFoamColor;

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
      vec2 uvRock = vec2(vWorldPos.x + vWorldPos.z, vWorldPos.y * 2.2) * 0.25;
      vec2 uvForest = vWorldUv * 0.22;

      vec4 colGrass = texture2D(uTexGrass, uvGrass);
      vec4 colDirt = texture2D(uTexDirt, uvDirt);
      vec4 colRock = texture2D(uTexRock, uvRock);
      vec4 colForest = texture2D(uTexForest, uvForest);

      // Domain-warped splatmap sampling for natural, organic transitions
      vec2 splatUv = vWorldPos.xz / uFogMapSize;
      vec2 warp = vec2(
        sin(vWorldUv.y * 3.2 + vWorldUv.x * 1.5),
        cos(vWorldUv.x * 3.2 + vWorldUv.y * 1.5)
      ) * (0.35 / uFogMapSize);
      vec4 splat = texture2D(uSplatMap, clamp(splatUv + warp, 0.0, 1.0));

      float landWeight = splat.r + splat.g + splat.b + splat.a;
      vec4 w = landWeight > 0.001 ? splat / landWeight : vec4(0.0, 1.0, 0.0, 0.0);

      // Calibrated biome colors
      vec3 colSand = mix(colDirt.rgb, vec3(0.92, 0.84, 0.64), 0.58);
      vec3 colLushGrass = mix(colGrass.rgb, colForest.rgb, 0.22);
      vec3 colEarthyDirt = colDirt.rgb;
      vec3 colDenseForest = colForest.rgb * 0.95;

      vec3 landColor = colSand * w.r + colLushGrass * w.g + colEarthyDirt * w.b + colDenseForest * w.a;

      vec3 texColor = landColor;

      if (vTerrainType > 5.5) {
        // Rock cliff / terrace skirts: vertical rock strata without black dashes
        vec3 rockFace = mix(colRock.rgb * 1.08, colDirt.rgb, 0.22);
        texColor = rockFace;
      } else if (vTerrainType < 1.5) {
${WATER_FRAGMENT_GLSL}      }

      // Farm furrow pattern
      float farmFlag = texture2D(uFarmMask, vFogUv).r;
      if (farmFlag > 0.5 && vTerrainType > 1.5 && vTerrainType < 5.5) {
        float furrow = sin(vWorldUv.x * 14.0) * 0.16;
        vec3 soil = vec3(0.40, 0.28, 0.18) + furrow;
        texColor = mix(texColor, soil, 0.75);
      }

      // Preserve subtle ambient variation and lighting
      diffuseColor.rgb = texColor * vColor.rgb * 1.30;

      // Fog of war smooth penumbra & deep charcoal shroud (V13, #94)
      if (uFogMapSize > 0.0) {
        vec2 d = vec2(1.5 / uFogMapSize);
        vec2 cUv = vFogUv;

        vec4 s0 = mix(texture2D(uFogPrev, cUv), texture2D(uFogCurr, cUv), uBlend);
        vec4 s1 = mix(texture2D(uFogPrev, cUv + vec2(d.x, d.y)), texture2D(uFogCurr, cUv + vec2(d.x, d.y)), uBlend);
        vec4 s2 = mix(texture2D(uFogPrev, cUv + vec2(-d.x, d.y)), texture2D(uFogCurr, cUv + vec2(-d.x, d.y)), uBlend);
        vec4 s3 = mix(texture2D(uFogPrev, cUv + vec2(d.x, -d.y)), texture2D(uFogCurr, cUv + vec2(d.x, -d.y)), uBlend);
        vec4 s4 = mix(texture2D(uFogPrev, cUv + vec2(-d.x, -d.y)), texture2D(uFogCurr, cUv + vec2(-d.x, -d.y)), uBlend);

        vec2 smoothFog = (s0.rg * 2.0 + s1.rg + s2.rg + s3.rg + s4.rg) / 6.0;
        float rawExplored = smoothFog.r * 255.0;
        float rawVisible = smoothFog.g * 255.0;

        float exploredFactor = smoothstep(0.05, 0.95, rawExplored);
        float visibleFactor = smoothstep(0.05, 0.95, rawVisible);

        float exploredBrightness = mix(0.52, 1.0, visibleFactor);
        vec3 exploredTerrain = diffuseColor.rgb * exploredBrightness;
        vec3 deepCharcoal = vec3(0.04, 0.05, 0.07);
        diffuseColor.rgb = mix(deepCharcoal, exploredTerrain, exploredFactor);
      }`,
    );
  };

  const baseMesh = new Mesh(merged, material);
  const mesh = Object.assign(baseMesh, {
    uTime,
    waterUniforms,
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
