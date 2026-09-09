/**
 * Placement system tests — SPEC §2.6/§2.13 / M1-T10.
 *
 * Hand-authored 16×16 grids: valid placement escrows the full cost up
 * front, blocks footprint tiles the same tick and bumps the passability
 * version; invalid footprints (water, overlap, out-of-bounds, resource
 * nodes, unaffordable) throw loudly without touching the ledger; and a
 * placement dropped into a walking unit's corridor forces an individual
 * re-path through the standard ADR-0003 invalidation without ever
 * losing the unit.
 */
import { describe, expect, it } from "vitest";
import { buildingCodeOf, buildingIdOfCode } from "../src/data/definitions";
import {
  defineSimComponents,
  getBuildingSiteRow,
  getPosition,
  getResourceNodeRow,
  spawnResourceNode,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createMovementDiagnostics,
  createMovementSystem,
} from "../src/sim/systems/movement";
import {
  PLACE_BUILDING_KIND,
  canAfford,
  createPlacementSystem,
  validatePlacement,
} from "../src/sim/systems/placement";
import {
  TERRAIN_GRASS,
  TERRAIN_WATER,
  buildLayers,
} from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

const OPEN_16: readonly string[] = Array.from({ length: 16 }, () =>
  ".".repeat(16),
);

/** '#' tiles become water (impassable); everything else grass. */
function worldFromAscii(
  rows: readonly string[],
  seed: number,
  pathScheduler?: PathScheduler,
): World {
  const size = rows.length;
  if (rows.some((row) => row.length !== size))
    throw new Error("grid must be square");
  const terrainType = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      terrainType[y * size + x] =
        rows[y]![x] === "#" ? TERRAIN_WATER : TERRAIN_GRASS;
    }
  }
  return createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler,
  });
}

interface Harness {
  readonly world: World;
  readonly comps: SimComponents;
  readonly paths: PathScheduler;
  readonly movement: ReturnType<typeof createMovementDiagnostics>;
}

function harness(rows: readonly string[] = OPEN_16, seed = 424242): Harness {
  const paths = new PathScheduler(createSynchronousPathTransport());
  const world = worldFromAscii(rows, seed, paths);
  const comps = defineSimComponents(world);
  const movement = createMovementDiagnostics();
  registerSystem(world, createMovementSystem(comps, paths, movement));
  registerSystem(world, createPlacementSystem(comps));
  createPlayerStockpile(
    world,
    comps,
    PLAYER_ONE,
    [500, 1000, 200, 200, 0, 0, 0],
  );
  return { world, comps, paths, movement };
}

function place(
  world: World,
  defId: string,
  tileX: number,
  tileY: number,
  targetTick?: number,
): void {
  world.inbox.submit({
    kind: PLACE_BUILDING_KIND,
    targetTick: targetTick ?? world.tick + 1,
    data: { defId, tileX, tileY },
  });
}

/** Submit for the very next tick and advance one step. */
function placeAndStep(
  world: World,
  defId: string,
  tileX: number,
  tileY: number,
): void {
  place(world, defId, tileX, tileY);
  step(world);
}

