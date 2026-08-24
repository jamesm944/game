/**
 * Culture generator — SPEC §2.11 Culture path / M4-T4.
 *
 * The §2.11 frame's first half for the Culture path: everything that
 * EARNS Prestige, credited to the per-player cumulative PrestigeLedger
 * (components/culture.ts). The victory evaluator derives the sustained
 * prestige/min metric from this digest-visible counter's deltas across
 * the player's own VictoryCheck log — generator and decision share one
 * source of truth with zero hidden state.
 *
 * Three sources, straight off the §2.11 table:
 *
 *   - MONUMENT INCOME: every finished Monument yields its def's
 *     `victory.prestigePerMin`, accrued once per sim minute
 *     ({@link PRESTIGE_ACCRUAL_TICKS} — exact integer milli amounts,
 *     zero drift).
 *
 *   - HAPPINESS/MORALE SURPLUS: at the same boundary, every living
 *     named Pop contributes for the meter headroom above
 *     {@link PRESTIGE_MORALE_BASELINE} — fed villages radiate prestige,
 *     miserable ones don't.
 *
 *   - FESTIVALS: the `hostFestival` command converts Food + Gold into
 *     a timed prestige burst — the def's `victory.festivalCosts` are
 *     debited atomically (both ledgers, conservation-checked) and
 *     `festivalPrestige` × 1000 lands in the ledger at once; the
 *     trailing-rate metric spreads the burst across its window.
 *
 * Determinism: integer milli-units, ascending-eid iteration everywhere,
 * all state in digest-visible rows.
 */
import { creditPrestige } from "../components/culture";
import { buildingIdOfCode } from "../../data/definitions";
import { generatorDefsOf } from "../../data/victoryRoles";
import { debitLedgerSlugs } from "../core/stockpile";
import type { SimComponents } from "../components";
import type { SimCommand } from "../core/inbox";
import type { SimSystem, World } from "../core/world";

/** Command kind hosting a festival (§2.11 Culture generator). */
export const HOST_FESTIVAL_KIND = "hostFestival";

/**
 * Accrual cadence: exactly one sim minute (1800 ticks), so monument
 * income lands as exact integer milli amounts with no drift.
 */
export const PRESTIGE_ACCRUAL_TICKS = 1800;

/**
 * Morale headroom that counts as "surplus": Pops contribute only for
 * meter points above this baseline (the shared 0–NEED_MAX scale).
 */
export const PRESTIGE_MORALE_BASELINE = 50;

/** Prestige milli-units per surplus morale point per Pop per minute. */
export const PRESTIGE_MILLI_PER_SURPLUS_POINT = 20;

/** Ongoing milli-prestige/min across one player's finished Monuments. */
export function monumentIncomeMilliOf(
  world: World,
  comps: SimComponents,
  playerId: number,
): number {
  let total = 0;
  for (const def of generatorDefsOf("culture")) {
    const perMin = def.victory?.prestigePerMin;
    if (perMin === undefined) continue;
    total += finishedCountOf(world, comps, playerId, def.id) * perMin * 1000;
  }
  return total;
}

/** Finished buildings of one def id owned by `playerId`. */
function finishedCountOf(
  world: World,
  comps: SimComponents,
  playerId: number,
  defId: string,
): number {
  let count = 0;
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  if (!buildingRows) return 0;
  for (const row of buildingRows.values()) {
    if (row[0] !== playerId) continue;
    if (buildingIdOfCode(row[1]!) === defId) count += 1;
  }
  return count;
}

/** Happiness surplus milli-prestige/min across one player's living Pops. */
export function happinessSurplusMilliOf(
  world: World,
  comps: SimComponents,
  playerId: number,
): number {
  const identityRows = world.rowsByComponentId.get(comps.identityId);
  const needsRows = world.rowsByComponentId.get(comps.needsId);
  const ownerRows = world.rowsByComponentId.get(comps.ownerId);
  if (!identityRows || !needsRows) return 0;
  let surplusPoints = 0;
  for (const eid of world.entities) {
    if (!identityRows.has(eid)) continue;
    const needsRow = needsRows.get(eid);
    if (needsRow === undefined) continue;
    // Rowless-owner units read as player zero (the documented default).
    const owner = ownerRows?.get(eid)?.[0] ?? 0;
    if (owner !== playerId) continue;
    surplusPoints += Math.max(0, needsRow[2]! - PRESTIGE_MORALE_BASELINE);
  }
  return surplusPoints * PRESTIGE_MILLI_PER_SURPLUS_POINT;
}

interface FestivalDefinition {
  readonly id: string;
  readonly costs: readonly { readonly slug: string; readonly qty: number }[];
  readonly prestigeMilli: number;
}

/** The festival-carrying generator def (undefined when content lacks one). */
function festivalDef(): FestivalDefinition | undefined {
  const def = generatorDefsOf("culture").find(
    (candidate) =>
      candidate.victory?.festivalCosts !== undefined &&
      candidate.victory.festivalPrestige !== undefined &&
      Object.keys(candidate.victory.festivalCosts).length > 0,
  );
  const role = def?.victory;
  if (role === undefined || role.festivalCosts === undefined) return undefined;
  const costs: { slug: string; qty: number }[] = Object.entries(
    role.festivalCosts as Record<string, number>,
  ).map(([slug, qty]) => ({ slug, qty }));
  if (costs.length === 0) return undefined;
  return {
    id: def!.id,
    costs,
    prestigeMilli: role.festivalPrestige! * 1000,
  };
}

function applyFestivalCommand(
  world: World,
  comps: SimComponents,
  data: Readonly<Record<string, unknown>>,
): void {
  const rawPlayer = data.playerId ?? 0;
  if (
    typeof rawPlayer !== "number" ||
    !Number.isInteger(rawPlayer) ||
    rawPlayer < 0
  ) {
    throw new Error("hostFestival playerId must be a non-negative integer");
  }
  const festival = festivalDef();
  if (festival === undefined) {
    throw new Error("hostFestival requires a festival-capable monument def");
  }
  // Atomic multi-ledger debit; throws loudly when short (payCosts shape).
  debitLedgerSlugs(
    world,
    comps,
    rawPlayer,
    festival.costs.map(({ slug, qty }) => ({ defId: slug, qty })),
    "hosting a festival",
  );
  creditPrestige(world, comps, rawPlayer, festival.prestigeMilli);
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the culture SimSystem. Register anywhere after the stockpile
 * ledgers exist; accrual reads settled meters and finished buildings,
 * and both generators only ever add to ledger rows.
 */
export function createCultureSystem(comps: SimComponents): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    for (const command of commands) {
      if (command.kind !== HOST_FESTIVAL_KIND) continue;
      if (!command.data) throw new Error("hostFestival requires command data");
      applyFestivalCommand(world, comps, command.data);
    }

    if (world.tick === 0 || world.tick % PRESTIGE_ACCRUAL_TICKS !== 0) return;
    const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
    if (!stockpileRows) return;
    for (const ledgerEid of [...stockpileRows.keys()].sort((a, b) => a - b)) {
      const playerId = stockpileRows.get(ledgerEid)?.[0];
      if (playerId === undefined) continue;
      const milli =
        monumentIncomeMilliOf(world, comps, playerId) +
        happinessSurplusMilliOf(world, comps, playerId);
      if (milli > 0) creditPrestige(world, comps, playerId, milli);
    }
  };
}
