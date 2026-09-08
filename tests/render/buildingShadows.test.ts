import { Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  createBuildingShadowMaterial,
  createBuildingShadowMesh,
  MAX_BUILDING_SHADOWS,
  updateBuildingShadows,
} from "../../src/render/buildingShadows";

import { buildLayers } from "../../src/sim/world/layers";

describe("Building Ground Contact Shadows (Issue #99)", () => {
  it("creates an instanced mesh with flat XZ geometry and shader material", () => {
    const mesh = createBuildingShadowMesh(128);
    expect(mesh.name).toBe("building-ground-shadows");
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    expect(mesh.renderOrder).toBe(1);
    expect(mesh.instanceMatrix).toBeDefined();

    // Check geometry
    const geom = mesh.geometry;
    expect(geom.attributes.position).toBeDefined();
    expect(geom.attributes.uv).toBeDefined();

    // Check material
    const mat = mesh.material;
    expect(mat).toBeDefined();
    expect((mat as any).transparent).toBe(true);
    expect((mat as any).depthWrite).toBe(false);
  });

  it("material includes elliptical smoothstep falloff in fragment shader", () => {
    const mat = createBuildingShadowMaterial();
    expect(mat.vertexShader).toContain("instanceMatrix");
    expect(mat.vertexShader).toContain("vUv = uv;");
    expect(mat.fragmentShader).toContain("smoothstep");
    expect(mat.fragmentShader).toContain("discard");
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
  });

  it("defaults capacity to MAX_BUILDING_SHADOWS (512)", () => {
    expect(MAX_BUILDING_SHADOWS).toBe(512);
    const mesh = createBuildingShadowMesh();
    // In Three.js, instancedMesh.instanceMatrix.count is capacity
    expect(mesh.instanceMatrix.count).toBe(512);
  });

  it("updates shadowMesh instances proportionally and scales with building footprint", () => {
    const mesh = createBuildingShadowMesh(128);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);

    const dummyLayers = buildLayers(
      new Uint8Array(64 * 64).fill(3),
      new Uint8Array(64 * 64),
    );

    // 2 buildings: a wall (1x1 at origin 10, 10) and a town center (4x4 at origin 20, 20)
    const frame = {
      count: 2,
      eids: new Int32Array([101, 102]),
      origins: new Float32Array([10, 10, 20, 20]),
      sizes: new Float32Array([1, 1, 4, 4]),
      states: new Uint8Array([1, 1]),
      progress: new Float32Array([1, 1]),
    };

    const count = updateBuildingShadows(mesh, frame as any, dummyLayers as any);

    expect(count).toBe(2);
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(2);

    // Verify matrix 0 (Wall 1x1: center 10.5, 10.5, scale 1.15, 1.15)
    const mat0 = new Matrix4();
    mesh.getMatrixAt(0, mat0);
    const pos0 = new Vector3();
    const quat0 = new Quaternion();
    const scale0 = new Vector3();
    mat0.decompose(pos0, quat0, scale0);
    expect(pos0.x).toBeCloseTo(10.5);
    expect(pos0.z).toBeCloseTo(10.5);
    expect(scale0.x).toBeCloseTo(1.15);
    expect(scale0.z).toBeCloseTo(1.15);

    // Verify matrix 1 (Town center 4x4: center 22, 22, scale 4.6, 4.6)
    const mat1 = new Matrix4();
    mesh.getMatrixAt(1, mat1);
    const pos1 = new Vector3();
    const quat1 = new Quaternion();
    const scale1 = new Vector3();
    mat1.decompose(pos1, quat1, scale1);
    expect(pos1.x).toBeCloseTo(22);
    expect(pos1.z).toBeCloseTo(22);
    expect(scale1.x).toBeCloseTo(4.6);
    expect(scale1.z).toBeCloseTo(4.6);

    // Frame with 0 buildings hides shadowMesh
    const emptyFrame = {
      count: 0,
      eids: new Int32Array(0),
      origins: new Float32Array(0),
      sizes: new Float32Array(0),
      states: new Uint8Array(0),
      progress: new Float32Array(0),
    };
    updateBuildingShadows(mesh, emptyFrame as any, dummyLayers as any);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
  });

  it("skips ghost buildings when isGhost filter is provided", () => {
    const mesh = createBuildingShadowMesh(128);
    const dummyLayers = buildLayers(
      new Uint8Array(64 * 64).fill(3),
      new Uint8Array(64 * 64),
    );

    const frame = {
      count: 2,
      eids: new Int32Array([101, 102]),
      origins: new Float32Array([10, 10, 20, 20]),
      sizes: new Float32Array([1, 1, 4, 4]),
      states: new Uint8Array([1, 1]),
      progress: new Float32Array([1, 1]),
    };

    // Filter out index 0 as ghost
    const count = updateBuildingShadows(
      mesh,
      frame as any,
      dummyLayers as any,
      (idx) => idx === 0,
    );
    expect(count).toBe(1);
    expect(mesh.count).toBe(1);

    // Only the second building (town center) was rendered
    const mat = new Matrix4();
    mesh.getMatrixAt(0, mat);
    const pos = new Vector3();
    const quat = new Quaternion();
    const scale = new Vector3();
    mat.decompose(pos, quat, scale);
    expect(pos.x).toBeCloseTo(22);
    expect(pos.z).toBeCloseTo(22);
  });
});
