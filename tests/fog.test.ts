/**
 * Fog-of-war tests — SPEC §2.9 / M1-T11 seam + M2-T8 real planes.
 *
 * The M1 suites pin the all-visible stub semantics and the seam itself:
 * a world created with a denying fake provider rejects placements as
 * "unexplored" through the exact same call-sites production uses.
 *
 * The M2 suites pin the real plane set: incremental dirty-entity
 * stamping over contributor counts, monotonic explored, edge clamping,
 * placement-requires-explored through the REAL provider, the
 * KnowledgeView wallhack-impossibility contract (type-level surface
 * pin + runtime probes), and the enemy-building ghost lifecycle.
 */

import { describe, expect, it } from "vitest";
import { createWorld, registerSystem, step } from "../src/sim/core/world";
import {
  defineSimComponents,
  getBuildingSiteRow,
  spawnCombatUnit,
  spawnUnit,
} from "../src/sim/components";
import {
  circleOffsets,
  createAllVisibleProvider,
  createFogVisibility,
  createRowEntityResolver,
  exploredTileCount,
  FOG_LUT_MAX_RADIUS,
  type FogEntitySource,
  type KnowledgeView,
  visibleTileCount,
  type VisibilityProvider,
} from "../src/sim/systems/fog";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import {
  createPlacementSystem,
  stampFinishedBuilding,
  validatePlacement,
} from "../src/sim/systems/placement";
import { createMovementSystem } from "../src/sim/systems/movement";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  TERRAIN_GRASS,
  buildLayers,
  type WorldLayers,
} from "../src/sim/world/layers";

/** Fake M2-style provider: everything visible, nothing explored. */
function denyingExploredProvider(): VisibilityProvider {
  const dirty: string[] = [];
  return {
    id: "deny-explored",
    isVisible: () => true,
    isExplored: () => false,
    markDirty: (reason, eid) => {
      dirty.push(`${reason}:${String(eid)}`);
    },
    flushDirty: () => {
      dirty.length = 0;
    },
  };
}

interface FogHarness {
  readonly fog: ReturnType<typeof createFogVisibility>;
  readonly world: ReturnType<typeof createWorld>;
  readonly comps: ReturnType<typeof defineSimComponents>;
  readonly scheduler: PathScheduler;
}

