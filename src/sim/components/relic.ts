/**
 * Relic component — SPEC §2.11 Relic path / M4-T5 (issue #60).
 *
 * Components register through the world ComponentRegistry alongside the
 * movement/economy/pop sets; registration is one strictly alphabetical
 * sequence (components/index.ts defineSimComponents), pinning digest/
 * save iteration order forever (world.ts). Relic slots between
 * Relationship and ResearchedTechs ("Rela…" < "Relic" < "Res…").
 *
 * Canonical row layout (arity is part of the digest contract) —
 * Relic (2): [stateCode, holderEid].
 *
 * One row per relic map entity ("monument-like pickups"): a neutral
 * Position-carrying entity that starts GROUNDed, may be CARRIED by a
 * monk unit, and rests STORED inside a finished Monastery. The holder
 * eid is state-specific: 0 on the ground, the carrying unit while
 * carried, the storing monastery while stored. The §2.11 evaluator
 * reads these rows directly — "hold ALL relics" is a pure query over
 * them — and the destruction hooks ({@link dropStoredRelicsOf} /
 * {@link dropCarriedRelicsOf}) are how capture-on-destruction grounds
 * a held relic again when its monastery or carrier dies.
 *
 * Lazily attached by construction: worlds without relics spawn no
 * relic entities, so every legacy digest stays byte-identical.
 */

import { spawnEntity, type ComponentRows, type World } from "../core/world";

export const RELIC = "Relic" as const;

/** Row arity per relic component — pinned for digest stability. */
export const RELIC_ARITY = 2;

/** Relic states (stateCode column). */
export const RELIC_GROUND = 0;
export const RELIC_CARRIED = 1;
export const RELIC_STORED = 2;

/** Component ids the relic systems read/write. */
export interface RelicComponents {
  readonly positionId: number;
  readonly relicId: number;
}

/** Decoded Relic row fields. */
export interface RelicRow {
  readonly state: number;
  /** Ground: 0 · carried: the monk's eid · stored: the monastery's eid. */
  readonly holderEid: number;
}

function requireRows(world: World, componentId: number): ComponentRows {
  const rows = world.rowsByComponentId.get(componentId);
  if (!rows) {
    throw new Error(`unregistered component id: ${String(componentId)}`);
  }
  return rows;
}

/**
 * Spawn one neutral grounded relic at float tile coordinates. Relics
 * are immobile map fixtures like resource nodes — no UnitTag/Velocity
 * machinery, just a Position and the Relic row.
 */
export function spawnRelic(
  world: World,
  comps: RelicComponents,
  x: number,
  y: number,
): number {
  const eid = spawnEntity(world);
  requireRows(world, comps.positionId).set(eid, [x, y]);
  requireRows(world, comps.relicId).set(eid, [RELIC_GROUND, 0]);
  return eid;
}

/** Decoded Relic row for one entity, or undefined when not a relic. */
export function relicRowOf(
  world: World,
  comps: Pick<RelicComponents, "relicId">,
  eid: number,
): RelicRow | undefined {
  const row = world.rowsByComponentId.get(comps.relicId)?.get(eid);
  if (!row) return undefined;
  return { state: row[0]!, holderEid: row[1]! };
}

function setRelicRow(
  world: World,
  comps: Pick<RelicComponents, "relicId">,
  eid: number,
  state: number,
  holderEid: number,
): void {
  requireRows(world, comps.relicId).set(eid, [state, holderEid]);
}

/** Move one grounded relic into a monk's carry. */
export function carryRelic(
  world: World,
  comps: Pick<RelicComponents, "relicId">,
  relicEid: number,
  unitEid: number,
): void {
  setRelicRow(world, comps, relicEid, RELIC_CARRIED, unitEid);
}

/** Store one carried relic inside a finished monastery. */
export function storeRelic(
  world: World,
  comps: Pick<RelicComponents, "relicId">,
  relicEid: number,
  monasteryEid: number,
): void {
  setRelicRow(world, comps, relicEid, RELIC_STORED, monasteryEid);
}

/**
 * Every relic row, ascending eid — the deterministic iteration order
 * every scan (evaluator probes, carry lookups) shares.
 */
export function relicsOf(
  world: World,
  comps: Pick<RelicComponents, "relicId">,
): { eid: number; row: RelicRow }[] {
  const out: { eid: number; row: RelicRow }[] = [];
  for (const [eid, row] of [...requireRows(world, comps.relicId)].sort(
    (a, b) => a[0] - b[0],
  )) {
    out.push({ eid, row: { state: row[0]!, holderEid: row[1]! } });
  }
  return out;
}

/** The first relic CARRIED by `unitEid`, or undefined (ascending eid). */
export function carriedRelicOf(
  world: World,
  comps: Pick<RelicComponents, "relicId">,
  unitEid: number,
): number | undefined {
  return relicsOf(world, comps).find(
    (entry) =>
      entry.row.state === RELIC_CARRIED && entry.row.holderEid === unitEid,
  )?.eid;
}

/**
 * Capture-on-destruction hook (SPEC §2.11): a destroyed building's
 * stored relics fall back to the GROUND at the holder's Position (the
 * footprint center both sites and finished buildings carry) — anyone's
 * monks may claim them from there. Call BEFORE despawnEntity tears the
 * holder's rows down.
 */
export function dropStoredRelicsOf(
  world: World,
  comps: RelicComponents,
  buildingEid: number,
): number {
  const pos = requireRows(world, comps.positionId).get(buildingEid);
  if (!pos) return 0;
  return groundRelicsHeldBy(
    world,
    comps,
    RELIC_STORED,
    buildingEid,
    pos[0]!,
    pos[1]!,
  );
}

/**
 * Death-of-carrier hook: a fallen monk's carried relic grounds at the
 * unit's last Position. Call BEFORE despawnEntity.
 */
export function dropCarriedRelicsOf(
  world: World,
  comps: RelicComponents,
  unitEid: number,
): number {
  const pos = requireRows(world, comps.positionId).get(unitEid);
  if (!pos) return 0;
  return groundRelicsHeldBy(
    world,
    comps,
    RELIC_CARRIED,
    unitEid,
    pos[0]!,
    pos[1]!,
  );
}

function groundRelicsHeldBy(
  world: World,
  comps: RelicComponents,
  state: number,
  holderEid: number,
  x: number,
  y: number,
): number {
  let dropped = 0;
  for (const { eid, row } of relicsOf(world, comps)) {
    if (row.state !== state || row.holderEid !== holderEid) continue;
    setRelicRow(world, comps, eid, RELIC_GROUND, 0);
    requireRows(world, comps.positionId).set(eid, [x, y]);
    dropped += 1;
  }
  return dropped;
}
