/**
 * Pop identity & traits tests — SPEC §2.3 / M3-T1 (issue #46).
 *
 * Acceptance criteria under test:
 * - SAME SEED ⇒ IDENTICAL POPULATIONS: two worlds built from one seed
 *   carry byte-identical name/trait sets, pinned here as a snapshot so
 *   any accidental stream change fails loudly.
 * - CONFLICT EXCLUSION: a 1000-seed property sweep can never produce a
 *   conflicting co-occurrence (RimWorld pattern: commonality-weighted
 *   picks excluding every conflict of what was already drawn).
 *
 * Plus the surrounding contract: content validation, stable trait
 * codes, unique collision-free names within a world, birthTick/
 * familyId fields, digest participation, and the wiring at the villager
 * spawn sites (training completion, AI bootstrap).
 */
import { describe, expect, it } from "vitest";
import {
  attachPopIdentity,
  defineSimComponents,
  generatePopTraits,
  givenNameOf,
  NAME_LIST_SIZE,
  nameListFor,
  popNameOf,
  readIdentity,
  readTraits,
  type SimComponents,
} from "../src/sim/components";
import { FAMILY_UNASSIGNED } from "../src/sim/components/pop";
import {
  conflictsOf,
  POP_TRAIT_COUNT_MAX,
  POP_TRAIT_COUNT_MIN,
  traitCodeOf,
  traitsConflict,
  TRAIT_DEFINITIONS,
  TRAIT_SLUGS,
} from "../src/sim/data/traits";
import {
  computeWorldDigest,
  createWorld,
  registerSystem,
  spawnEntity,
  step,
  type World,
} from "../src/sim/core/world";
import { PLAYER_ONE, createPlayerStockpile } from "../src/sim/core/stockpile";
import { setupAiOpponent } from "../src/sim/ai/bootstrap";
import {
  createTrainingSystem,
  TRAIN_VILLAGER_KIND,
} from "../src/sim/systems/training";
import { stampFinishedBuilding } from "../src/sim/systems/placement";
import { TERRAIN_GRASS, buildLayers } from "../src/sim/world/layers";
import { installSimPurityShims } from "./helpers/sim-purity-shims";

installSimPurityShims();

function grassWorld(seed: number): { world: World; comps: SimComponents } {
  const size = 16;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const world = createWorld(seed, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
  });
  return { world, comps: defineSimComponents(world) };
}

/** Attach identities to `count` fresh entities; returns decoded pops. */
function seedPopulation(
  world: World,
  comps: SimComponents,
  count: number,
): { name: string; traits: string[] }[] {
  const pops: { name: string; traits: string[] }[] = [];
  for (let i = 0; i < count; i++) {
    const eid = spawnEntity(world);
    attachPopIdentity(world, comps, eid);
    const name = popNameOf(world, comps, eid);
    const traits = readTraits(world, comps, eid);
    if (!name || !traits) throw new Error("identity attachment incomplete");
    pops.push({ name, traits });
  }
  return pops;
}

// ---- Content registry -------------------------------------------------------------

