/**
 * Software triangle rasterizer for the atlas bake — the bake's
 * "renderer" back-end.
 *
 * SWAP(gpu): this file stands in for a WebGLRenderer + RenderTarget +
 * readPixels path. three.js still owns ALL scene-graph, animation,
 * skinning-pose and camera math; only final triangle coverage runs on
 * the CPU, into an RGBA byte buffer + float z-buffer. Replacing it with
 * a headless GL context later touches exactly this file plus index.ts's
 * render call — layout/compositing/indexing are unaffected.
 *
 * Determinism: fixed pixel-center sampling, one winding rule, no
 * randomness or clock reads anywhere.
 */

import {
  BufferAttribute,
  Matrix3,
  Matrix4,
  OrthographicCamera,
  Vector3,
  type BufferGeometry,
  type Mesh,
  type Object3D,
} from "three";

export interface Framebuffer {
  width: number;
  height: number;
  /** RGBA8888, row-major, top-left origin. */
  rgba: Uint8Array;
  /** Per-pixel depth in NDC z; smaller = closer. */
  depth: Float32Array;
}

export function createFramebuffer(size: number): Framebuffer {
  return {
    width: size,
    height: size,
    rgba: new Uint8Array(size * size * 4),
    depth: new Float32Array(size * size).fill(Infinity),
  };
}

export function clearFramebuffer(fb: Framebuffer): void {
  fb.rgba.fill(0);
  fb.depth.fill(Infinity);
}

/** A world-space triangle ready for projection. */
export interface WorldTri {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  nx: number;
  ny: number;
  nz: number;
}

const LIGHT = (() => {
  const [x, y, z] = [-0.45, 0.8, 0.4];
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
})();

/**
 * Rasterize one frame view: project `tris` through the ortho MVP and
 * flat-shade by world-normal · light into `fb`. Base gray is tint-
 * neutral so the runtime teamTint multiplies cleanly.
 *
 * `model` optionally places the triangle set before projection — used
 * by the bake to rasterize one skinned pose at 8 yaws without re-
 * evaluating skinning (a pure Y-rotation, so normals rotate by it
 * directly). Lighting stays world-fixed: turning the rig changes its
 * shading exactly like a physical turntable under a fixed lamp.
 */
