/**
 * Minimal deterministic world — SPEC §2.1.
 *
 * Holds seed/prng/registry/tick/inbox plus per-component SoA-style row
 * maps (the hand-rolled store sanctioned by ADR-0001; bitecs slots in
 * behind this same surface later). `step()` advances exactly one 30 Hz
 * tick: tick increments, due commands are consumed, then registered
 * systems run in registration order.
 */
import { computeDigest, type DigestComponentSource } from "./digest";
import { CommandInbox, type SimCommand } from "./inbox";
import { createPrng, type Prng } from "./prng";
import { ComponentRegistry } from "./registry";
import { generateMap } from "../mapgen/generate";
import type { PathScheduler } from "../path/scheduler";
import type { VisibilityProvider } from "../systems/fog";
import { createAllVisibleProvider } from "../systems/fog";
import type { WorldLayers } from "../world/layers";

export const TICK_HZ = 30;
export const TICK_DT_MS = 1000 / TICK_HZ;
/** Default skirmish grid: 120×120 tiles (SPEC §2.1 / ADR-0002). */
export const DEFAULT_MAP_SIZE = 120;

/** Per-entity component values, keyed by ascending entity id. */
export type ComponentRows = Map<number, number[]>;

export interface World {
  readonly seed: number;
  readonly prng: Prng;
  readonly registry: ComponentRegistry;
  readonly inbox: CommandInbox;
  /** Live entity ids, ascending (spawn order is stable). */
  readonly entities: number[];
  /** Completed ticks: after N steps this is exactly N. */
  tick: number;
  /** Systems run each step in registration order, after command drain. */
  readonly systems: SimSystem[];
  /** Row map per registered component, indexed by component id. */
  readonly rowsByComponentId: Map<number, ComponentRows>;
  /**
   * Tile-grid world layers generated from the seed (SPEC §2.1). Mapgen
   * runs on its own sfc32 stream inside generateMap, so world.prng is
   * untouched by creation and the tick stream stays replay-stable.
   */
  readonly layers: WorldLayers;
  /**
   * Optional path scheduler (M1-T5): consulted at every tick boundary
   * BEFORE any state advances. While a due response is missing, step()
   * holds the tick entirely — no increment, no command drain, no
   * systems — and retries the same boundary next frame (ADR-0003).
   */
  readonly pathScheduler: PathScheduler | undefined;
  /**
   * Fog-of-war seam (SPEC §2.9 / M1-T11). M1 ships the all-visible
   * stub; consumers (placement explored-gate today, AI KnowledgeView +
   * render culling in M2) read ONLY this interface, so M2 swaps the
   * implementation here without touching any caller.
   */
  readonly visibility: VisibilityProvider;
}

export type SimSystem = (world: World, commands: readonly SimCommand[]) => void;

export interface CreateWorldOptions {
  /** Grid edge length in tiles; defaults to DEFAULT_MAP_SIZE (120). */
  readonly size?: number | undefined;
  /**
   * Pre-built world layers overriding seed-driven mapgen. Tests use
   * this to author hand-built passability grids; production callers
   * leave it unset so the map is a pure function of the seed.
   */
  readonly layers?: WorldLayers | undefined;
  /**
   * Path scheduler enforcing the dueTick/blocking worker contract.
   * Required once any system issues path requests; worlds without one
   * behave exactly as before M1-T5.
   */
  readonly pathScheduler?: PathScheduler | undefined;
  /**
   * Fog-of-war provider override (tests inject denying fakes to prove
   * the seam). Production callers omit it for the all-visible stub.
   */
  readonly visibility?: VisibilityProvider | undefined;
}

export function createWorld(
  seed: number,
  options: CreateWorldOptions = {},
): World {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`world seed must be a u32 integer, got ${String(seed)}`);
  }
  const layers =
    options.layers ?? generateMap(seed, options.size ?? DEFAULT_MAP_SIZE);
  return {
    seed,
    prng: createPrng(seed),
    registry: new ComponentRegistry(),
    inbox: new CommandInbox(),
    entities: [],
    tick: 0,
    systems: [],
    rowsByComponentId: new Map(),
    layers,
    pathScheduler: options.pathScheduler,
    visibility: options.visibility ?? createAllVisibleProvider(layers.size),
  };
}

/**
 * Declare a component. Registration order is enforced alphabetical by
 * the registry, so call sites must list components alphabetically —
 * this pins the digest/save iteration order forever.
 */
export function defineComponent(world: World, name: string): number {
  const id = world.registry.register(name);
  world.rowsByComponentId.set(id, new Map());
  return id;
}

/** Allocate the next stable ascending entity id. */
export function spawnEntity(world: World): number {
  const last = world.entities.at(-1);
  const eid = last === undefined ? 1 : last + 1;
  world.entities.push(eid);
  return eid;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/** Attach/overwrite one entity's component values (copied). */
export function setComponentValues(
  world: World,
  componentId: number,
  eid: number,
  values: readonly number[],
): void {
  requireRows(world, componentId).set(eid, [...values]);
}

export function getComponentValues(
  world: World,
  componentId: number,
  eid: number,
): readonly number[] | undefined {
  return requireRows(world, componentId).get(eid);
}

export function removeEntityComponent(
  world: World,
  componentId: number,
  eid: number,
): boolean {
  return requireRows(world, componentId).delete(eid);
}

export function registerSystem(world: World, system: SimSystem): void {
  world.systems.push(system);
}

/**
 * Advance exactly one fixed 30 Hz tick. With a path scheduler attached,
 * its pump runs first: due responses apply ascending-id BEFORE systems
 * (movement consumes fresh paths this same tick), and a late response
 * holds the whole tick — no increment, no command drain — so commands
 * and world state stay exactly where the blocked boundary left them.
 * Commands can only ever be seen on their target tick because late
 * inbox submissions throw.
 */
export function step(world: World): void {
  if (
    world.pathScheduler !== undefined &&
    !world.pathScheduler.pump(world.tick + 1)
  ) {
    return; // tick held on a late path response; retry next frame
  }
  world.tick += 1;
  const commands = world.inbox.drainDue(world.tick);
  for (const system of world.systems) system(world, commands);
  // Fog dirty-entity flush (SPEC §2.9): after movement, before the
  // tick-boundary commit. No-op for the M1 all-visible stub.
  world.visibility.flushDirty();
}

/** SPEC §7 state digest over every registered component. */
export function computeWorldDigest(world: World): string {
  const sources: DigestComponentSource[] = [];
  for (const name of world.registry.namesInOrder()) {
    const id = world.registry.idOf(name);
    const rows = requireRows(world, id);
    sources.push({
      name,
      eidsAscending: [...rows.keys()].sort((a, b) => a - b),
      valuesFor: (eid) => {
        const values = rows.get(eid);
        if (!values)
          throw new Error(`missing digest row ${name}:${String(eid)}`);
        return values;
      },
    });
  }
  return computeDigest(sources);
}
