import { describe, expect, it } from "vitest";
import {
  createBuildingShadowMaterial,
  createBuildingShadowMesh,
  MAX_BUILDING_SHADOWS,
  updateBuildingShadows,
} from "../../src/render/buildingShadows";
import type { BuildingSnapshotFrame } from "../../src/sim/mirror";
import { buildLayers } from "../../src/sim/world/layers";

function getShadowInstanceTransform(
  mesh: ReturnType<typeof createBuildingShadowMesh>,
  index: number,
) {
  const arr = mesh.instanceMatrix.array;
  const offset = index * 16;
  return {
    posX: arr[offset + 12],
    posY: arr[offset + 13],
    posZ: arr[offset + 14],
    scaleX: arr[offset + 0],
    scaleZ: arr[offset + 10],
  };
}

function createMockBuildingFrame(
  partial: Partial<BuildingSnapshotFrame> = {},
): BuildingSnapshotFrame {
  return {
    count: partial.count ?? 0,
    eids: partial.eids ?? new Int32Array(0),
    origins: partial.origins ?? new Float32Array(0),
    sizes: partial.sizes ?? new Float32Array(0),
    states: partial.states ?? new Uint8Array(0),
    progress: partial.progress ?? new Float32Array(0),
    defCodes: partial.defCodes ?? new Uint8Array(0),
    ownerIds: partial.ownerIds ?? new Uint8Array(0),
    ageRanks: partial.ageRanks ?? new Uint8Array(0),
  };
}

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
    const mat = mesh.material as { transparent?: boolean; depthWrite?: boolean };
    expect(mat).toBeDefined();
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
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
    const frame = createMockBuildingFrame({
      count: 2,
      eids: new Int32Array([101, 102]),
      origins: new Float32Array([10, 10, 20, 20]),
      sizes: new Float32Array([1, 1, 4, 4]),
      states: new Uint8Array([1, 1]),
      progress: new Float32Array([1, 1]),
    });

    const count = updateBuildingShadows(mesh, frame, dummyLayers);

    expect(count).toBe(2);
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(2);

    // Verify matrix 0 (Wall 1x1: center 10.5, 10.5, scale 1.15, 1.15)
    const t0 = getShadowInstanceTransform(mesh, 0);
    expect(t0.posX).toBeCloseTo(10.5);
    expect(t0.posZ).toBeCloseTo(10.5);
    expect(t0.scaleX).toBeCloseTo(1.15);
    expect(t0.scaleZ).toBeCloseTo(1.15);

    // Verify matrix 1 (Town center 4x4: center 22, 22, scale 4.6, 4.6)
    const t1 = getShadowInstanceTransform(mesh, 1);
    expect(t1.posX).toBeCloseTo(22);
    expect(t1.posZ).toBeCloseTo(22);
    expect(t1.scaleX).toBeCloseTo(4.6);
    expect(t1.scaleZ).toBeCloseTo(4.6);

    // Frame with 0 buildings hides shadowMesh
    const emptyFrame = createMockBuildingFrame({
      count: 0,
      eids: new Int32Array(0),
      origins: new Float32Array(0),
      sizes: new Float32Array(0),
      states: new Uint8Array(0),
      progress: new Float32Array(0),
    });
    updateBuildingShadows(mesh, emptyFrame, dummyLayers);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
  });

  it("skips ghost buildings when isGhost filter is provided", () => {
    const mesh = createBuildingShadowMesh(128);
    const dummyLayers = buildLayers(
      new Uint8Array(64 * 64).fill(3),
      new Uint8Array(64 * 64),
    );

    const frame = createMockBuildingFrame({
      count: 2,
      eids: new Int32Array([101, 102]),
      origins: new Float32Array([10, 10, 20, 20]),
      sizes: new Float32Array([1, 1, 4, 4]),
      states: new Uint8Array([1, 1]),
      progress: new Float32Array([1, 1]),
    });

    // Filter out index 0 as ghost
    const count = updateBuildingShadows(
      mesh,
      frame,
      dummyLayers,
      (idx) => idx === 0,
    );
    expect(count).toBe(1);
    expect(mesh.count).toBe(1);

    // Only the second building (town center) was rendered
    const t0 = getShadowInstanceTransform(mesh, 0);
    expect(t0.posX).toBeCloseTo(22);
    expect(t0.posZ).toBeCloseTo(22);
  });
});