export function rasterizeView(
  fb: Framebuffer,
  tris: readonly WorldTri[],
  mvp: Matrix4,
  model?: Matrix4,
): void {
  const { width, height } = fb;
  const e = mvp.elements;
  const px = new Float64Array(3);
  const py = new Float64Array(3);
  const pz = new Float64Array(3);
  const normalRotate = model ?? null;

  triLoop: for (let t = 0; t < tris.length; t++) {
    const src = tris[t]!;
    let tri = src;
    if (normalRotate) {
      tri = rotateTri(src, normalRotate);
    }
    const xs = [tri.ax, tri.bx, tri.cx];
    const ys = [tri.ay, tri.by, tri.cy];
    const zs = [tri.az, tri.bz, tri.cz];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < 3; v++) {
      const x = xs[v]!;
      const y = ys[v]!;
      const z = zs[v]!;
      const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
      if (!Number.isFinite(cw) || cw <= 0) continue triLoop;
      const invW = 1 / cw;
      const ndcX = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * invW;
      const ndcY = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * invW;
      const ndcZ = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * invW;
      if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) continue triLoop;
      if (ndcZ < -1 || ndcZ > 1) continue triLoop;
      px[v] = (ndcX * 0.5 + 0.5) * width;
      py[v] = (1 - (ndcY * 0.5 + 0.5)) * height; // image space: top-down
      pz[v] = ndcZ;
      if (px[v]! < minX) minX = px[v]!;
      if (px[v]! > maxX) maxX = px[v]!;
      if (py[v]! < minY) minY = py[v]!;
      if (py[v]! > maxY) maxY = py[v]!;
    }
    if (maxX < 0 || maxY < 0 || minX >= width || minY >= height) continue;

    // Flat shade from the world-space normal.
    const lambert = Math.max(
      0,
      tri.nx * LIGHT[0]! + tri.ny * LIGHT[1]! + tri.nz * LIGHT[2]!,
    );
    const shade = Math.round(150 + 105 * lambert);
    const r = shade;
    const g = shade;
    const b = Math.min(255, shade + 6); // whisper of coolness

    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(width - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height - 1, Math.ceil(maxY));
    if (x1 < x0 || y1 < y0) continue;

    const xA = px[0]!;
    const yA = py[0]!;
    const xB = px[1]!;
    const yB = py[1]!;
    const xC = px[2]!;
    const yC = py[2]!;
    const area = (xB - xA) * (yC - yA) - (xC - xA) * (yB - yA);
    if (area === 0) continue;
    const invArea = 1 / area;

    for (let sy = y0; sy <= y1; sy++) {
      const cyPix = sy + 0.5;
      for (let sx = x0; sx <= x1; sx++) {
        const cxPix = sx + 0.5;
        const wB =
          ((cxPix - xA) * (yC - yA) - (xC - xA) * (cyPix - yA)) * invArea;
        const wC =
          ((xB - xA) * (cyPix - yA) - (cxPix - xA) * (yB - yA)) * invArea;
        const wA = 1 - wB - wC;
        if (wA < 0 || wB < 0 || wC < 0) continue;
        const z = wA * pz[0]! + wB * pz[1]! + wC * pz[2]!;
        const idx = sy * width + sx;
        if (z >= fb.depth[idx]!) continue;
        fb.depth[idx] = z;
        const o = idx * 4;
        fb.rgba[o] = r;
        fb.rgba[o + 1] = g;
        fb.rgba[o + 2] = b;
        fb.rgba[o + 3] = 255;
      }
    }
  }
}

// ---- Scene flattening --------------------------------------------------------

/**
 * Apply a rigid transform to one world-space triangle. Used for the
 * per-yaw pass over a cached skinned pose: positions rotate, normals
 * rotate with them (pure rotation ⇒ normal matrix = the rotation).
 */
const _rotV = new Vector3();
function rotateTri(tri: WorldTri, m: Matrix4): WorldTri {
  const rot = (
    x: number,
    y: number,
    z: number,
  ): { x: number; y: number; z: number } => {
    _rotV.set(x, y, z).applyMatrix4(m);
    return { x: _rotV.x, y: _rotV.y, z: _rotV.z };
  };
  const a = rot(tri.ax, tri.ay, tri.az);
  const b = rot(tri.bx, tri.by, tri.bz);
  const c = rot(tri.cx, tri.cy, tri.cz);
  const n = rot(tri.nx, tri.ny, tri.nz);
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  return {
    ax: a.x,
    ay: a.y,
    az: a.z,
    bx: b.x,
    by: b.y,
    bz: b.z,
    cx: c.x,
    cy: c.y,
    cz: c.z,
    nx: n.x / len,
    ny: n.y / len,
    nz: n.z / len,
  };
}

/**
 * Walk a scene (after updateMatrixWorld) and collect every mesh's
 * triangles in world space.
 *
 * SWAP(skinning) — RESOLVED (ASSET-INVENTORY change #2): SkinnedMesh
 * vertices now go through three's own CPU skinning path
 * (`getVertexPosition` → bone-weighted blend in mesh-local space)
 * before the world matrix. Skinned surfaces derive FLAT face normals
 * from the blended positions — bind-pose attribute normals would be
 * wrong under deformation, and flat shading is the bake's look anyway.
 */
