/**
 * M1-T3 golden harness — SPEC §7.
 *
 * Generates the pinned-seed 32×32 map headlessly, records the FNV-1a-64
 * map hash as a milestone (plus a reload-from-bytes hash, an elevation
 * histogram and the full terrain grid for review), and runs the whole
 * pipeline twice as an extended determinism canary. Milestones
 * regenerate only through `npm run golden:record`; hand-edited values
 * fail every normal run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateMap } from "../../../src/sim/mapgen/generate";
import {
  deserializeLayers,
  layersHash,
  MAX_ELEVATION_LEVEL,
  serializeLayers,
  TERRAIN_TYPE_NAMES,
  type WorldLayers,
} from "../../../src/sim/world/layers";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture case.json must be an object");
  }
  const box = raw as Record<string, unknown>;
  if (typeof box.seed !== "number" || typeof box.size !== "number") {
    throw new Error("fixture case.json requires numeric seed and size");
  }
  return {
    name: String(box.name),
    seed: box.seed,
    size: box.size,
  };
}

/** One hex digit per terrain id, one row string per grid row. */
function renderTerrainRows(layers: WorldLayers): string[] {
  const rows: string[] = [];
  for (let y = 0; y < layers.size; y++) {
    let row = "";
    for (let x = 0; x < layers.size; x++) {
      row += layers.terrainType[y * layers.size + x]!.toString(16);
    }
    rows.push(row);
  }
  return rows;
}

function elevationHistogram(layers: WorldLayers): number[] {
  const histogram = new Array<number>(MAX_ELEVATION_LEVEL + 1).fill(0);
  for (let i = 0; i < layers.elevationLevel.length; i++) {
    histogram[layers.elevationLevel[i]!]! += 1;
  }
  return histogram;
}

interface MapArtifact {
  readonly mapHash: string;
  readonly restoredMapHash: string;
  readonly restoredByteCount: number;
  readonly elevationHistogram: number[];
  /** Legend mapping each hex digit to its terrain name. */
  readonly terrainLegend: Readonly<Record<string, string>>;
  readonly terrainRows: readonly string[];
}

function generateArtifact(seed: number, size: number): MapArtifact {
  const original = generateMap(seed, size);
  const bytes = serializeLayers(original);
  const restored = deserializeLayers(bytes);
  return {
    mapHash: layersHash(original),
    restoredMapHash: layersHash(restored),
    restoredByteCount: bytes.length,
    elevationHistogram: elevationHistogram(original),
    terrainLegend: Object.fromEntries(
      TERRAIN_TYPE_NAMES.map((name, id) => [id.toString(16), name]),
    ),
    terrainRows: renderTerrainRows(original),
  };
}

installSimPurityShims();

describe("golden harness m1t3", () => {
  const fixture = loadGoldenCase();

  it("records the pinned-seed map hash milestone", () => {
    const artifact = generateArtifact(fixture.seed, fixture.size);
    expect(artifact.restoredByteCount).toBe(3 * fixture.size * fixture.size);
    expect(artifact.mapHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(artifact).toMatchSnapshot();
  });

  it("reload-from-bytes reproduces the world exactly", () => {
    const artifact = generateArtifact(fixture.seed, fixture.size);
    expect(artifact.restoredMapHash).toBe(artifact.mapHash);
  });

  it("double-run canary: independent generations are byte-identical", () => {
    const first = generateArtifact(fixture.seed, fixture.size);
    const second = generateArtifact(fixture.seed, fixture.size);
    expect(second).toEqual(first);
  });
});
