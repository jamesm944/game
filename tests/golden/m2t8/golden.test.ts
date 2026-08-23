/**
 * M2-T8 golden harness — SPEC §2.9/§2.8 fog of war & minimap / issue #42.
 *
 * One scouting march exercises the whole fog pipeline against pinned
 * digests and plane samples: a player-zero scout-cavalry (sight 8)
 * leaves its town-center's explored ring, marches east across black
 * map, sights an unseen player-one barracks then house (KnowledgeView
 * flips unknown → live-known), and returns west so both structures
 * leave visibility and persist as memory ghosts while the wallhack
 * gate keeps them out of knownEntities(). Along the way an
 * explored-tile house placement succeeds through the real command path
 * while far unexplored ground reports "unexplored".
 *
 * Pinned outcomes:
 *   - PLANES — explored grows monotonically, visible ≤ explored every
 *     sampled tick, and the barracks/house tiles walk the tri-state
 *     black → bright → dim exactly as the scout passes and returns.
 *   - MINIMAP — at EVERY sampled tick the full 64×64 grid classified
 *     through the shared minimapShadeFor projection matches the raw
 *     plane bytes: zero mismatches, ever.
 *   - KNOWLEDGE — enemy buildings are absent from knownEntities()
 *     before sighting AND after ghosting; lastKnown() records their
 *     footprints only in between.
 *   - PLACEMENT — unexplored verdict pre-flight, accepted placement on
 *     scouted ground mid-run (eid 8 site exists at run end).
 *   - PARITY — the same command script under the M1 all-visible stub
 *     produces byte-identical milestone digests: fog is observationally
 *     neutral to the deterministic sim.
 *
 * Milestone digests land every 30th tick plus final with a double-run
 * determinism canary. Eid layout is part of the fixture contract:
 * scout 1, villagers 2–3, ledger 4, town-center 5, barracks 6,
 * enemy house 7, placed house site 8.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimCommand } from "../../../src/sim/core/inbox";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  step,
  type World,
} from "../../../src/sim/core/world";
import {
  defineSimComponents,
  getBuildingSiteRow,
  spawnCombatUnit,
  spawnUnit,
  type SimComponents,
} from "../../../src/sim/components";
import {
  PLAYER_ONE,
  createPlayerStockpile,
} from "../../../src/sim/core/stockpile";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../../../src/sim/path/scheduler";
import { createMovementSystem } from "../../../src/sim/systems/movement";
import {
  createFogVisibility,
  createRowEntityResolver,
  exploredTileCount,
  visibleTileCount,
  type FogVisibilityHandle,
  type GhostBuildingRecord,
} from "../../../src/sim/systems/fog";
import {
  createPlacementSystem,
  stampFinishedBuilding,
  validatePlacement,
} from "../../../src/sim/systems/placement";
import {
  MINIMAP_SHADE_BRIGHT,
  MINIMAP_SHADE_DIM,
  MINIMAP_SHADE_UNEXPLORED,
  minimapShadeFor,
} from "../../../src/ui/minimap";
import { installSimPurityShims } from "../../helpers/sim-purity-shims";
import { TERRAIN_GRASS, buildLayers } from "../../../src/sim/world/layers";

/** Fixture eid contract (see header). */
const BARRACKS_EID = 6;
const ENEMY_HOUSE_EID = 7;
const PLACED_HOUSE_EID = 8;
const VIEWER = PLAYER_ONE;