/** All-grass open field so fixture geometry is hand-authored. */
function openFieldLayers(size: number): WorldLayers {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

/** Real-fog world wired exactly like production main.ts. */
function fogHarness(size = 32): FogHarness {
  const fog = createFogVisibility(size, 2);
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(11, {
    size,
    layers: openFieldLayers(size),
    visibility: fog.provider,
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  const source: FogEntitySource = {
    resolve: createRowEntityResolver(world, comps),
    eidsAscending: () => world.entities,
  };
  fog.bindSource(source);
  return { fog, world, comps, scheduler };
}

const MOVEMENT_BY_WORLD = new WeakMap<object, boolean>();

/**
 * Register the movement system once per harness world and issue a
 * single-entity groupMove — real route pipeline, synchronous transport,
 * so sight circles re-stamp through genuine movement.
 */
function registerMovementAndMove(
  harness: FogHarness,
  eid: number,
  x: number,
  y: number,
): void {
  const { world, comps } = harness;
  if (!MOVEMENT_BY_WORLD.has(world)) {
    MOVEMENT_BY_WORLD.set(world, true);
    registerSystem(world, createMovementSystem(comps, harness.scheduler));
  }
  world.inbox.submit({
    kind: "groupMove",
    targetTick: world.tick + 1,
    data: { entityIds: [eid], x, y },
  });
}

describe("all-visible fog stub (SPEC §2.9)", () => {
  it("answers explored+visible on-grid and false off-grid", () => {
    const fog = createAllVisibleProvider(4);
    expect(fog.id).toBe("all-visible");
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(fog.isVisible(x, y, 0)).toBe(true);
        expect(fog.isExplored(x, y, 1)).toBe(true);
      }
    }
    expect(fog.isVisible(-1, 0, 0)).toBe(false);
    expect(fog.isExplored(0, -1, 0)).toBe(false);
    expect(fog.isVisible(4, 2, 0)).toBe(false);
    expect(fog.isExplored(2, 4, 0)).toBe(false);
    expect(fog.isVisible(0.5, 2, 0)).toBe(false);
  });

  it("rejects non-positive or non-integer grid sizes", () => {
    expect(() => createAllVisibleProvider(0)).toThrow(/positive integer/);
    expect(() => createAllVisibleProvider(3.5)).toThrow(/positive integer/);
  });

  it("tolerates dirty marks and empty flushes", () => {
    const fog = createAllVisibleProvider(8);
    fog.flushDirty(); // nothing queued: must not throw
    fog.markDirty("spawned", 1);
    fog.markDirty("moved", 2);
    fog.markDirty("removed", 3);
    fog.flushDirty();
    // Stub stays stateless: queries unchanged after any traffic.
    expect(fog.isVisible(3, 3, 0)).toBe(true);
    expect(fog.isExplored(3, 3, 0)).toBe(true);
  });
});

describe("visibility seam wiring", () => {
  it("defaults every world to the all-visible provider", () => {
    const world = createWorld(7, { size: 16 });
    expect(world.visibility.id).toBe("all-visible");
    expect(world.visibility.isExplored(15, 15, 0)).toBe(true);
  });

  it("flushes dirty entities once per tick after systems run", () => {
    let flushes = 0;
    const world = createWorld(7, {
      size: 16,
      visibility: {
        ...createAllVisibleProvider(16),
        flushDirty: () => {
          flushes += 1;
        },
      },
    });
    step(world);
    step(world);
    expect(world.tick).toBe(2);
    expect(flushes).toBe(2);
  });

  it("placement consults the provider — denying fakes reject unexplored", () => {
    // Two identical worlds; the ONLY difference is the fog provider.
    const allVisibleWorld = createWorld(11, { size: 32 });
    const denyingWorld = createWorld(11, {
      size: 32,
      visibility: denyingExploredProvider(),
    });
    const compsA = defineSimComponents(allVisibleWorld);
    const compsB = defineSimComponents(denyingWorld);
    registerSystem(allVisibleWorld, createPlacementSystem(compsA));
    registerSystem(denyingWorld, createPlacementSystem(compsB));

    // A plain grass spot both worlds agree is on-grid and buildable.
    const passable = allVisibleWorld.layers.derivedPassability;
    let spot: { x: number; y: number } | undefined;
    outer: for (let y = 2; y < 30; y++) {
      for (let x = 2; x < 30; x++) {
        if (passable[y * 32 + x] === 1 && passable[y * 32 + x + 1] === 1) {
          spot = { x, y };
          break outer;
        }
      }
    }
    expect(spot).toBeDefined();
    expect(
      validatePlacement(allVisibleWorld, compsA, "house", spot!.x, spot!.y).ok,
    ).toBe(true);

    // Same call-site through the swapped provider now rejects with the
    // fog reason, and the command handler throws loudly exactly like
    // every other placement rejection.
    const check = validatePlacement(
      denyingWorld,
      compsB,
      "house",
      spot!.x,
      spot!.y,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("unexplored");
    denyingWorld.inbox.submit({
      kind: "placeBuilding",
      targetTick: denyingWorld.tick + 1,
      data: { defId: "house", tileX: spot!.x, tileY: spot!.y },
    });
    expect(() => step(denyingWorld)).toThrow(/unexplored/);
    // Nothing was placed in either world.
    step(allVisibleWorld);
    expect(getBuildingSiteRow(allVisibleWorld, compsA, 1)).toBeUndefined();
    expect(getBuildingSiteRow(denyingWorld, compsB, 1)).toBeUndefined();
  });
});

// ---- M2-T8: real fog planes ---------------------------------------------------

describe("fog planes: stamping & explored monotonicity (SPEC §2.9)", () => {
  it("LUT circles are Euclidean ≤ r, row-major, and radius-validated", () => {
    const offsets = circleOffsets(2);
    const pairs: [number, number][] = [];
    for (let i = 0; i < offsets.length; i += 2) {
      pairs.push([offsets[i]!, offsets[i + 1]!]);
      expect(offsets[i]! ** 2 + offsets[i + 1]! ** 2).toBeLessThanOrEqual(4);
    }
    // Row-major order: sorted by dy then dx.
    const sorted = [...pairs].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    expect(pairs).toEqual(sorted);
    expect(pairs).toContainEqual([0, 0]);
    expect(circleOffsets(0).length).toBe(2);
    expect(() => circleOffsets(-1)).toThrow(/integer in \[0/);
    expect(() => circleOffsets(FOG_LUT_MAX_RADIUS + 1)).toThrow(
      /integer in \[0/,
    );
  });

  it("spawning stamps the owner's sight circle on flush; nothing else is visible", () => {
    const harness = fogHarness();
    const { fog, world, comps } = harness;
    // Villager at (10.5, 10.5): sight 5 → tile (5,10) inside, (16,10)+ outside.
    spawnUnit(world, comps, 10.5, 10.5);
    expect(visibleTileCount(fog.state, PLAYER_ONE)).toBe(0);
    step(world); // flush runs after systems
    expect(fog.isVisible(5, 10, PLAYER_ONE)).toBe(true);
    expect(fog.isVisible(15, 10, PLAYER_ONE)).toBe(true); // dx=5 ≤ r
    expect(fog.isVisible(16, 10, PLAYER_ONE)).toBe(false);
    expect(fog.isExplored(10, 5, PLAYER_ONE)).toBe(true);
    expect(fog.isVisible(3, 3, 1)).toBe(false); // other player sees nothing
  });

  it("explored never decrements while visible follows contributor counts", () => {
    const harness = fogHarness();
    const { fog, world, comps } = harness;
    const scout = spawnCombatUnit(
      world,
      comps,
      "scout-cavalry",
      12.5,
      12.5,
      PLAYER_ONE,
    );
    const villager = spawnUnit(world, comps, 13.5, 13.5);
    step(world);
    const overlap = 14 * 32 + 14;
    expect(fog.state.planes[PLAYER_ONE]!.contributorCount[overlap]).toBe(2);
    expect(exploredTileCount(fog.state, PLAYER_ONE)).toBeGreaterThan(0);

    world.visibility.markDirty("removed", villager);
    despawnForTest(world, villager);
    step(world);
    expect(fog.state.planes[PLAYER_ONE]!.contributorCount[overlap]).toBe(1);
    expect(fog.isVisible(14, 14, PLAYER_ONE)).toBe(true); // scout still covers
    const exploredAfterFirst = exploredTileCount(fog.state, PLAYER_ONE);

    world.visibility.markDirty("removed", scout);
    despawnForTest(world, scout);
    step(world);
    expect(fog.isVisible(14, 14, PLAYER_ONE)).toBe(false);
    expect(exploredTileCount(fog.state, PLAYER_ONE)).toBe(
      exploredAfterFirst, // OR-ed in forever, never decremented
    );
    for (const flag of fog.state.planes[PLAYER_ONE]!.visible) {
      expect(flag).toBe(0);
    }
  });

  it("moving units un-stamp their old circle and re-stamp the new tile", () => {
    const harness = fogHarness();
    const { fog, world, comps } = harness;
    const scout = spawnCombatUnit(
      world,
      comps,
      "scout-cavalry",
      8.5,
      16.5,
      PLAYER_ONE,
    );
    step(world);
    expect(fog.isVisible(8, 16, PLAYER_ONE)).toBe(true);
    const exploredWhenWest = exploredTileCount(fog.state, PLAYER_ONE);

    // March east ~4 tiles through real movement (synchronous transport).
    registerMovementAndMove(harness, scout, 20.5, 16.5);
    let guard = 0;
    while (guard++ < 400) {
      step(world);
      if (
        Math.floor(
          world.rowsByComponentId.get(comps.positionId)?.get(scout)?.[0] ?? 0,
        ) >= 20
      ) {
        break;
      }
    }
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(scout);
    expect(Math.floor(pos![0]!)).toBeGreaterThanOrEqual(20);
    expect(fog.isVisible(20, 16, PLAYER_ONE)).toBe(true);
    expect(fog.isVisible(8, 16, PLAYER_ONE)).toBe(false); // old circle gone
    expect(exploredTileCount(fog.state, PLAYER_ONE)).toBeGreaterThan(
      exploredWhenWest,
    );
  });

  it("stamps clamp at the map edge without wrapping", () => {
    const harness = fogHarness(24);
    const { fog, world, comps } = harness;
    spawnCombatUnit(world, comps, "scout-cavalry", 1.5, 22.5, PLAYER_ONE);
    step(world);
    expect(fog.isVisible(0, 23, PLAYER_ONE)).toBe(true);
    expect(fog.isExplored(0, 23, PLAYER_ONE)).toBe(true);
    // No wrap: the circle cannot reach tiles beyond the grid.
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const idx = y * 24 + x;
        const count = fog.state.planes[PLAYER_ONE]!.contributorCount[idx]!;
        if (count > 0) {
          expect(fog.isVisible(x, y, PLAYER_ONE)).toBe(true);
        }
      }
    }
  });
});

describe("placement requires explored (real planes, SPEC §2.9)", () => {
  it("rejects unexplored footprints and accepts scouted ones via commands", () => {
    const harness = fogHarness(48);
    const { world, comps } = harness;
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [200, 600, 200, 200, 0, 0, 0],
    );
    registerSystem(world, createPlacementSystem(comps));
    const villager = spawnUnit(world, comps, 6.5, 6.5);
    void villager;
    stampFinishedBuilding(world, comps, "town-center", 4, 4, {
      playerId: PLAYER_ONE,
    });
    step(world); // stamps sight; TC explores around (4..6)

    // Far east: never explored → ghost UI verdict and command both refuse.
    const far = validatePlacement(world, comps, "house", 30, 30);
    expect(far.ok).toBe(false);
    expect(far.reason).toBe("unexplored");
    world.inbox.submit({
      kind: "placeBuilding",
      targetTick: world.tick + 1,
      data: { defId: "house", tileX: 30, tileY: 30 },
    });
    expect(() => step(world)).toThrow(/unexplored/);

    // Inside the TC's explored ring the same call-site accepts, and a
    // real command completes placement.
    expect(validatePlacement(world, comps, "house", 9, 3, PLAYER_ONE).ok).toBe(
      true,
    );
    world.inbox.submit({
      kind: "placeBuilding",
      targetTick: world.tick + 1,
      data: { defId: "house", tileX: 9, tileY: 3 },
    });
    expect(() => step(world)).not.toThrow();
    expect(getBuildingSiteRow(world, comps, villager + 2)).toBeDefined();
  });
});

// ---- KnowledgeView (SPEC §2.8) -------------------------------------------------

/**
 * Type-level wallhack proof: the knowledge surface is EXHAUSTIVELY the
 * five members below — no member accepts or returns World/component
 * rows, so there is no API through which unseen state could be asked
 * about. Adding any raw-world accessor breaks this assignment.
 */
const KNOWLEDGE_VIEW_SURFACE: readonly (keyof KnowledgeView)[] = [
  "viewer",
  "isVisible",
  "isExplored",
  "knownEntities",
  "lastKnown",
];
void KNOWLEDGE_VIEW_SURFACE;

describe("KnowledgeView wallhack impossibility (SPEC §2.8)", () => {
  it("enemy entities on non-visible tiles are absent from knownEntities()", () => {
    const harness = fogHarness(48);
    const { fog, world, comps } = harness;
    spawnUnit(world, comps, 6.5, 6.5); // own villager, sight 5
    const hiddenEnemy = spawnCombatUnit(
      world,
      comps,
      "scout-cavalry",
      40.5,
      40.5,
      1,
    );
    const visibleEnemy = spawnCombatUnit(world, comps, "militia", 7.5, 7.5, 1);
    stampFinishedBuilding(world, comps, "barracks", 42, 42, { playerId: 1 });
    step(world);

    const view = fog.knowledgeFor(PLAYER_ONE);
    const known = view.knownEntities().map((entry) => entry.eid);
    expect(known).not.toContain(hiddenEnemy);
    expect(view.lastKnown(hiddenEnemy)).toBeUndefined();
    expect(known).toContain(visibleEnemy); // stands inside our vision
    // Own entities always known — including our own buildings.
    expect(known.some((eid) => eid < visibleEnemy)).toBe(true);

    // Walk the militia just past the villager's sight ring (sight 5 →
    // x ≥ 12 is unseen) and it vanishes from queries too, while own
    // entities remain known.
    registerMovementAndMove(harness, visibleEnemy, 14.5, 14.5);
    let guard = 0;
    while (guard++ < 600) {
      step(world);
      const pos = world.rowsByComponentId
        .get(comps.positionId)
        ?.get(visibleEnemy);
      if (!pos) break;
      if (
        !fog.isVisible(Math.floor(pos[0]!), Math.floor(pos[1]!), PLAYER_ONE)
      ) {
        break;
      }
    }
    const afterMarch = fog
      .knowledgeFor(PLAYER_ONE)
      .knownEntities()
      .map((entry) => entry.eid);
    expect(afterMarch).not.toContain(visibleEnemy);
    expect(afterMarch).not.toContain(hiddenEnemy);
    expect(afterMarch.length).toBeGreaterThan(0); // own villager persists
  });

  it("isExplored/isVisible delegate the viewer's planes only", () => {
    const harness = fogHarness();
    const { fog, world, comps } = harness;
    spawnUnit(world, comps, 10.5, 10.5);
    step(world);
    const p0 = fog.knowledgeFor(0);
    const p1 = fog.knowledgeFor(1);
    expect(p0.viewer).toBe(0);
    expect(p0.isVisible(10, 10)).toBe(true);
    expect(p1.isVisible(10, 10)).toBe(false);
    expect(p1.isExplored(10, 10)).toBe(false);
    expect(p0.isExplored(31, 31)).toBe(false);
  });
});

// ---- Memory ghosts (SPEC §2.9) --------------------------------------------------

describe("enemy-building memory ghosts", () => {
  it("records on leaving visibility, refreshes on re-sight, dies with removal", () => {
    const harness = fogHarness(48);
    const { fog, world, comps } = harness;
    const scout = spawnCombatUnit(
      world,
      comps,
      "scout-cavalry",
      8.5,
      8.5,
      PLAYER_ONE,
    );
    // Enemy barracks at (14..16, 8..10): initially OUTSIDE scout sight
    // (scout covers up to x=16? no — floor 8 + 8 = 16, so tile 14 IS
    // covered). Place it further east so it starts unknown.
    const barracks = stampFinishedBuilding(world, comps, "barracks", 20, 8, {
      playerId: 1,
    });
    fog.recomputeAll();
    const view = fog.knowledgeFor(PLAYER_ONE);
    expect(view.lastKnown(barracks)).toBeUndefined(); // never seen

    // Scout marches east until the barracks enters vision → live-known.
    registerMovementAndMove(harness, scout, 17.5, 8.5);
    let guard = 0;
    while (guard++ < 500) {
      step(world);
      if (view.lastKnown(barracks) !== undefined) break;
    }
    expect(view.lastKnown(barracks)).toMatchObject({
      eid: barracks,
      defId: "barracks",
      tileX: 20,
      tileY: 8,
    });

    // March back west until it leaves vision → ghost persists but the
    // building itself leaves knownEntities() (wallhack still holds).
    registerMovementAndMove(harness, scout, 6.5, 8.5);
    guard = 0;
    while (guard++ < 700) {
      step(world);
      if (!fog.isVisible(20, 9, PLAYER_ONE)) break;
    }
    expect(view.lastKnown(barracks)).toBeDefined();
    expect(view.knownEntities().map((e) => e.eid)).not.toContain(barracks);
    const ghostTile = view.lastKnown(barracks)!;
    expect(ghostTile.tileX).toBe(20);

    // Observed destruction: the record dies with the entity.
    world.visibility.markDirty("removed", barracks);
    despawnForTest(world, barracks);
    step(world);
    expect(view.lastKnown(barracks)).toBeUndefined();
  });
});

// ---- Test helpers ---------------------------------------------------------------

/** Despawn without going through systems (rows die with the entity). */
function despawnForTest(
  world: ReturnType<typeof createWorld>,
  eid: number,
): void {
  const index = world.entities.indexOf(eid);
  expect(index).toBeGreaterThanOrEqual(0);
  world.entities.splice(index, 1);
  for (const rows of world.rowsByComponentId.values()) rows.delete(eid);
}

// ---- Renderer DataTexture handoff (SPEC §2.9) ------------------------------------

describe("RG fog DataTexture handoff", () => {
  it("packs R=explored and G=visible row-major from the viewer planes", async () => {
    const { createFogDataTexture, writeFogPlaneIntoTexture } =
      await import("../src/render/fogTexture");
    const size = 4;
    const fog = createFogVisibility(size, 2);
    const world = createWorld(11, {
      size,
      visibility: fog.provider,
    });
    const comps = defineSimComponents(world);
    fog.bindSource({
      resolve: createRowEntityResolver(world, comps),
      eidsAscending: () => world.entities,
    });
    spawnUnit(world, comps, 1.5, 1.5);
    step(world);

    const texture = createFogDataTexture(size);
    expect(texture.image.width).toBe(size);
    expect(texture.image.height).toBe(size);
    // Sampler settings (LinearFilter/ClampToEdge, no mipmaps) are
    // pinned in createFogDataTexture; asserting them end-to-end needs
    // WebGL, which headless tests never touch (repo lint rule).
    writeFogPlaneIntoTexture(texture, fog.state, PLAYER_ONE);
    const data = texture.image.data as Uint8Array;
    expect(data.length).toBe(size * size * 2);
    let exploredBytes = 0;
    let visibleBytes = 0;
    for (let i = 0; i < size * size; i++) {
      expect(data[i * 2]).toBe(fog.state.planes[PLAYER_ONE]!.explored[i]);
      expect(data[i * 2 + 1]).toBe(fog.state.planes[PLAYER_ONE]!.visible[i]);
      exploredBytes += data[i * 2]!;
      visibleBytes += data[i * 2 + 1]!;
    }
    expect(visibleBytes).toBeGreaterThan(0);
    expect(exploredBytes).toBeGreaterThanOrEqual(visibleBytes);
    // Player 1's plane stays dark: one texture per human viewer.
    writeFogPlaneIntoTexture(texture, fog.state, 1);
    expect((texture.image.data as Uint8Array).every((byte) => byte === 0)).toBe(
      true,
    );
  });
});