describe("placement system", () => {
  it("escrows the full cost up front, spawns a site and blocks its tiles", () => {
    const { world, comps, paths } = harness();
    place(world, "house", 4, 4);
    step(world);

    // Stockpile takes eid 1; the site is the next entity.
    // Row layout [playerId, defCode, progress, hp]; the def code comes
    // from the registry's ascending-slug assignment (M2 content
    // renumbered). Sites spawn at full definition hp (M2-T7: they are
    // attackable from placement day one).
    expect(getBuildingSiteRow(world, comps, 2)).toEqual([
      0,
      buildingCodeOf("house"),
      0,
      550,
    ]);
    // Full wood cost left the stockpile at PLACEMENT, not completion.
    expect(stockpileAmountsOf(world, comps, PLAYER_ONE)[1]).toBe(1000 - 30);
    // Every footprint tile is impassable the same tick…
    const passability = world.layers.derivedPassability;
    for (let y = 4; y <= 5; y++) {
      for (let x = 4; x <= 5; x++) {
        expect(passability[y * world.layers.size + x]).toBe(0);
      }
    }
    // …and the scheduler version bumped exactly once so in-flight
    // path responses from before placement are discarded (ADR-0003).
    expect(paths.passabilityVersion).toBe(1);
  });

  it("rejects water footprints loudly without touching the ledger", () => {
    const rows = [...OPEN_16];
    rows[8] = "........##......"; // water at (8,8) and (9,8)
    const { world, comps } = harness(rows);
    place(world, "house", 8, 8); // covers the water tile (8,8)
    expect(() => step(world)).toThrow(/water/);
    expect(getBuildingSiteRow(world, comps, 2)).toBeUndefined();
    expect(stockpileAmountsOf(world, comps, PLAYER_ONE)[1]).toBe(1000);
    expect(world.layers.derivedPassability[8 * 16 + 8]).toBe(0); // still water
  });

  it("rejects out-of-bounds footprints", () => {
    const { world } = harness();
    expect(() => placeAndStep(world, "house", -1, 4)).toThrow(/out-of-bounds/);
    expect(() => placeAndStep(world, "house", 15, 15)).toThrow(/out-of-bounds/);
    // A 3×3 footprint anchored inside still crosses the 16-grid edge.
    expect(() => placeAndStep(world, "town-center", 14, 14)).toThrow(
      /out-of-bounds/,
    );
  });

  it("rejects overlapping sites and finished buildings as occupied", () => {
    const { world } = harness();
    placeAndStep(world, "house", 4, 4);
    expect(() => placeAndStep(world, "barracks", 3, 3)).toThrow(/occupied/);
    expect(() => placeAndStep(world, "house", 5, 5)).toThrow(/occupied/);
  });

  it("rejects footprints covering resource nodes", () => {
    const { world, comps } = harness();
    const node = spawnResourceNode(world, comps, 8, 8, 1 /* wood */, 50);
    expect(() => placeAndStep(world, "house", 7, 7)).toThrow(/occupied/);
    // Depleted nodes stop blocking (row store arrays are mutable; the
    // component getter only widens them read-only for callers).
    const nodeRow = getResourceNodeRow(world, comps, node)! as number[];
    nodeRow[1] = 0;
    placeAndStep(world, "house", 7, 7);
    expect(getBuildingSiteRow(world, comps, 3)).toBeDefined();
  });

  it("rejects placements the owner cannot afford, ledger untouched", () => {
    const { world, comps } = harness();
    const rows = world.rowsByComponentId.get(comps.stockpileId)!;
    for (const row of rows.values()) row[2] = 10; // 10 wood only
    expect(canAfford(world, comps, PLAYER_ONE, "house")).toBe(false);
    place(world, "house", 4, 4);
    expect(() => step(world)).toThrow(/cannot afford placement of house/);
    expect(stockpileAmountsOf(world, comps, PLAYER_ONE)[1]).toBe(10);
  });

  it("validatePlacement reports one shared verdict with the command path", () => {
    const { world, comps } = harness();
    expect(validatePlacement(world, comps, "nope", 4, 4).reason).toBe(
      "unknown-def",
    );
    expect(validatePlacement(world, comps, "house", 4, 4)).toMatchObject({
      ok: true,
    });
    place(world, "house", 4, 4);
    step(world);
    // The placed site already blocks its tiles, so the same origin now
    // fails on passability first — either way it is not placeable.
    expect(validatePlacement(world, comps, "house", 4, 4).ok).toBe(false);
    expect(validatePlacement(world, comps, "house", 8, 8)).toMatchObject({
      ok: true,
    });
  });

  it("placement in a walker's corridor bumps the version and repaths it", () => {
    const { world, comps, movement } = harness();
    const villager = spawnUnit(world, comps, 2.5, 2.5);
    world.inbox.submit({
      kind: "groupMove",
      targetTick: 1,
      data: { entityIds: [villager], x: 14, y: 2 },
    });
    // Let the leader path apply (dueTick = issue + 2) and start walking.
    for (let i = 0; i < 12; i++) step(world);
    expect(movement.groupMoves).toBe(1);

    // Drop a house across the corridor row ahead of the walker.
    place(world, "house", 7, 1, world.tick + 1);
    step(world);

    // The per-tick segment raycast must notice the new blocker and issue
    // an individual re-path — the ADR-0003 invalidation contract.
    let repathed = false;
    for (let i = 0; i < 240 && !repathed; i++) {
      step(world);
      if (movement.repaths > 0) repathed = true;
    }
    expect(repathed).toBe(true);

    // The rerouted unit still reaches its destination slot.
    let arrived = false;
    for (let i = 0; i < 900 && !arrived; i++) {
      step(world);
      const pos = getPosition(world, comps, villager);
      arrived = Math.abs(pos.x - 14) < 0.75 && Math.abs(pos.y - 2) < 0.75;
    }
    expect(arrived).toBe(true);
  });

  describe("hybrid shoreline dock placement (Issue #108 / N1)", () => {
    // 16x16 world: Rows 0..7 are land (.), Rows 8..15 are water (#)
    const SHORELINE_WORLD: readonly string[] = [
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "################",
      "################",
      "################",
      "################",
      "################",
      "################",
      "################",
      "################",
    ];

    it("rejects dock placement on pure inland (no water tiles)", () => {
      const { world, comps } = harness(SHORELINE_WORLD);
      const check = validatePlacement(world, comps, "dock", 4, 2);
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("dock-needs-water");
    });

    it("rejects dock placement in open sea (no land tiles)", () => {
      const { world, comps } = harness(SHORELINE_WORLD);
      const check = validatePlacement(world, comps, "dock", 4, 11);
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("dock-needs-land");
    });

    it("accepts dock placement straddling the shoreline with exterior water and land", () => {
      const { world, comps } = harness(SHORELINE_WORLD);
      // y=6: footprint spans y=6 (land), y=7 (land), y=8 (water)
      // exterior land at y=5, exterior water at y=9
      const check1 = validatePlacement(world, comps, "dock", 4, 6);
      expect(check1.ok).toBe(true);
      expect(check1.rect).toEqual({ x: 4, y: 6, width: 3, height: 3 });

      // y=7: footprint spans y=7 (land), y=8 (water), y=9 (water)
      // exterior land at y=6, exterior water at y=10
      const check2 = validatePlacement(world, comps, "dock", 4, 7);
      expect(check2.ok).toBe(true);
      expect(check2.rect).toEqual({ x: 4, y: 7, width: 3, height: 3 });
    });

    it("rejects dock when interior has water but exterior lacks navigable water", () => {
      // 1x1 puddle at (7, 7) inside all-land map
      const puddleWorld = Array.from({ length: 16 }, (_, y) => {
        if (y === 7) return ".......#........";
        return "................";
      });
      const { world, comps } = harness(puddleWorld);
      // Footprint 6..8: contains (7, 7) puddle, but border (y=5, y=9, x=5, x=9) has no water
      const check = validatePlacement(world, comps, "dock", 6, 6);
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("dock-needs-water");
    });

    it("rejects dock when interior has land but exterior lacks passable land", () => {
      // 1x1 island at (7, 7) inside all-water map
      const islandWorld = Array.from({ length: 16 }, (_, y) => {
        if (y === 7) return "#######.########";
        return "################";
      });
      const { world, comps } = harness(islandWorld);
      // Footprint 6..8: contains (7, 7) island, but border has no land
      const check = validatePlacement(world, comps, "dock", 6, 6);
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("dock-needs-land");
    });

    it("escrows 150 wood at placement, spawns site, and blocks footprint tiles", () => {
      const { world, comps } = harness(SHORELINE_WORLD);
      const initialWood = stockpileAmountsOf(world, comps, PLAYER_ONE)[1]!; // 1000 wood
      expect(initialWood).toBe(1000);

      place(world, "dock", 4, 6);
      step(world);

      // 150 wood debited
      const postWood = stockpileAmountsOf(world, comps, PLAYER_ONE)[1]!;
      expect(postWood).toBe(850);

      // Site spawned
      const siteEid = world.entities.find((eid) =>
        getBuildingSiteRow(world, comps, eid),
      );
      expect(siteEid).toBeDefined();
      const siteRow = getBuildingSiteRow(world, comps, siteEid!)!;
      expect(buildingIdOfCode(siteRow[1]!)).toBe("dock");

      // Footprint blocked in passability
      const pass = world.layers.derivedPassability;
      const size = world.layers.size;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          expect(pass[(6 + dy) * size + (4 + dx)]).toBe(0);
        }
      }
    });
  });
});