interface GoldenUnit {
  readonly eid: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenBuilding {
  readonly eid: number;
  readonly defId: string;
  readonly tileX: number;
  readonly tileY: number;
  readonly playerId: number;
}

interface GoldenStockpile {
  readonly playerId: number;
  readonly resources: readonly number[];
}

interface GoldenCase {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  readonly ticks: number;
  readonly milestoneEvery: number;
  readonly scout: GoldenUnit;
  readonly villagers: readonly GoldenUnit[];
  readonly stockpiles: readonly GoldenStockpile[];
  readonly buildings: readonly GoldenBuilding[];
  readonly commands: readonly SimCommand[];
}

function requiredNumber(value: unknown, where: string): number {
  if (typeof value !== "number") {
    throw new Error(`fixture ${where} must be a number`);
  }
  return value;
}

function loadGoldenCase(): GoldenCase {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./case.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture case.json must be an object");
  }
  const box = raw as Record<string, unknown>;
  const scoutBox = box.scout as Record<string, unknown>;
  const scout: GoldenUnit = {
    eid: requiredNumber(scoutBox.eid, "scout.eid"),
    x: requiredNumber(scoutBox.x, "scout.x"),
    y: requiredNumber(scoutBox.y, "scout.y"),
  };
  if (!Array.isArray(box.villagers) || box.villagers.length === 0) {
    throw new Error("fixture case.json: villagers must be non-empty");
  }
  const villagers = box.villagers.map((entry): GoldenUnit => {
    const villager = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(villager.eid, "villager.eid"),
      x: requiredNumber(villager.x, "villager.x"),
      y: requiredNumber(villager.y, "villager.y"),
    };
  });
  if (!Array.isArray(box.stockpiles)) {
    throw new Error("fixture case.json: stockpiles must be an array");
  }
  const stockpiles = box.stockpiles.map((entry): GoldenStockpile => {
    const stock = entry as Record<string, unknown>;
    return {
      playerId: requiredNumber(stock.playerId, "stockpile.playerId"),
      resources: stock.resources as number[],
    };
  });
  if (!Array.isArray(box.buildings) || box.buildings.length === 0) {
    throw new Error("fixture case.json: buildings must be non-empty");
  }
  const buildings = box.buildings.map((entry): GoldenBuilding => {
    const building = entry as Record<string, unknown>;
    return {
      eid: requiredNumber(building.eid, "building.eid"),
      defId: String(building.defId),
      tileX: requiredNumber(building.tileX, "building.tileX"),
      tileY: requiredNumber(building.tileY, "building.tileY"),
      playerId: requiredNumber(building.playerId, "building.playerId"),
    };
  });
  if (!Array.isArray(box.commands)) {
    throw new Error("fixture case.json: commands must be an array");
  }
  const commands = box.commands.map((entry): SimCommand => {
    const command = entry as Record<string, unknown>;
    if (command.data === undefined || typeof command.data !== "object") {
      throw new Error("fixture case.json: all commands require data");
    }
    return {
      kind: String(command.kind),
      targetTick: requiredNumber(command.targetTick, "command targetTick"),
      data: command.data as Readonly<Record<string, unknown>>,
    };
  });
  return {
    name: String(box.name),
    seed: requiredNumber(box.seed, "seed"),
    size: requiredNumber(box.size, "size"),
    ticks: requiredNumber(box.ticks, "ticks"),
    milestoneEvery: requiredNumber(box.milestoneEvery, "milestoneEvery"),
    scout,
    villagers,
    stockpiles,
    buildings,
    commands,
  };
}

export interface MilestoneDigest {
  readonly tick: number;
  readonly digest: string;
}

/** Tri-state shade of one tile at a sampled tick. */
interface TileSample {
  readonly tileX: number;
  readonly tileY: number;
  readonly shade: number;
}

/** Fog-plane state pinned at one milestone tick. */
interface FogSample {
  readonly tick: number;
  readonly exploredCount: number;
  readonly visibleCount: number;
  /** Full-grid minimap-vs-planes mismatches (must stay zero). */
  readonly minimapMismatches: number;
  /** Shade histogram over the whole grid (black/dim/bright). */
  readonly shades: readonly [number, number, number];
  readonly trackedTiles: readonly TileSample[];
  readonly barracksKnown: boolean;
  readonly houseKnown: boolean;
}

/** Plain-comparable final state so canaries deep-equal trivially. */
interface RunState {
  readonly digests: readonly MilestoneDigest[];
  readonly samples: readonly FogSample[];
  readonly finalTick: number;
  readonly farPlacementReason: string | undefined;
  readonly nearPlacementOk: boolean;
  readonly placedSiteExists: boolean;
  readonly finalKnownEids: readonly number[];
  readonly finalLastKnownBarracks: GhostBuildingRecord | undefined;
  readonly finalLastKnownHouse: GhostBuildingRecord | undefined;
  readonly finalBarracksTileVisible: boolean;
  readonly finalEnemyHouseTileVisible: boolean;
}