export function flattenScene(root: Object3D): WorldTri[] {
  const tris: WorldTri[] = [];
  const normalMatrix = new Matrix3();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const skinned =
      (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
    const geometry = mesh.geometry as BufferGeometry;
    const position = geometry.getAttribute("position") as BufferAttribute;
    const normalAttr = skinned
      ? undefined
      : (geometry.getAttribute("normal") as BufferAttribute | undefined);
    const world = mesh.matrixWorld;
    normalMatrix.getNormalMatrix(world);
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;

    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i)! : i;
      const ib = index ? index.getX(i + 1)! : i + 1;
      const ic = index ? index.getX(i + 2)! : i + 2;
      const a = worldVertex(position, ia!, world, mesh, skinned);
      const b = worldVertex(position, ib!, world, mesh, skinned);
      const c = worldVertex(position, ic!, world, mesh, skinned);

      let nx: number;
      let ny: number;
      let nz: number;
      if (normalAttr) {
        nx =
          normalMatrix.elements[0]! * normalAttr.getX(ia!)! +
          normalMatrix.elements[3]! * normalAttr.getY(ia!)! +
          normalMatrix.elements[6]! * normalAttr.getZ(ia!)!;
        ny =
          normalMatrix.elements[1]! * normalAttr.getX(ia!)! +
          normalMatrix.elements[4]! * normalAttr.getY(ia!)! +
          normalMatrix.elements[7]! * normalAttr.getZ(ia!)!;
        nz =
          normalMatrix.elements[2]! * normalAttr.getX(ia!)! +
          normalMatrix.elements[5]! * normalAttr.getY(ia!)! +
          normalMatrix.elements[8]! * normalAttr.getZ(ia!)!;
      } else {
        // Face normal from the TRANSFORMED positions (correct under
        // skinning; also the fallback for normal-less geometry).
        const ux = b.x - a.x;
        const uy = b.y - a.y;
        const uz = b.z - a.z;
        const vx = c.x - a.x;
        const vy = c.y - a.y;
        const vz = c.z - a.z;
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
      }

      tris.push({
        ax: a.x,
        ay: a.y,
        az: a.z,
        bx: b.x,
        by: b.y,
        bz: b.z,
        cx: c.x,
        cy: c.y,
        cz: c.z,
        ...normalized(nx, ny, nz),
      });
    }
  });
  return tris;
}

const va = new Vector3();

function worldVertex(
  attr: BufferAttribute,
  i: number,
  m: Matrix4,
  mesh: Mesh,
  skinned: boolean,
): Vector3 {
  if (!skinned) {
    return va
      .set(attr.getX(i)!, attr.getY(i)!, attr.getZ(i)!)
      .applyMatrix4(m)
      .clone();
  }
  // CPU skinning via three's own implementation; returns a vertex in
  // MESH-LOCAL space, then the usual world matrix applies.
  const sm = mesh as unknown as {
    getVertexPosition?(index: number, target: Vector3): Vector3;
  };
  const v = new Vector3();
  if (sm.getVertexPosition) {
    sm.getVertexPosition(i, v);
  } else {
    v.set(attr.getX(i)!, attr.getY(i)!, attr.getZ(i)!);
  }
  return v.applyMatrix4(m);
}

function normalized(
  x: number,
  y: number,
  z: number,
): { nx: number; ny: number; nz: number } {
  const len = Math.hypot(x, y, z) || 1;
  return { nx: x / len, ny: y / len, nz: z / len };
}

/**
 * Build the bake turntable's MVP: orthographic camera at horizontal
 * azimuth 0 (eye on +Z looking −Z), pitched up by `pitchRad`, framing
 * `halfExtent` world units across each axis. The rig itself rotates;
 * the camera never does — that symmetry is what makes yaw cell k equal
 * "viewed at relative angle k·τ/8" at runtime.
 */
export function turntableMvp(options: {
  halfExtent: number;
  pitchRad: number;
  distance: number;
  focusY: number;
}): Matrix4 {
  const camera = new OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0.01,
    options.distance * 4,
  );
  camera.left = -options.halfExtent;
  camera.right = options.halfExtent;
  camera.top = options.halfExtent;
  camera.bottom = -options.halfExtent;
  camera.position.set(
    0,
    options.focusY + Math.sin(options.pitchRad) * options.distance,
    options.focusY + Math.cos(options.pitchRad) * options.distance,
  );
  camera.lookAt(0, options.focusY, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
}
