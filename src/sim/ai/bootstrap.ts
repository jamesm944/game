/**
 * AI opponent bootstrapping — M2-T9 item 5 (issue #43).
 *
 * Stands up the second player's start EXACTLY like the human setup in
 * main.ts: one ledger entity carrying Stockpile/CommodityStockpile/
 * AgeState rows, a finished town center and starting villagers — at a
 * MIRRORED map position so skirmish starts are symmetric.
 *
 * This is scenario-editor-grade setup (the same bootstrap privilege
 * placement.stampFinishedBuilding documents): it exists so worlds can
 * SUPPORT an AI-owned second TC; the AI itself still plays exclusively
 * through command drafts into the inbox (see planner.ts).
 */

import { createPlayerAgeState } from "../components/age";
import { spawnUnit, type SimComponents } from "../components";
import {
  createCommodityStockpile,
  createPlayerStockpile,
} from "../core/stockpile";
import { stampFinishedBuilding } from "../systems/placement";
import type { World } from "../core/world";

/** The M2 skirmish AI sits at player slot 1 (human is PLAYER_ONE). */
export const AI_PLAYER = 1;

/** Opening dark-age capital mirrored from main.ts's player setup. */
const DEFAULT_STARTING_RESOURCES = [200, 600, 100, 0, 0, 0, 0];

export interface AiStartOptions {
  /** Player slot (defaults to {@link AI_PLAYER}). */
  readonly player?: number | undefined;
  /** Town-center footprint ORIGIN tile for the AI base. */
  readonly tcOrigin: readonly [number, number];
  /** World-coordinate spawn points for the starting villagers. */
  readonly villagerSpawns: readonly (readonly [number, number])[];
  /** Amounts indexed by resource code; defaults to the main.ts seed. */
  readonly startingResources?: readonly number[] | undefined;
}

export interface AiStartHandle {
  readonly player: number;
  readonly tcEid: number;
  readonly ledgerEid: number;
  readonly villagerEids: readonly number[];
}

/**
 * Mirror a footprint origin through the map center (180° rotation):
 * the canonical two-player start symmetry.
 */
export function mirrorOrigin(
  originX: number,
  originY: number,
  footWidth: number,
  footHeight: number,
  mapSize: number,
): { x: number; y: number } {
  return {
    x: mapSize - originX - footWidth,
    y: mapSize - originY - footHeight,
  };
}

/**
 * Bootstrap the AI opponent's mirrored start. Call AFTER
 * defineSimComponents and BEFORE the first step() — same discipline as
 * every fixture's spawn phase. Villagers carry explicit Owner rows so
 * per-player population accounting sees them (M2-T9).
 */
export function setupAiOpponent(
  world: World,
  comps: SimComponents,
  options: AiStartOptions,
): AiStartHandle {
  const player = options.player ?? AI_PLAYER;
  if (!Number.isInteger(player) || player < 1) {
    throw new Error(
      `AI opponent needs a non-human player slot ≥ 1, got ${String(player)}`,
    );
  }
  const [tcX, tcY] = options.tcOrigin;
  const ledgerEid = createPlayerStockpile(
    world,
    comps,
    player,
    options.startingResources ?? DEFAULT_STARTING_RESOURCES,
  );
  createCommodityStockpile(world, comps, player);
  createPlayerAgeState(world, comps, player);
  const tcEid = stampFinishedBuilding(world, comps, "town-center", tcX, tcY, {
    playerId: player,
  });
  const villagerEids = options.villagerSpawns.map(([x, y]) =>
    spawnUnit(world, comps, x, y, {
      baseSpeed: 1.0,
      ownerId: player,
    }),
  );
  return { player, tcEid, ledgerEid, villagerEids };
}