function openFieldLayers(size: number) {
  return buildLayers(
    new Uint8Array(size * size).fill(TERRAIN_GRASS),
    new Uint8Array(size * size),
  );
}

function classifyShades(
  fog: FogVisibilityHandle,
  size: number,
): [number, number, number] {
  const view = fog.knowledgeFor(VIEWER);
  let black = 0;
  let dim = 0;
  let bright = 0;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const shade = minimapShadeFor(
        view.isExplored(tx, ty),
        view.isVisible(tx, ty),
      );
      if (shade === MINIMAP_SHADE_UNEXPLORED) black += 1;
      else if (shade === MINIMAP_SHADE_DIM) dim += 1;
      else if (shade === MINIMAP_SHADE_BRIGHT) bright += 1;
    }
  }
  return [black, dim, bright];
}

/**
 * Count tiles where the minimap projection computed from the RAW plane
 * bytes disagrees with the same projection fed by provider queries —
 * catches indexing/off-by-one regressions between planes and seam.
 */
function minimapMismatches(fog: FogVisibilityHandle, size: number): number {
  const plane = fog.state.planes[VIEWER]!;
  const view = fog.knowledgeFor(VIEWER);
  let mismatches = 0;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const index = ty * size + tx;
      const fromBytes = minimapShadeFor(
        plane.explored[index] === 1,
        plane.visible[index] === 1,
      );
      const fromQueries = minimapShadeFor(
        view.isExplored(tx, ty),
        view.isVisible(tx, ty),
      );
      if (fromBytes !== fromQueries) mismatches += 1;
    }
  }
  return mismatches;
}

function sampleFog(fog: FogVisibilityHandle, tick: number): FogSample {
  return {
    tick,
    exploredCount: exploredTileCount(fog.state, VIEWER),
    visibleCount: visibleTileCount(fog.state, VIEWER),
    minimapMismatches: minimapMismatches(fog, fog.state.size),
    shades: classifyShades(fog, fog.state.size),
    trackedTiles: [
      { tileX: 24, tileY: 29, shade: shadeOf(fog, 24, 29) },
      { tileX: 28, tileY: 29, shade: shadeOf(fog, 28, 29) },
      { tileX: 0, tileY: 0, shade: shadeOf(fog, 0, 0) },
    ],
    barracksKnown:
      fog.knowledgeFor(VIEWER).lastKnown(BARRACKS_EID) !== undefined,
    houseKnown:
      fog.knowledgeFor(VIEWER).lastKnown(ENEMY_HOUSE_EID) !== undefined,
  };
}

function shadeOf(fog: FogVisibilityHandle, x: number, y: number): number {
  const view = fog.knowledgeFor(VIEWER);
  return minimapShadeFor(view.isExplored(x, y), view.isVisible(x, y));
}

