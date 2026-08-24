/**
 * Relic system — SPEC §2.11 Relic path / M4-T5 (issue #60).
 *
 * Owns the §2.11 relic lifecycle through the shared-inbox command
 * interface:
 *
 *   collectRelic  { unitEid, relicEid } — a live owned monk picks a
 *                 GROUND relic up (Relic row → CARRIED, holder=monk);
 *   depositRelic  { unitEid, monasteryEid } — the carrying monk stores
 *                 its relic inside a finished own Monastery of the same
 *                 owner (Relic row → STORED, holder=monastery).
 *
 * The v1 carry is a deliberate STUB per the ticket: no walk-to-pickup
 * activity chain yet — commands validate and apply instantly, so
 * goldens drive them deterministically from the scenario script. The
 * state machine itself is real: grounded relics can only be lifted,
 * carried relics only deposited, and capture-on-destruction grounds
 * stored/carried relics again via the combat teardown hooks
 * (components/relic.ts dropStoredRelicsOf / dropCarriedRelicsOf).
 *
 * Symmetry: commands carry explicit entity ids and validate against
 * ownership rows only — the AI submits exactly the same kinds.
 *
 * Storage targets resolve through definition content: any building
 * whose §2.11 role declares path "relic" accepts relics (the Monastery
 * today). Registration order is free relative to labor systems; the
 * victory evaluator reads the resulting Relic rows on its own cadence.
 */

import { buildingDefOf, buildingIdOfCode } from "../../data/definitions";
import { buildingDefsForVictoryPath } from "../../data/victoryRoles";
import { getBuildingRow } from "../components/buildings";
import {
  carriedRelicOf,
  carryRelic,
  relicRowOf,
  RELIC_GROUND,
  storeRelic,
  type RelicComponents,
} from "../components/relic";
import type { SimCommand } from "../core/inbox";
import type { SimComponents } from "../components";
import type { SimSystem, World } from "../core/world";

/** Command kind: pick a grounded relic up with a monk. */
export const COLLECT_RELIC_COMMAND_KIND = "collectRelic";
/** Command kind: store the carried relic in a monastery. */
export const DEPOSIT_RELIC_COMMAND_KIND = "depositRelic";

export interface RelicSystemOptions {
  readonly comps: SimComponents & RelicComponents;
}

function parsePositiveInt(
  data: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/** Owner of a live unit (Owner row; player zero stays rowless). */
function ownerOfUnit(
  world: World,
  comps: SimComponents & RelicComponents,
  unitEid: number,
): number | undefined {
  if (!world.entities.includes(unitEid)) return undefined;
  if (!world.rowsByComponentId.get(comps.unitTagId)?.has(unitEid)) {
    return undefined;
  }
  return world.rowsByComponentId.get(comps.ownerId)?.get(unitEid)?.[0] ?? 0;
}

/**
 * Build the relic SimSystem. State transitions land on the command's
 * target tick like every other inbox order — replay-exact by
 * construction.
 */
export function createRelicSystem(options: RelicSystemOptions): SimSystem {
  const comps = options.comps;

  /** Finished-building def ids whose role serves the relic path. */
  let storageDefIds: string[] | undefined;
  const storageIds = (): string[] =>
    (storageDefIds ??= buildingDefsForVictoryPath("relic")
      .filter((def) => def.victory?.holdTicks !== undefined)
      .map((def) => def.id));

  const applyCollect = (
    world: World,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const unitEid = parsePositiveInt(data, "unitEid");
    const relicEid = parsePositiveInt(data, "relicEid");
    const owner = ownerOfUnit(world, comps, unitEid);
    if (owner === undefined) {
      throw new Error(
        `collectRelic unit ${String(unitEid)} is not a live unit`,
      );
    }
    const relic = relicRowOf(world, comps, relicEid);
    if (relic === undefined) {
      throw new Error(`entity ${String(relicEid)} has no Relic row`);
    }
    if (relic.state !== RELIC_GROUND) {
      throw new Error(
        `relic ${String(relicEid)} is not on the ground (state ${String(relic.state)})`,
      );
    }
    carryRelic(world, comps, relicEid, unitEid);
  };

  const applyDeposit = (
    world: World,
    data: Readonly<Record<string, unknown>>,
  ): void => {
    const unitEid = parsePositiveInt(data, "unitEid");
    const monasteryEid = parsePositiveInt(data, "monasteryEid");
    const owner = ownerOfUnit(world, comps, unitEid);
    if (owner === undefined) {
      throw new Error(
        `depositRelic unit ${String(unitEid)} is not a live unit`,
      );
    }
    // Exactly one relic moves per command — the carrier's first-held
    // (ascending eid), keeping multi-relic relays deterministic.
    const relicEid = carriedRelicOf(world, comps, unitEid);
    if (relicEid === undefined) {
      throw new Error(`unit ${String(unitEid)} carries no relic`);
    }
    const buildingRow = getBuildingRow(world, comps, monasteryEid);
    if (!buildingRow) {
      throw new Error(
        `depositRelic target ${String(monasteryEid)} has no finished Building row`,
      );
    }
    if (buildingRow[0] !== owner) {
      throw new Error("depositRelic target must belong to the carrier's owner");
    }
    const defId = buildingIdOfCode(buildingRow[1]!);
    if (!storageIds().includes(defId)) {
      throw new Error(
        `building ${buildingDefOf(defId).name} cannot store relics`,
      );
    }
    storeRelic(world, comps, relicEid, monasteryEid);
  };

  return (world: World, commands: readonly SimCommand[]): void => {
    for (const command of commands) {
      if (!command.data) continue;
      switch (command.kind) {
        case COLLECT_RELIC_COMMAND_KIND:
          applyCollect(world, command.data);
          break;
        case DEPOSIT_RELIC_COMMAND_KIND:
          applyDeposit(world, command.data);
          break;
        default:
          break;
      }
    }
  };
}