describe("trait content registry", () => {
  it("loads ~24 validated traits with unique ascending-slug codes", () => {
    expect(TRAIT_SLUGS.length).toBeGreaterThanOrEqual(22);
    expect(TRAIT_SLUGS.length).toBeLessThanOrEqual(28);
    expect([...TRAIT_SLUGS]).toEqual([...TRAIT_SLUGS].sort());
    const codes = [...new Set(TRAIT_SLUGS.map((slug) => traitCodeOf(slug)))];
    expect(codes).toHaveLength(TRAIT_SLUGS.length);
    for (const slug of TRAIT_SLUGS) {
      expect(TRAIT_DEFINITIONS.get(slug)?.commonality ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps conflict pairs known, non-self, and symmetric", () => {
    let endpointsSeen = 0;
    for (const slug of TRAIT_SLUGS) {
      for (const other of conflictsOf(slug)) {
        endpointsSeen += 1;
        expect(TRAIT_DEFINITIONS.has(other)).toBe(true);
        expect(other).not.toBe(slug);
        expect(traitsConflict(other, slug)).toBe(true);
      }
    }
    // The issue names Kind/Cruel and Gregarious/Solitary explicitly.
    expect(traitsConflict("kind", "cruel")).toBe(true);
    expect(traitsConflict("gregarious", "solitary")).toBe(true);
    // 14 authored undirected pairs ⇒ both directions resolvable.
    expect(endpointsSeen).toBeGreaterThanOrEqual(20);
  });
});

// ---- Seeded generation --------------------------------------------------------------

describe("seeded trait generation", () => {
  it("is a pure function of (seed, eid)", () => {
    for (const seed of [0, 1, 20260824, 0xffffffff]) {
      for (const eid of [1, 7, 64]) {
        expect(generatePopTraits(seed, eid)).toEqual(
          generatePopTraits(seed, eid),
        );
      }
    }
    // Distinct seeds must disagree somewhere across a broad sample —
    // otherwise the stream would be constant and the sweep below moot.
    const shapes = new Set(
      Array.from({ length: 64 }, (_, i) => generatePopTraits(i, 1).join(",")),
    );
    expect(shapes.size).toBeGreaterThan(1);
  });

  it("rolls 1–3 unique, sorted, conflict-free slugs", () => {
    for (let seed = 0; seed < 250; seed++) {
      for (let eid = 1; eid <= 6; eid++) {
        const traits = generatePopTraits(seed, eid);
        expect(traits.length).toBeGreaterThanOrEqual(POP_TRAIT_COUNT_MIN);
        expect(traits.length).toBeLessThanOrEqual(POP_TRAIT_COUNT_MAX);
        expect(new Set(traits).size).toBe(traits.length);
        expect(traits).toEqual([...traits].sort());
        for (let i = 0; i < traits.length; i++) {
          for (let j = i + 1; j < traits.length; j++) {
            expect(traitsConflict(traits[i]!, traits[j]!)).toBe(false);
          }
        }
      }
    }
  });
});

describe("conflict exclusion property (1000 seeds)", () => {
  it("never produces a conflicting co-occurrence across the sweep", () => {
    const SEEDS = 1000;
    const POPS_PER_SEED = 12;
    let rolledTraits = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      for (let eid = 1; eid <= POPS_PER_SEED; eid++) {
        const traits = generatePopTraits(seed, eid);
        rolledTraits += traits.length;
        for (let i = 0; i < traits.length; i++) {
          for (let j = i + 1; j < traits.length; j++) {
            expect(traitsConflict(traits[i]!, traits[j]!)).toBe(false);
          }
        }
      }
    }
    // Sanity against a silently-empty generator: real traits were rolled.
    expect(rolledTraits).toBeGreaterThan(SEEDS * POPS_PER_SEED);
  });
});

// ---- Given names --------------------------------------------------------------------

describe("deterministic given-name generator", () => {
  it("builds the same unique list for the same seed", () => {
    const a = nameListFor(20260824);
    const b = nameListFor(20260824);
    expect(a).toBe(b); // memoized pure function
    expect(a).toHaveLength(NAME_LIST_SIZE);
    expect(new Set(a).size).toBe(NAME_LIST_SIZE);
    for (const name of a) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });

  it("resolves Identity nameIdx values through givenNameOf", () => {
    const { world } = grassWorld(5);
    const list = nameListFor(5);
    expect(givenNameOf(world, 0)).toBe(list[0]);
    expect(givenNameOf(world, NAME_LIST_SIZE - 1)).toBe(
      list[NAME_LIST_SIZE - 1],
    );
  });
});

// ---- World wiring -------------------------------------------------------------------

function populationForSeed(seed: number, count = 128): PopulationResult {
  const { world, comps } = grassWorld(seed);
  const pops = seedPopulation(world, comps, count);
  return {
    names: pops.map((p) => p.name),
    traitSets: pops.map((p) => p.traits.join("+")),
  };
}

interface PopulationResult {
  readonly names: readonly string[];
  readonly traitSets: readonly string[];
}

describe("same-seed population determinism", () => {
  it("produces identical populations across independent builds", () => {
    expect(populationForSeed(20260824)).toEqual(populationForSeed(20260824));
  });

  it("pins the reference population (names + trait sets)", () => {
    const population = populationForSeed(20260824);
    expect(population.names.slice(0, 16)).toMatchInlineSnapshot(`
      [
        "Elia",
        "Garovor",
        "Beriund",
        "Joraholm",
        "Halanhild",
        "Jorolhild",
        "Dorolvor",
        "Berelwick",
        "Cadogard",
        "Norarhild",
        "Fenolyth",
        "Elgard",
        "Elogard",
        "Joribald",
        "Lunund",
        "Halbald",
      ]
    `);
    expect(population.traitSets.slice(0, 16)).toMatchInlineSnapshot(`
      [
        "hardy+pious",
        "greedy",
        "optimistic",
        "kind+night-owl",
        "ambitious+kind+sociable",
        "family-focused",
        "brave+industrious",
        "family-focused+optimistic+quick-tempered",
        "coward+industrious+optimistic",
        "content+family-focused+quick-tempered",
        "optimistic",
        "brave+content+hedonist",
        "ambitious",
        "greedy+pious",
        "brave+industrious",
        "jealous",
      ]
    `);
  });

  it("different seeds yield different populations", () => {
    expect(JSON.stringify(populationForSeed(1))).not.toBe(
      JSON.stringify(populationForSeed(2)),
    );
  });

  it("never reuses a name within one world (600-Pop sweep)", () => {
    const { world, comps } = grassWorld(77);
    const pops = seedPopulation(world, comps, 600);
    expect(new Set(pops.map((p) => p.name)).size).toBe(600);
  });

  it("stamps birthTick/familyId and feeds both components into the digest", () => {
    const { world, comps } = grassWorld(9);

    const first = spawnEntity(world);
    attachPopIdentity(world, comps, first);
    const identity = readIdentity(world, comps, first);
    expect(identity?.birthTick).toBe(0);
    expect(identity?.familyId).toBe(FAMILY_UNASSIGNED);
    expect(readTraits(world, comps, first)?.length).toBeGreaterThanOrEqual(1);

    const before = computeWorldDigest(world);
    spawnEntity(world);
    expect(computeWorldDigest(world)).toBe(before); // no rows ⇒ no bytes
    attachPopIdentity(world, comps, world.lastAllocatedEid);
    expect(computeWorldDigest(world)).not.toBe(before);
  });
});

// ---- Villager spawn-site wiring ------------------------------------------------------

describe("identity wiring at villager spawn sites", () => {
  it("names villagers completed by the training system", () => {
    const { world, comps } = grassWorld(424242);
    registerSystem(world, createTrainingSystem(comps));
    createPlayerStockpile(
      world,
      comps,
      PLAYER_ONE,
      [400, 900, 300, 0, 0, 0, 0],
    );
    stampFinishedBuilding(world, comps, "town-center", 4, 4, {
      playerId: PLAYER_ONE,
    });
    world.inbox.submit({
      kind: TRAIN_VILLAGER_KIND,
      targetTick: world.tick + 1,
      data: {},
    });
    const entitiesBefore = world.entities.length;
    for (let i = 0; i < 900 && world.entities.length === entitiesBefore; i++) {
      step(world);
    }

    expect(world.entities.length).toBe(entitiesBefore + 1);
    const villagerEid = world.entities.at(-1)!;
    expect(popNameOf(world, comps, villagerEid)).toMatch(/^[A-Z][a-z]+$/);
    expect(
      readTraits(world, comps, villagerEid)?.length,
    ).toBeGreaterThanOrEqual(1);
    expect(readIdentity(world, comps, villagerEid)?.birthTick).toBeGreaterThan(
      0,
    );
  });

  it("names AI-bootstrap starting villagers", () => {
    const { world, comps } = grassWorld(31337);
    const handle = setupAiOpponent(world, comps, {
      tcOrigin: [6, 6],
      villagerSpawns: [
        [2.5, 2.5],
        [3.5, 2.5],
        [2.5, 3.5],
      ],
    });
    expect(handle.villagerEids).toHaveLength(3);
    const names = handle.villagerEids.map((eid) =>
      popNameOf(world, comps, eid),
    );
    expect(new Set(names).size).toBe(3);
    for (const eid of handle.villagerEids) {
      expect(readTraits(world, comps, eid)?.length).toBeGreaterThanOrEqual(1);
    }
  });
});