function runScenario(fixture: GoldenCase, useRealFog: boolean): RunState {
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const fog = useRealFog ? createFogVisibility(fixture.size, 2) : undefined;
  const world: World = createWorld(fixture.seed, {
    size: fixture.size,
    layers: openFieldLayers(fixture.size),
    pathScheduler: scheduler,
    ...(fog ? { visibility: fog.provider } : {}),
  });
  const comps: SimComponents = defineSimComponents(world);
  if (fog) {
    fog.bindSource({
      resolve: createRowEntityResolver(world, comps),
      eidsAscending: () => world.entities,
    });
  }
  registerSystem(world, createMovementSystem(comps, scheduler));
  registerSystem(world, createPlacementSystem(comps));

  // Eid contract: scout 1, villagers 2–3, ledger 4, stamped buildings
  // 5–7; the commanded house spawns later as site 8.
  let nextEid = 1;
  const scout = spawnCombatUnit(
    world,
    comps,
    "scout-cavalry",
    fixture.scout.x,
    fixture.scout.y,
    PLAYER_ONE,
  );
  if (scout !== fixture.scout.eid || scout !== nextEid++) {
    throw new Error("fixture scout eid mismatch");
  }
  for (const villager of fixture.villagers) {
    const eid = spawnUnit(world, comps, villager.x, villager.y);
    if (eid !== villager.eid || eid !== nextEid++) {
      throw new Error("fixture villager eid mismatch");
    }
  }
  for (const stock of fixture.stockpiles) {
    const eid = createPlayerStockpile(
      world,
      comps,
      stock.playerId,
      stock.resources,
    );
    if (eid !== nextEid++) throw new Error("fixture ledger eid mismatch");
  }
  for (const building of fixture.buildings) {
    const eid = stampFinishedBuilding(
      world,
      comps,
      building.defId,
      building.tileX,
      building.tileY,
      { playerId: building.playerId },
    );
    if (eid !== building.eid || eid !== nextEid++) {
      throw new Error("fixture building eid mismatch");
    }
  }

  // Map-gen full recompute (SPEC §2.9): setup spawns stamp together.
  fog?.recomputeAll();

  // Pre-flight placement verdicts through the shared validity function.
  const farVerdict = validatePlacement(
    world,
    comps,
    "house",
    40,
    40,
    VIEWER,
  ).reason;
  const nearOk = validatePlacement(world, comps, "house", 9, 25, VIEWER).ok;

  for (const command of fixture.commands) world.inbox.submit(command);

  const digests: MilestoneDigest[] = [];
  const samples: FogSample[] = [];
  while (world.tick < fixture.ticks) {
    const before = world.tick;
    step(world);
    if (world.tick === before) continue; // held boundary: no double record
    const tick = world.tick;
    if (tick % fixture.milestoneEvery === 0 || tick === fixture.ticks) {
      digests.push({ tick, digest: computeWorldDigest(world) });
      if (fog) samples.push(sampleFog(fog, tick));
    }
  }

  const view = fog?.knowledgeFor(VIEWER);
  return {
    digests,
    samples,
    finalTick: world.tick,
    farPlacementReason: farVerdict,
    nearPlacementOk: nearOk,
    placedSiteExists:
      getBuildingSiteRow(world, comps, PLACED_HOUSE_EID) !== undefined,
    finalKnownEids: view ? view.knownEntities().map((entry) => entry.eid) : [],
    finalLastKnownBarracks: view?.lastKnown(BARRACKS_EID),
    finalLastKnownHouse: view?.lastKnown(ENEMY_HOUSE_EID),
    finalBarracksTileVisible: fog ? fog.isVisible(24, 29, VIEWER) : true,
    finalEnemyHouseTileVisible: fog ? fog.isVisible(28, 29, VIEWER) : true,
  };
}

installSimPurityShims();

describe("golden harness m2t8", () => {
  const fixture = loadGoldenCase();

  it("records milestone digests at every 30th tick plus final", () => {
    const run = runScenario(fixture, true);

    const expectedTicks = Array.from(
      { length: Math.floor(fixture.ticks / fixture.milestoneEvery) },
      (_, i) => (i + 1) * fixture.milestoneEvery,
    );
    if (expectedTicks.at(-1) !== fixture.ticks) {
      expectedTicks.push(fixture.ticks);
    }
    expect(run.digests.map((entry) => entry.tick)).toEqual(expectedTicks);
    for (const entry of run.digests) {
      expect(entry.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    }
    expect(run.digests).toMatchSnapshot();
  });

  it("walks the fog planes black → bright → dim around the march", () => {
    const run = runScenario(fixture, true);

    expect(run.finalTick).toBe(fixture.ticks);
    expect(run.samples.length).toBe(run.digests.length);

    // Explored only ever grows; visible never exceeds it.
    for (let i = 1; i < run.samples.length; i++) {
      expect(run.samples[i]!.exploredCount).toBeGreaterThanOrEqual(
        run.samples[i - 1]!.exploredCount,
      );
      expect(run.samples[i]!.visibleCount).toBeLessThanOrEqual(
        run.samples[i]!.exploredCount,
      );
    }

    // The minimap projection matches the raw planes at EVERY sample.
    for (const sample of run.samples) {
      expect(sample.minimapMismatches).toBe(0);
    }

    const first = run.samples[0]!;
    expect(first.exploredCount).toBeGreaterThan(0); // start ring explored
    // The overwhelming majority of the grid is still black at t30.
    expect(first.shades[MINIMAP_SHADE_UNEXPLORED]).toBeGreaterThan(3000);

    // Enemy ground: black before the march reaches it…
    const early = run.samples.find((sample) => sample.tick <= 60)!;
    expect(early.trackedTiles[0]).toMatchObject({
      tileX: 24,
      tileY: 29,
      shade: MINIMAP_SHADE_UNEXPLORED,
    });
    expect(early.barracksKnown).toBe(false);

    // …bright on the FIRST sighting tick, unknown one milestone before…
    const sightedAt = run.samples.findIndex((sample) => sample.barracksKnown);
    expect(sightedAt).toBeGreaterThan(0);
    const sighted = run.samples[sightedAt]!;
    expect(sighted.trackedTiles[0]).toMatchObject({
      shade: MINIMAP_SHADE_BRIGHT,
    });
    expect(sighted.trackedTiles[0]).toMatchObject({ tileX: 24, tileY: 29 });
    expect(run.samples[sightedAt - 1]!.barracksKnown).toBe(false);
    // …and the house (further east) is sighted strictly later.
    const houseSightedAt = run.samples.findIndex((sample) => sample.houseKnown);
    expect(houseSightedAt).toBeGreaterThan(sightedAt);

    // …and dim-but-known after he returns west (memory ghost).
    const last = run.samples[run.samples.length - 1]!;
    expect(last.trackedTiles[0]).toMatchObject({
      tileX: 24,
      tileY: 29,
      shade: MINIMAP_SHADE_DIM,
    });
    expect(last.shades[MINIMAP_SHADE_DIM]).toBeGreaterThan(
      first.shades[MINIMAP_SHADE_DIM],
    );

    // The far corner of the map is still black at run end.
    expect(last.trackedTiles[2]).toMatchObject({
      tileX: 0,
      tileY: 0,
      shade: MINIMAP_SHADE_UNEXPLORED,
    });
  });

  it("KnowledgeView sights the enemy buildings, then holds them as ghosts", () => {
    const run = runScenario(fixture, true);

    const mid = run.samples.find((sample) => sample.tick >= 270)!;
    expect(mid.houseKnown).toBe(true);
    expect(mid.barracksKnown).toBe(true);

    // Final state: both enemy buildings are OUT of sight but recorded.
    expect(run.finalBarracksTileVisible).toBe(false);
    expect(run.finalEnemyHouseTileVisible).toBe(false);
    expect(run.finalLastKnownBarracks).toMatchObject({
      eid: BARRACKS_EID,
      defId: "barracks",
      tileX: 24,
      tileY: 28,
    });
    expect(run.finalLastKnownHouse).toMatchObject({
      eid: ENEMY_HOUSE_EID,
      defId: "house",
      tileX: 28,
      tileY: 29,
    });
    // Wallhack gate: ghosts are NOT live entities — knownEntities()
    // carries only the viewer's own population.
    expect(run.finalKnownEids).not.toContain(BARRACKS_EID);
    expect(run.finalKnownEids).not.toContain(ENEMY_HOUSE_EID);
    expect(run.finalKnownEids).toEqual(
      [...run.finalKnownEids].sort((a, b) => a - b),
    );
    expect(run.finalKnownEids.length).toBeGreaterThanOrEqual(3); // own units+TC
  });

  it("placement requires explored tiles through the real provider", () => {
    const run = runScenario(fixture, true);

    // Far unexplored ground refused with the §2.9 reason…
    expect(run.farPlacementReason).toBe("unexplored");
    // …while the TC-explored footprint accepted and built a real site.
    expect(run.nearPlacementOk).toBe(true);
    expect(run.placedSiteExists).toBe(true);
  });

  it("fog is observationally neutral: stub parity on milestone digests", () => {
    const fogged = runScenario(fixture, true);
    const stubbed = runScenario(fixture, false);

    expect(stubbed.finalTick).toBe(fogged.finalTick);
    expect(stubbed.digests).toEqual(fogged.digests);
    expect(stubbed.digests.length).toBeGreaterThan(20);
  });

  it("extended canary: two identical runs agree byte-for-byte", () => {
    const first = runScenario(fixture, true);
    const second = runScenario(fixture, true);
    expect(second).toEqual(first);
    expect(first.digests.length).toBeGreaterThan(20);
  });
});
