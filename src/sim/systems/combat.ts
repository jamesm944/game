/**
 * Combat system — SPEC §2.5 / M2-T5.
 *
 * Owns the Attack, attackMove and stop activities plus every engagement
 * state transition, exclusively inside step():
 *
 *   attack command   → replace the unit's whole queue with Attack{t}
 *                      (explicit orders always win; gather/build jobs
 *                      release their claims)
 *   attackMove       → march flagged combat-ready; enemies inside the
 *                      AGGRO radius (= definition sightRadius) pause the
 *                      march by inserting an Attack head; kill or
 *                      lost-target drops the head and the march RESUMES
 *                      automatically. With a PathScheduler attached the
 *                      order reuses movement's group-route pipeline
 *                      (ONE leader A* request, concentric-ring slots);
 *                      schedulerless worlds keep the M2-T5 direct
 *                      single-waypoint march.
 *   retaliation      → a damaged unit with no live engagement acquires
 *                      its striker when the striker stands inside aggro
 *                      range, pausing whatever it was doing (a chopped
 *                      tree keeps its slot and resumes after the kill)
 *   stop             → cancel every queued activity, drop engagements
 *                      and release job claims (SPEC §2.13 "stop (S)")
 *
 * Engagement mechanics per advancing unit (ascending eid):
 *   - out of range  → maintain a single-waypoint Move approach leg ahead
 *     of the Attack head (movement steers only the head); the leg
 *     re-aims when the target drifts beyond APPROACH_REFRESH_DISTANCE
 *   - inside range  → strike on the reload cadence: damage =
 *     max(1, attack × bonusMultiplier − targetArmor) computed from
 *     DERIVED stats (sim/combat/stats.ts — never stored), floored to an
 *     integer for exact digest rows
 *   - ranged strikes additionally append a SHOT event (the projectile
 *     stub: damage lands instantly this tick; M2-T6 upgrades the event
 *     into real flight + visuals)
 *
 * M2-T7 BUILDINGS AS TARGETS: every construction site and finished
 * building is attackable through the SAME command/formula surface —
 * attack orders accept their eids, reach uses the footprint's
 * circumscribed radius (a stand point outside the circumscribed circle
 * is always off the impassable rect, so melee attackers can always
 * arrive), and strikes run `strikeDamageOnBuilding` (the §2.5 counter
 * formula with the canonical `building` armor-class tag — siege→building
 * multipliers apply the moment siege content lands). Buildings never
 * retaliate and are invisible to aggro acquisition (attack-marches
 * plow past them unless explicitly ordered); they hold no Combat row.
 *
 * Destruction (hp → 0, sites included) is immediate and permanent:
 *
 *   DEATH event on the owner's log → every worker whose AssignedSite /
 *   ProductionJob pointed here is released to idle (counted) → the
 *   footprint tiles return to PASSABLE and the path scheduler's
 *   passabilityVersion bumps (in-flight paths re-validate; the gather
 *   system's cost cache invalidates wholesale) → a Rubble-state entity
 *   spawns over the footprint → attackers lose their Attack heads
 *   (paused jobs resume) → despawn drops EVERY functional row (DropOff,
 *   TrainQueue, ProductionCycle … die by construction).
 *
 * Deaths are immediate and permanent: the victim's entity loses EVERY
 * component row (work-slot and site claims die with it — the gather
 * system recomputes claims from AssignedNode rows alone), and all other
 * combatants drop Attack activities / target references pointing at the
 * corpse. Damage/death land in the victim owner's digest-visible
 * CombatEvents log; shots land in the attacker owner's log.
 *
 * Determinism: every decision reads digest-visible rows; iteration is
 * ascending-eid throughout; the only cross-tick state is component
 * state. Stats re-derive per tick into a scratch memo (per def×owner)
 * that never survives the system call.
 */

import {
  attackActivity,
  attackMoveActivity,
  cancelActivities,
  dequeueCurrentActivity,
  guardActivity,
  moveActivity,
  patrolActivity,
  peekActivity,
  type ActivityQueue,
  garrisonActivity,
  packActivity,
  convertActivity,
} from "../activities";
import {
  clearConversion,
  getConversionProgress,
  getFaith,
  setConversion,
  setFaith,
  type FaithComponents,
} from "../components/faith";
import {
  attachStance,
  codeToStance,
  getStance,
  parseStance,
  setStance,
} from "../components/stance";
import {
  appendCombatEvent,
  combatDefOf,
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_DEATH,
  COMBAT_EVENT_SHOT,
  COMBAT_EVENT_UNIT_DEATH,
  getCombatRow,
  spawnCombatUnit,
  type CombatComponents,
} from "../components/combat";
import {
  clearAssignedSite,
  footprintOfDefCode,
  getAssignedSite,
  getBuildingRow,
  getBuildingSiteRow,
  spawnRubble,
} from "../components/buildings";
import {
  clearGarrison,
  getGarrisonCount,
  readGarrison,
  writeGarrison,
} from "../components/garrison";
import { injuryImpairmentOf } from "../components/body";
import { isRoutingOf } from "../components/morale";
import { ageRankOf } from "../components/age";
import {
  buildingDefOf,
  buildingIdOfCode,
  unitCodeOf,
  unitIdOfCode,
} from "../../data/definitions";
import { dropCarriedRelicsOf, dropStoredRelicsOf } from "../components/relic";
import { clearAssignedNode } from "../components/economy";
import { clearProductionJob, getProductionJob } from "../components/production";
import { equipmentCountsOf } from "../components/equipment";
import { hasSkillsRow } from "../components/skills";
import {
  awardPractice,
  COMBAT_XP_PER_HIT,
  COMBAT_XP_PER_KILL,
  skillLevelOf,
} from "./skills";
import {
  readActivityQueue,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import {
  DEFAULT_RELOAD_TICKS,
  MELEE_RANGE,
  type UnitDefinition,
} from "../../data/schema";
import {
  deriveUnitStats,
  effectiveArmorOf,
  strikeDamage,
  strikeDamageOnBuilding,
  type DerivedStats,
  type StatContext,
} from "../combat/stats";
import { applyStrikeInjuries } from "./injuries";
import type { SimCommand } from "../core/inbox";
import {
  createEntitySpatialHash,
  type EntitySpatialHash,
} from "../core/spatialHash";
import { despawnEntity, type SimSystem, type World } from "../core/world";
import { PASSABLE } from "../world/layers";
import { issueGroupRoute, resetSteeringBookkeeping } from "./movement";
import { isChildOf } from "./lifecycle";
import {
  applyElevationDamage,
  elevationAt,
  elevationRangeBonus,
  elevationSightBonus,
} from "../combat/elevation";
import type { PathScheduler } from "../path/scheduler";

/** Command kinds owned by this system. */
export const ATTACK_COMMAND_KIND = "attack";
export const ATTACK_MOVE_COMMAND_KIND = "attackMove";
export const STOP_COMMAND_KIND = "stop";
export const PATROL_COMMAND_KIND = "patrol";
export const GUARD_COMMAND_KIND = "guard";
export const SET_STANCE_COMMAND_KIND = "setStance";
export const GARRISON_COMMAND_KIND = "garrison";
export const UNGARRISON_COMMAND_KIND = "ungarrison";
export const PACK_COMMAND_KIND = "pack";
export const UNPACK_COMMAND_KIND = "unpack";
export const CONVERT_COMMAND_KIND = "convert";

/**
 * An approach leg re-aims once the target strays this far from the
 * point the leg was written for (kiting bounds the churn; static duels
 * never pay it).
 */
const APPROACH_REFRESH_DISTANCE = 0.75;
/** Stand this fraction inside max range so float jitter cannot flip a
 *  unit between in-range and out-of-range across ticks. */
const RANGE_STAND_FACTOR = 0.9;

/**
 * Circumscribed-circle radius of a building footprint: the reach ring
 * computed against it always lies OUTSIDE the impassable rect (the
 * circle contains it), so even a melee attacker's stand point lands on
 * passable ground movement can actually reach — no wall-hugging
 * deadlock against a full-tile footprint.
 */
export function buildingTargetRadius(defCode: number): number {
  const fp = footprintOfDefCode(defCode);
  const halfW = fp.width / 2;
  const halfH = fp.height / 2;
  return Math.sqrt(halfW * halfW + halfH * halfH);
}

export interface CombatDiagnostics {
  /** attack commands applied. */
  attackCommands: number;
  /** attackMove commands applied. */
  attackMoveCommands: number;
  /** stop commands applied. */
  stopCommands: number;
  /** patrol commands applied. */
  patrolCommands: number;
  /** guard commands applied. */
  guardCommands: number;
  /** setStance commands applied. */
  setStanceCommands: number;
  /** garrison commands applied. */
  garrisonCommands: number;
  /** ungarrison commands applied. */
  ungarrisonCommands: number;
  /** pack commands applied. */
  packCommands: number;
  /** unpack commands applied. */
  unpackCommands: number;
  /** convert commands applied. */
  convertCommands: number;
  /** Strikes landed (ranged shots included). */
  strikes: number;
  /** Units killed. */
  kills: number;
  /** Buildings/sites destroyed into rubble (M2-T7). */
  buildingsDestroyed: number;
  /**
   * Workers released to idle because their construction site or
   * production workplace died under them (M2-T7).
   */
  workersRetasked: number;
  /** Damaged units that auto-acquired their striker. */
  retaliations: number;
  /** Attack-marching units that acquired a fresh target via aggro. */
  aggroAcquisitions: number;
}

export function createCombatDiagnostics(): CombatDiagnostics {
  return {
    attackCommands: 0,
    attackMoveCommands: 0,
    stopCommands: 0,
    patrolCommands: 0,
    guardCommands: 0,
    setStanceCommands: 0,
    garrisonCommands: 0,
    ungarrisonCommands: 0,
    packCommands: 0,
    unpackCommands: 0,
    convertCommands: 0,
    strikes: 0,
    kills: 0,
    buildingsDestroyed: 0,
    workersRetasked: 0,
    retaliations: 0,
    aggroAcquisitions: 0,
  };
}

// ---- Command parsing ----------------------------------------------------------

function parseEntityIds(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} requires a non-empty id array`);
  }
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
      throw new Error(
        `${label} entries must be positive integers, got ${String(entry)}`,
      );
    }
    if (!ids.includes(entry)) ids.push(entry);
  }
  ids.sort((a, b) => a - b);
  return ids;
}

interface AttackData {
  readonly attackerIds: readonly number[];
  readonly targetId: number;
}

function parseAttackData(data: Readonly<Record<string, unknown>>): AttackData {
  return {
    attackerIds: parseEntityIds(data.attackerIds, "attack"),
    targetId: requirePositiveInt(data.targetId, "attack targetId"),
  };
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `${label} must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, got ${String(value)}`);
  }
  return value;
}

// ---- The system ---------------------------------------------------------------

/**
 * Build the combat SimSystem. Register AFTER movement (and gather):
 * strikes and acquisitions must observe this tick's final positions,
 * and queues rewritten here must survive movement's write-back window.
 *
 * Pass the world's PathScheduler to upgrade attack-move orders from the
 * M2-T5 direct march into the full group-route pipeline (leader A* +
 * formation slots, SPEC §2.13). Schedulerless worlds (legacy fixtures)
 * keep byte-identical T5 behavior.
 */
export function createCombatSystem(
  comps: SimComponents,
  diagnostics: CombatDiagnostics = createCombatDiagnostics(),
  paths?: PathScheduler | undefined,
): SimSystem {
  return (world: World, commands: readonly SimCommand[]): void => {
    const size = world.layers.size;

    // ---- 1) Commands consumed exactly on their target tick boundary.
    for (const command of commands) {
      if (command.kind === ATTACK_COMMAND_KIND) {
        if (!command.data) throw new Error("attack requires command data");
        applyAttackCommand(world, comps, diagnostics, command.data);
      } else if (command.kind === ATTACK_MOVE_COMMAND_KIND) {
        if (!command.data) throw new Error("attackMove requires command data");
        applyAttackMoveCommand(
          world,
          comps,
          diagnostics,
          paths,
          command.data,
          size,
        );
      } else if (command.kind === STOP_COMMAND_KIND) {
        if (!command.data) throw new Error("stop requires command data");
        applyStopCommand(world, comps, diagnostics, command.data);
      } else if (command.kind === PATROL_COMMAND_KIND) {
        applyPatrolCommand(world, comps, diagnostics, command);
      } else if (command.kind === GUARD_COMMAND_KIND) {
        applyGuardCommand(world, comps, diagnostics, command);
      } else if (command.kind === SET_STANCE_COMMAND_KIND) {
        applySetStanceCommand(world, comps, diagnostics, command);
      } else if (command.kind === GARRISON_COMMAND_KIND) {
        applyGarrisonCommand(world, comps, diagnostics, command);
      } else if (command.kind === UNGARRISON_COMMAND_KIND) {
        applyUngarrisonCommand(world, comps, diagnostics, command);
      } else if (command.kind === PACK_COMMAND_KIND) {
        applyPackCommand(world, comps, diagnostics, command);
      } else if (command.kind === UNPACK_COMMAND_KIND) {
        applyUnpackCommand(world, comps, diagnostics, command);
      } else if (command.kind === CONVERT_COMMAND_KIND) {
        applyConvertCommand(world, comps, diagnostics, command);
      }
    }

    // ---- 2) Collect live combatants ascending eid (rows are the only
    // state; everything else derives per tick).
    interface Combatant {
      readonly eid: number;
      /** Live Combat row [defCode, owner, hp, targetEid, cooldown]. */
      readonly row: number[];
      readonly posRow: number[];
      readonly velRow: number[];
      readonly tagRow: number[];
      def: UnitDefinition;
      readonly owner: number;
      readonly radius: number;
      /** Tile elevation (0–8), cached once per tick. */
      readonly elev: number;
      queue: ActivityQueue;
      dirty: boolean;
    }

    const combatants: Combatant[] = [];
    const positions = new Map<
      number,
      { x: number; y: number; radius: number }
    >();
    const alive = new Set<number>();
    for (const eid of world.entities) {
      const row = getCombatRow(world, comps, eid);
      if (!row) continue;
      const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
      const tagRow = world.rowsByComponentId.get(comps.unitTagId)?.get(eid);
      const def = combatDefOf(world, comps, eid);
      if (!posRow || !velRow || !tagRow || !def) continue;
      const radius = tagRow[2]!;
      const combatant: Combatant = {
        eid,
        row,
        posRow,
        velRow,
        tagRow,
        def,
        owner: row[1]!,
        radius,
        elev: elevationAt(world.layers, posRow[0]!, posRow[1]!),
        queue: readActivityQueue(world, comps, eid),
        dirty: false,
      };
      combatants.push(combatant);
      positions.set(eid, { x: posRow[0]!, y: posRow[1]!, radius });
      alive.add(eid);
    }
    const combatantByEid = new Map<number, Combatant>();
    for (const combatant of combatants) {
      combatantByEid.set(combatant.eid, combatant);
    }
    let maxElevation = 0;
    for (const c of combatants)
      if (c.elev > maxElevation) maxElevation = c.elev;

    // ---- 2a) Faith regeneration (V14 Issue #101): idle monks regenerate faith
    // (+faithRegenPerTick up to maxFaith) when not actively converting.
    if ((comps as Partial<FaithComponents>).faithId !== undefined) {
      const faithRows = world.rowsByComponentId.get(
        (comps as FaithComponents).faithId,
      );
      if (faithRows) {
        for (const [eid, fRow] of faithRows) {
          if (!alive.has(eid)) continue;
          const def = combatantByEid.get(eid)?.def;
          const maxFaith = def?.maxFaith ?? 100;
          const regen = def?.faithRegenPerTick ?? 1;
          // Regenerate only when not actively converting
          if (fRow[1] === 0 && fRow[0]! < maxFaith) {
            fRow[0] = Math.min(maxFaith, fRow[0]! + regen);
          }
        }
      }
    }

    // ---- 2b) Collect attackable structures ascending eid (M2-T7):
    // every BuildingSite and finished Building row joins the target
    // space with its footprint-center position and circumscribed
    // radius. Structures never act — no Combat row, no hash entry, no
    // retaliation — they only receive strikes.
    interface StructureTarget {
      readonly eid: number;
      /** Live BuildingSite or Building row (mutable hp column). */
      readonly row: number[];
      readonly kind: "site" | "finished";
      readonly owner: number;
      readonly defCode: number;
      /** Index of the hp column in `row` (3 on sites, 4 on buildings). */
      readonly hpIndex: number;
    }

    const structures = new Map<number, StructureTarget>();
    const siteRows =
      comps.buildingSiteId !== undefined
        ? world.rowsByComponentId.get(comps.buildingSiteId)
        : undefined;
    if (siteRows) {
      for (const [eid, siteRow] of siteRows) {
        const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!posRow) continue;
        positions.set(eid, {
          x: posRow[0]!,
          y: posRow[1]!,
          radius: buildingTargetRadius(siteRow[1]!),
        });
        alive.add(eid);
        structures.set(eid, {
          eid,
          row: siteRow,
          kind: "site",
          owner: siteRow[0]!,
          defCode: siteRow[1]!,
          hpIndex: 3,
        });
      }
    }
    const buildingRows =
      comps.buildingId !== undefined
        ? world.rowsByComponentId.get(comps.buildingId)
        : undefined;
    if (buildingRows) {
      for (const [eid, buildingRow] of buildingRows) {
        const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!posRow) continue;
        positions.set(eid, {
          x: posRow[0]!,
          y: posRow[1]!,
          radius: buildingTargetRadius(buildingRow[1]!),
        });
        alive.add(eid);
        structures.set(eid, {
          eid,
          row: buildingRow,
          kind: "finished",
          owner: buildingRow[0]!,
          defCode: buildingRow[1]!,
          hpIndex: 4,
        });
      }
    }
    if (combatants.length === 0 && structures.size === 0) return;

    // ---- 3) Per-tick stat derivation memo. Keys are defCode×owner×
    // equipment×own-skill-levels — identical inputs collapse to one
    // computation, nothing survives the tick (SPEC §2.5: derived, never
    // stored). Equipped Forge commodities fold in here so an equipped
    // and a default-fisted twin of the same definition derive DIFFERENT
    // numbers; the unit's melee/ranged levels (M3-T2) fold in so a
    // veteran hits harder than its rowless recruit twin.
    const techCodesByOwner = new Map<number, ReadonlySet<number>>();
    const statsMemo = new Map<string, DerivedStats>();
    const skillLevelsOf = (
      eid: number,
    ): ReadonlyMap<string, number> | undefined => {
      if (!hasSkillsRow(world, comps, eid)) return undefined;
      return new Map<string, number>([
        ["melee", skillLevelOf(world, comps, eid, "melee") ?? 0],
        ["ranged", skillLevelOf(world, comps, eid, "ranged") ?? 0],
      ]);
    };
    const equipmentRows = comps.equipmentId
      ? world.rowsByComponentId.get(comps.equipmentId)
      : undefined;
    const bodyRows = comps.bodyId
      ? world.rowsByComponentId.get(comps.bodyId)
      : undefined;
    const identityRows = comps.identityId
      ? world.rowsByComponentId.get(comps.identityId)
      : undefined;
    const baseStatsByDefCode = new Map<number, DerivedStats>();

    const statsOf = (combatant: Combatant): DerivedStats => {
      let codes = techCodesByOwner.get(combatant.owner);
      if (codes === undefined) {
        codes = new Set(researchedCodesLenient(world, comps, combatant.owner));
        techCodesByOwner.set(combatant.owner, codes);
      }
      const eqRow = equipmentRows?.get(combatant.eid);
      const hasEquip = eqRow ? eqRow[0]! > 0 || eqRow[1]! > 0 : false;
      const hasSkills = hasSkillsRow(world, comps, combatant.eid);
      const bodyRow = bodyRows?.get(combatant.eid);
      const hasInjuries = bodyRow ? bodyRow[0] !== 0 : false;

      if (codes.size === 0 && !hasEquip && !hasSkills && !hasInjuries) {
        const defCode = combatant.row[0]!;
        let base = baseStatsByDefCode.get(defCode);
        if (!base) {
          base = deriveUnitStats(combatant.def, {});
          baseStatsByDefCode.set(defCode, base);
        }
        return base;
      }

      const equipment = equipmentCountsOf(world, comps, combatant.eid);
      const skills = skillLevelsOf(combatant.eid);
      // M3-T4: open wounds re-price a fighter mid-duel (an arm hits
      // softer, legs chase slower), so the impairment multipliers join
      // the memo key — wounded and unwounded twins never collapse.
      const impairment = injuryImpairmentOf(world, comps, combatant.eid);
      const key = `${combatant.row[0]}:${combatant.owner}:${equipment.weapons}w${equipment.armor}a:${skills?.get("melee") ?? "x"}m${skills?.get("ranged") ?? "x"}r:${impairment.attackMult}at${impairment.speedMult}sp`;
      let stats = statsMemo.get(key);
      if (!stats) {
        const ctx: StatContext = {
          researchedTechCodes: codes,
          equipment,
          skillLevels: skills,
          impairment: {
            attackMult: impairment.attackMult,
            speedMult: impairment.speedMult,
          },
        };
        stats = deriveUnitStats(combatant.def, ctx);
        statsMemo.set(key, stats);
      }
      return stats;
    };

    // ---- 4) Enemy spatial hashes per owner for aggro queries. Ties
    // resolve to the lower eid exactly like the picking hash.
    const hashByOwner = new Map<number, EntitySpatialHash>();
    for (const combatant of combatants) {
      let hash = hashByOwner.get(combatant.owner);
      if (!hash) {
        hash = createEntitySpatialHash();
        hashByOwner.set(combatant.owner, hash);
      }
      hash.insert(combatant.eid, combatant.posRow[0]!, combatant.posRow[1]!);
    }
    const nearestEnemy = (
      self: Combatant,
      radius: number,
    ): Combatant | undefined => {
      const minRange = self.def.minRange;
      let best: Combatant | undefined;
      let bestDistSq = Number.POSITIVE_INFINITY;
      for (const [owner, hash] of hashByOwner) {
        if (owner === self.owner) continue;
        const hit =
          minRange !== undefined
            ? hash.nearest(self.posRow[0]!, self.posRow[1]!, radius, minRange)
            : hash.nearest(self.posRow[0]!, self.posRow[1]!, radius);
        if (!hit) continue;
        if (
          hit.distSq < bestDistSq ||
          (hit.distSq === bestDistSq &&
            best !== undefined &&
            hit.eid < best.eid)
        ) {
          const candidate = combatantByEid.get(hit.eid);
          if (candidate && alive.has(candidate.eid)) {
            bestDistSq = hit.distSq;
            best = candidate;
          }
        }
      }
      return best;
    };

    /**
     * True when this combatant's queue still carries the engagement:
     * either the Attack head itself or our approach pair (Move leg with
     * the Attack right behind it). Any foreign rewrite (groupMove,
     * gather, build …) breaks both shapes and disengages the unit.
     */
    const engagementIntact = (combatant: Combatant): boolean => {
      const head = combatant.queue[0];
      const target = combatant.row[3]!;
      if (head === undefined) return false;
      if (head.kind === "attack" || head.kind === "convert")
        return head.targetEid === target;
      if (
        head.kind === "move" ||
        head.kind === "attackMove" ||
        head.kind === "patrol"
      ) {
        const second = combatant.queue[1];
        return second !== undefined &&
          (second.kind === "attack" || second.kind === "convert")
          ? second.targetEid === target
          : false;
      }
      return false;
    };

    /**
     * Point MoveTarget back at a paused march once the engagement
     * above it ends: approach legs overwrite MoveTarget with combat
     * stand points while fighting, and any stall-recovery re-path
     * during the RESUMED march must aim at the real destination, not
     * the last stand point (M2-T6 resume contract).
     */
    const restoreMarchTarget = (combatant: Combatant): void => {
      const head = combatant.queue[0];
      if (head === undefined) return;
      if (head.kind === "move" || head.kind === "attackMove") {
        const tailX = head.waypoints[head.waypoints.length - 2]!;
        const tailY = head.waypoints[head.waypoints.length - 1]!;
        world.rowsByComponentId
          .get(comps.moveTargetId)
          ?.set(combatant.eid, [tailX, tailY]);
      } else if (head.kind === "patrol") {
        const targetX = head.waypoints[head.cursor]!;
        const targetY = head.waypoints[head.cursor + 1]!;
        world.rowsByComponentId
          .get(comps.moveTargetId)
          ?.set(combatant.eid, [targetX, targetY]);
      } else if (head.kind === "guard") {
        const targetPos = positions.get(head.targetEid);
        if (targetPos) {
          world.rowsByComponentId
            .get(comps.moveTargetId)
            ?.set(combatant.eid, [targetPos.x, targetPos.y]);
        }
      }
    };

    const dropEngagement = (combatant: Combatant): void => {
      const first = peekActivity(combatant.queue);
      if (first?.kind === "move") {
        const second = combatant.queue[1];
        if (second?.kind === "attack" || second?.kind === "convert") {
          dequeueCurrentActivity(combatant.queue);
          dequeueCurrentActivity(combatant.queue);
        }
      } else if (first?.kind === "attack" || first?.kind === "convert") {
        dequeueCurrentActivity(combatant.queue);
        const next = peekActivity(combatant.queue);
        if (next?.kind === "move") {
          dequeueCurrentActivity(combatant.queue);
        }
      }
      combatant.row[3] = 0;
      if ((comps as Partial<FaithComponents>).faithId !== undefined) {
        clearConversion(world, comps as FaithComponents, combatant.eid);
      }
      restoreMarchTarget(combatant);
      combatant.dirty = true;
    };

    /**
     * Engage `targetEid`, pausing whatever the unit was doing: the
     * Attack head slides in front of the existing queue so a chopped
     * tree (or a marching attackMove) resumes automatically once the
     * fight ends. Re-targeting swaps the head's payload in place.
     */
    const engage = (combatant: Combatant, targetEid: number): void => {
      combatant.row[3] = targetEid;
      const head = peekActivity(combatant.queue);
      if (head !== undefined && head.kind === "attack") {
        head.targetEid = targetEid;
      } else {
        combatant.queue.unshift(attackActivity(targetEid));
      }
      resetSteeringBookkeeping(combatant.velRow);
      combatant.dirty = true;
    };

    /**
     * Point on the target-facing edge of the attacker's reach ring.
     * Reach is EDGE-TO-EDGE (definition range + both body radii), so a
     * melee unit halts just outside the steering push-apart band and
     * can always actually arrive at its stand point.
     */
    const reachOf = (
      self: Combatant,
      target: { radius: number },
      range: number,
    ): number => range + self.radius + target.radius;

    const standPointOf = (
      self: Combatant,
      target: { x: number; y: number; radius: number },
      reach: number,
    ): { x: number; y: number } => {
      const sx = self.posRow[0]!;
      const sy = self.posRow[1]!;
      const dx = sx - target.x;
      const dy = sy - target.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const stand = reach * RANGE_STAND_FACTOR;
      if (dist <= 1e-9) return { x: target.x, y: target.y };
      const scale = Math.min(stand, dist) / dist;
      return { x: target.x + dx * scale, y: target.y + dy * scale };
    };

    /**
     * Approach legs must aim at a PASSABLE tile. The reach ring lies
     * outside the TARGET's own footprint, but a packed base can put a
     * NEIGHBOR's impassable tiles under the geometric stand point — an
     * unreachable path goal makes movement fail the route and cancel
     * the whole queue (engagement silently lost, M2 sign-off e2e).
     * Rescue: expand Chebyshev rings around the ideal point and take
     * the closest passable tile center (strict < keeps the first of
     * equal distances — deterministic). Bounded so a truly boxed-in
     * structure falls back to the raw point and fails honestly.
     */
    const APPROACH_STANDPOINT_SEARCH_RING = 3;
    const passableApproachPoint = (point: {
      x: number;
      y: number;
    }): { x: number; y: number } => {
      const size = world.layers.size;
      const passability = world.layers.derivedPassability;
      const baseX = Math.floor(point.x);
      const baseY = Math.floor(point.y);
      const tilePassable = (tx: number, ty: number): boolean =>
        tx >= 0 &&
        ty >= 0 &&
        tx < size &&
        ty < size &&
        passability[ty * size + tx] === PASSABLE;
      // Happy path: the ideal stand point already sits on passable
      // ground — return it UNTOUCHED so approach geometry (and every
      // digest downstream of it) stays byte-identical to pre-rescue.
      if (tilePassable(baseX, baseY)) return point;
      let best: { x: number; y: number } | undefined;
      let bestD = Number.POSITIVE_INFINITY;
      for (
        let ring = 1;
        ring <= APPROACH_STANDPOINT_SEARCH_RING && best === undefined;
        ring++
      ) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const tx = baseX + dx;
            const ty = baseY + dy;
            if (!tilePassable(tx, ty)) continue;
            const cx = tx + 0.5;
            const cy = ty + 0.5;
            const d = (cx - point.x) ** 2 + (cy - point.y) ** 2;
            if (d < bestD) {
              bestD = d;
              best = { x: cx, y: cy };
            }
          }
        }
      }
      return best ?? { x: point.x, y: point.y };
    };

    /**
     * Remove every queued reference to a freshly dead entity: Attack
     * heads targeting it (plus their directly-paired approach leg) and
     * dangling Combat target columns. Paused jobs resume untouched.
     */
    const purgeReferencesToDead = (deadEid: number): void => {
      for (const combatant of combatants) {
        if (!alive.has(combatant.eid)) continue;
        if (combatant.row[3] === deadEid) combatant.row[3] = 0;
        let removed = false;
        for (let i = combatant.queue.length - 1; i >= 0; i--) {
          const activity = combatant.queue[i];
          if (
            activity === undefined ||
            (activity.kind !== "attack" && activity.kind !== "convert") ||
            activity.targetEid !== deadEid
          ) {
            continue;
          }
          combatant.queue.splice(i, 1);
          if ((comps as Partial<FaithComponents>).faithId !== undefined) {
            clearConversion(world, comps as FaithComponents, combatant.eid);
          }
          const prev = combatant.queue[i - 1];
          if (prev !== undefined && prev.kind === "move") {
            // The orphaned approach leg dies with its head; both slots
            // are gone, so skip past the leg's index on the way down.
            combatant.queue.splice(i - 1, 1);
            i -= 1;
          }
          removed = true;
        }
        if (removed) {
          restoreMarchTarget(combatant);
          combatant.dirty = true;
        }
      }
    };

    const kill = (victimEid: number, killerEid: number, blow: number): void => {
      const victim = combatantByEid.get(victimEid)!;
      appendCombatEvent(world, comps, victim.owner, {
        tick: world.tick,
        // M2-T10: unit deaths carry their own kind code so the death
        // ledger separates fallen units from razed structures.
        kind: COMBAT_EVENT_UNIT_DEATH,
        attackerEid: killerEid,
        victimEid,
        amount: blow,
      });
      // M3-T2: kills pay a bonus to the killer's combat skill.
      const killer = combatantByEid.get(killerEid);
      if (killer) {
        awardPractice(
          world,
          comps,
          killerEid,
          (killer.def.range ?? MELEE_RANGE) > MELEE_RANGE ? "ranged" : "melee",
          COMBAT_XP_PER_KILL,
        );
      }
      purgeReferencesToDead(victimEid);
      // M4-T5 §2.11: a fallen carrier grounds its carried relic at the
      // corpse's position before the rows die.
      dropCarriedRelicsOf(world, comps, victimEid);
      // N3: If the dying unit had garrisoned units (e.g. transport ship sunk),
      // clean up the garrison row so trapped units perish with the vessel.
      if (comps.garrisonId !== undefined) {
        clearGarrison(world, comps, victimEid);
      }
      // Every row dies with the entity — work-slot and site claims are
      // released by construction (claims ARE those rows).
      despawnEntity(world, victimEid);
      alive.delete(victimEid);
      diagnostics.kills += 1;
    };

    /**
     * Tear a destroyed structure down (M2-T7), in a pinned order:
     *
     *   1. DEATH event on the owner's digest-visible log;
     *   2. every worker whose AssignedSite / ProductionJob pointed here
     *      is released to idle — queue cancelled, steering reset,
     *      counted (the "villagers retask" contract; gatherers hauling
     *      cargo reroute through the gather system's own destroyed-
     *      dropoff path next tick);
     *   3. footprint tiles return to PASSABLE and the scheduler's
     *      passabilityVersion bumps once — in-flight paths re-validate
     *      via their LOS raycasts (bounded repath storm) and the gather
     *      cost cache invalidates wholesale;
     *   4. a Rubble-state entity spawns over the footprint (new eid —
     *      the dead id never returns);
     *   5. attackers drop their Attack heads / dangling targets
     *      (paused jobs resume untouched);
     *   6. despawn removes EVERY functional row at once — DropOff
     *      deregistration, TrainQueue purge and ProductionCycle loss
     *      fall out by construction.
     */
    const destroyStructure = (
      victimEid: number,
      killerEid: number,
      blow: number,
    ): void => {
      const structure = structures.get(victimEid)!;
      appendCombatEvent(world, comps, structure.owner, {
        tick: world.tick,
        kind: COMBAT_EVENT_DEATH,
        attackerEid: killerEid,
        victimEid,
        amount: blow,
      });

      for (const workerEid of world.entities) {
        const assignedHere =
          getAssignedSite(world, comps, workerEid) === victimEid ||
          getProductionJob(world, comps, workerEid)?.buildingEid === victimEid;
        if (!assignedHere) continue;
        clearAssignedSite(world, comps, workerEid);
        clearProductionJob(world, comps, workerEid);
        const queue = readActivityQueue(world, comps, workerEid);
        cancelActivities(queue);
        writeActivityQueue(world, comps, workerEid, queue);
        const velRow = world.rowsByComponentId
          .get(comps.velocityId)
          ?.get(workerEid);
        if (velRow) resetSteeringBookkeeping(velRow);
        diagnostics.workersRetasked += 1;
      }

      const fp = footprintOfDefCode(structure.defCode);
      const posRow = world.rowsByComponentId
        .get(comps.positionId)
        ?.get(victimEid);
      const originX =
        structure.kind === "finished"
          ? structure.row[2]!
          : posRow![0]! - fp.width / 2;
      const originY =
        structure.kind === "finished"
          ? structure.row[3]!
          : posRow![1]! - fp.height / 2;

      const size = world.layers.size;
      const passability = world.layers.derivedPassability;
      for (let dy = 0; dy < fp.height; dy++) {
        for (let dx = 0; dx < fp.width; dx++) {
          passability[(originY + dy) * size + (originX + dx)] = PASSABLE;
        }
      }
      const scheduler = world.pathScheduler;
      scheduler?.setPassabilityVersion(scheduler.passabilityVersion + 1);

      spawnRubble(world, comps, structure.defCode, originX, originY);

      purgeReferencesToDead(victimEid);
      // M4-T5 §2.11: a destroyed monastery (or any building) grounds its
      // stored relics at the footprint center BEFORE the despawn wipes
      // the holder's rows — capture-on-destruction.
      dropStoredRelicsOf(world, comps, victimEid);

      // V13 (Issue #96): Eject any garrisoned units before the building despawns
      if (comps.garrisonId !== undefined) {
        const trapped = clearGarrison(world, comps, victimEid);
        if (trapped.length > 0) {
          for (const u of trapped) {
            const defId = unitIdOfCode(u.unitCode);
            const newEid = spawnCombatUnit(
              world,
              comps,
              defId,
              originX + 0.5,
              originY + 0.5,
              u.owner,
            );
            const cRow = getCombatRow(world, comps, newEid);
            if (cRow) {
              cRow[2] = Math.max(1, Math.floor(u.hp * 0.5));
            }
            if (comps.stanceId !== undefined) {
              attachStance(world, comps, newEid, codeToStance(u.stanceCode));
            }
          }
        }
      }

      despawnEntity(world, victimEid);
      alive.delete(victimEid);
      structures.delete(victimEid);
      diagnostics.buildingsDestroyed += 1;
    };

    const applyAoEBlast = (
      attacker: Combatant,
      attackerStats: DerivedStats,
      blastX: number,
      blastY: number,
      targetEid: number,
    ): void => {
      const aoeRadius = attacker.def.aoeRadius;
      if (aoeRadius === undefined || aoeRadius <= 0) return;

      // 1. Splash damage to nearby units (including friendly fire!)
      for (const other of combatants) {
        if (other.eid === targetEid || !alive.has(other.eid)) continue;
        const odx = other.posRow[0]! - blastX;
        const ody = other.posRow[1]! - blastY;
        const maxDist = aoeRadius + other.radius;
        if (odx * odx + ody * ody <= maxDist * maxDist) {
          const otherRow = getCombatRow(world, comps, other.eid);
          if (!otherRow) continue;
          const otherStats = statsOf(other);
          const splashDamage = strikeDamage(
            attacker.def,
            attackerStats,
            other.def,
            otherStats,
          );
          otherRow[2] = Math.max(0, otherRow[2]! - splashDamage);
          appendCombatEvent(world, comps, other.owner, {
            tick: world.tick,
            kind: COMBAT_EVENT_DAMAGE,
            attackerEid: attacker.eid,
            victimEid: other.eid,
            amount: splashDamage,
          });
          const wounds = applyStrikeInjuries(
            world,
            comps,
            other.eid,
            splashDamage,
          );
          if (
            attacker.owner !== other.owner &&
            !damageThisTick.has(other.eid)
          ) {
            damageThisTick.set(other.eid, attacker.eid);
          }
          if (otherRow[2]! <= 0 || wounds.fatal) {
            kill(other.eid, attacker.eid, splashDamage);
          }
        }
      }

      // 2. Splash damage to nearby structures
      for (const [structEid, otherStruct] of structures) {
        if (structEid === targetEid || !alive.has(structEid)) continue;
        const sPos = positions.get(structEid);
        if (!sPos) continue;
        const sdx = sPos.x - blastX;
        const sdy = sPos.y - blastY;
        const maxDist = aoeRadius + sPos.radius;
        if (sdx * sdx + sdy * sdy <= maxDist * maxDist) {
          const structDamage = strikeDamageOnBuilding(
            attacker.def,
            attackerStats,
          );
          otherStruct.row[otherStruct.hpIndex] = Math.max(
            0,
            otherStruct.row[otherStruct.hpIndex]! - structDamage,
          );
          appendCombatEvent(world, comps, otherStruct.owner, {
            tick: world.tick,
            kind: COMBAT_EVENT_DAMAGE,
            attackerEid: attacker.eid,
            victimEid: structEid,
            amount: structDamage,
          });
          if (otherStruct.row[otherStruct.hpIndex]! <= 0) {
            destroyStructure(structEid, attacker.eid, structDamage);
          }
        }
      }
    };

    const strike = (attacker: Combatant, targetEid: number): void => {
      // M3-T5: children cannot fight (SPEC §2.3). A child ordered into
      // battle marches but never lands a blow — no damage, no wounds,
      // no practice, no retaliation credit.
      if (
        identityRows &&
        identityRows.has(attacker.eid) &&
        isChildOf(world, comps, attacker.eid)
      )
        return;
      const targetRow = getCombatRow(world, comps, targetEid);
      const targetPos = positions.get(targetEid);
      const targetDef = combatantByEid.get(targetEid)?.def;
      if (!targetRow || !targetPos || !targetDef) return; // died this tick
      const blastX = targetPos.x;
      const blastY = targetPos.y;
      const attackerStats = statsOf(attacker);
      const defenderCombatant = combatantByEid.get(targetEid)!;
      const defenderStats = statsOf(defenderCombatant);
      const baseDamage = strikeDamage(
        attacker.def,
        attackerStats,
        targetDef,
        defenderStats,
      );
      // #107: high-ground bonus / low-ground penalty (±25%).
      let damage = baseDamage;
      if (maxElevation > 0) {
        const targetElev = defenderCombatant.elev;
        if (attacker.elev !== targetElev) {
          damage = applyElevationDamage(baseDamage, attacker.elev, targetElev);
        }
      }
      targetRow[2] = Math.max(0, targetRow[2]! - damage);
      diagnostics.strikes += 1;

      // Projectile stub (M2-T5): ranged shots log a SHOT event for the
      // attacker owner — damage still lands instantly; M2-T6 turns the
      // row into real flight. Melee strikes skip it.
      if (attackerStats.range > MELEE_RANGE) {
        appendCombatEvent(world, comps, attacker.owner, {
          tick: world.tick,
          kind: COMBAT_EVENT_SHOT,
          attackerEid: attacker.eid,
          victimEid: targetEid,
          amount: damage,
        });
      }
      appendCombatEvent(world, comps, combatantByEid.get(targetEid)!.owner, {
        tick: world.tick,
        kind: COMBAT_EVENT_DAMAGE,
        attackerEid: attacker.eid,
        victimEid: targetEid,
        amount: damage,
      });
      // M3-T4: every landed blow also wounds (SPEC §2.5 "wounds in
      // battle") — severity lands on one seeded body part; trauma
      // past the death threshold kills through the SAME pipeline.
      const wounds = applyStrikeInjuries(world, comps, targetEid, damage);
      // M3-T2: every landed blow practices the relevant combat skill —
      // ranged when the attacker's derived reach beats melee, else melee.
      awardPractice(
        world,
        comps,
        attacker.eid,
        attackerStats.range > MELEE_RANGE ? "ranged" : "melee",
        COMBAT_XP_PER_HIT,
      );
      // First striker this tick owns retaliation credit (ascending-eid
      // order makes the pick deterministic).
      if (!damageThisTick.has(targetEid)) {
        damageThisTick.set(targetEid, attacker.eid);
      }
      if (targetRow[2]! <= 0 || wounds.fatal) {
        kill(targetEid, attacker.eid, damage);
      }
      applyAoEBlast(attacker, attackerStats, blastX, blastY, targetEid);
    };

    /**
     * Strike a structure (M2-T7): the SAME reload cadence and the SAME
     * counter formula resolved against the canonical `building` armor
     * class — siege→building multipliers apply from the §2.5 table.
     * Ranged strikes log SHOT events exactly like unit duels; at 0 hp
     * the destruction pipeline tears the site/building down.
     */
    const strikeStructure = (attacker: Combatant, targetEid: number): void => {
      // M3-T5: children cannot fight — raiding included.
      if (
        identityRows &&
        identityRows.has(attacker.eid) &&
        isChildOf(world, comps, attacker.eid)
      )
        return;
      const structure = structures.get(targetEid);
      const targetPos = positions.get(targetEid);
      if (!structure || !targetPos) return; // destroyed this tick
      const blastX = targetPos.x;
      const blastY = targetPos.y;
      const attackerStats = statsOf(attacker);
      const baseDamage = strikeDamageOnBuilding(attacker.def, attackerStats);
      let damage = baseDamage;
      if (maxElevation > 0) {
        const targetElev = elevationAt(world.layers, targetPos.x, targetPos.y);
        if (attacker.elev !== targetElev) {
          damage = applyElevationDamage(baseDamage, attacker.elev, targetElev);
        }
      }
      structure.row[structure.hpIndex] = Math.max(
        0,
        structure.row[structure.hpIndex]! - damage,
      );
      diagnostics.strikes += 1;

      if (attackerStats.range > MELEE_RANGE) {
        appendCombatEvent(world, comps, attacker.owner, {
          tick: world.tick,
          kind: COMBAT_EVENT_SHOT,
          attackerEid: attacker.eid,
          victimEid: targetEid,
          amount: damage,
        });
      }
      appendCombatEvent(world, comps, structure.owner, {
        tick: world.tick,
        kind: COMBAT_EVENT_DAMAGE,
        attackerEid: attacker.eid,
        victimEid: targetEid,
        amount: damage,
      });
      if (structure.row[structure.hpIndex]! <= 0) {
        destroyStructure(targetEid, attacker.eid, damage);
      }
      applyAoEBlast(attacker, attackerStats, blastX, blastY, targetEid);
    };

    // ---- 5) Engagement validation: foreign orders disengage, stale
    // targets clear (deaths already purge proactively; this is the
    // replay-safe backstop). M3-T9: ROUTERS shed any engagement before
    // the advance pass below — broken units can be attacked down but
    // never swing back, even on the tick an order landed.
    for (const combatant of combatants) {
      if (!alive.has(combatant.eid)) continue;
      if (combatant.row[3] === 0) continue;
      if (!engagementIntact(combatant)) dropEngagement(combatant);
      else if (!alive.has(combatant.row[3]!)) dropEngagement(combatant);
      else if (isRoutingOf(world, comps, combatant.eid)) {
        dropEngagement(combatant);
      }
    }

    // Advance packing/unpacking activities
    for (const combatant of combatants) {
      if (combatant.def.siegeState === undefined) continue;
      if (!alive.has(combatant.eid)) continue;
      const head = peekActivity(combatant.queue);
      if (head?.kind === "pack") {
        head.remainingTicks -= 1;
        combatant.dirty = true;
        if (combatant.row[3] !== 0) {
          combatant.row[3] = 0;
        }
        if (head.remainingTicks <= 0) {
          dequeueCurrentActivity(combatant.queue);
          const newDefId = head.targetUnitId;
          const newDefCode = unitCodeOf(newDefId);
          combatant.row[0] = newDefCode;
          const newDef = combatDefOf(world, comps, combatant.eid);
          if (newDef) {
            combatant.def = newDef;
            combatant.tagRow[0] = newDef.speed;
          }
        }
      }
    }

    // ---- 6) Advance engagements ascending eid: reload cadence ticks
    // whenever engaged; strikes land inside reach; approach legs form
    // and re-aim outside it.
    const damageThisTick = new Map<number, number>();
    for (const combatant of combatants) {
      if (!alive.has(combatant.eid)) continue;
      const targetEid = combatant.row[3]!;
      if (targetEid === 0) continue;
      const targetBody = positions.get(targetEid);
      if (!targetBody) continue;

      const headAct = peekActivity(combatant.queue);
      const isConvert =
        headAct?.kind === "convert" ||
        ((headAct?.kind === "move" ||
          headAct?.kind === "attackMove" ||
          headAct?.kind === "patrol") &&
          combatant.queue[1]?.kind === "convert");

      if (isConvert) {
        // Monks cannot convert structures or dead entities
        if (structures.has(targetEid) || !alive.has(targetEid)) {
          dropEngagement(combatant);
          continue;
        }

        const convertRange =
          combatant.def.convertRange ?? combatant.def.sightRadius ?? 8.0;
        const reach = reachOf(combatant, targetBody, convertRange);
        const sightRadius = combatant.def.sightRadius ?? 8.0;
        const sightReach = reachOf(combatant, targetBody, sightRadius);

        const dx = targetBody.x - combatant.posRow[0]!;
        const dy = targetBody.y - combatant.posRow[1]!;
        const distSq = dx * dx + dy * dy;

        // Interruption: target left sight radius (> sightReach)
        if (distSq > sightReach * sightReach) {
          dropEngagement(combatant);
          continue;
        }

        // Out of convert reach: approach target
        if (distSq > reach * reach) {
          if ((comps as Partial<FaithComponents>).faithId !== undefined) {
            const prog = getConversionProgress(
              world,
              comps as FaithComponents,
              combatant.eid,
            );
            if (prog > 0) {
              clearConversion(world, comps as FaithComponents, combatant.eid);
            }
          }
          if (combatant.def.speed === 0) continue;
          const standPoint = passableApproachPoint(
            standPointOf(combatant, targetBody, reach),
          );
          if (headAct === undefined || headAct.kind === "convert") {
            combatant.queue.unshift(moveActivity([standPoint.x, standPoint.y]));
            world.rowsByComponentId
              .get(comps.moveTargetId)
              ?.set(combatant.eid, [standPoint.x, standPoint.y]);
            resetSteeringBookkeeping(combatant.velRow);
            combatant.dirty = true;
            continue;
          }
          if (
            headAct.kind === "move" ||
            headAct.kind === "attackMove" ||
            headAct.kind === "patrol"
          ) {
            const second = combatant.queue[1];
            if (second === undefined || second.kind !== "convert") continue;
            const tailX = headAct.waypoints[headAct.waypoints.length - 2]!;
            const tailY = headAct.waypoints[headAct.waypoints.length - 1]!;
            const driftX = tailX - standPoint.x;
            const driftY = tailY - standPoint.y;
            if (
              driftX * driftX + driftY * driftY >
              APPROACH_REFRESH_DISTANCE * APPROACH_REFRESH_DISTANCE
            ) {
              headAct.waypoints = [standPoint.x, standPoint.y];
              headAct.cursor = 0;
              world.rowsByComponentId
                .get(comps.moveTargetId)
                ?.set(combatant.eid, [standPoint.x, standPoint.y]);
              combatant.dirty = true;
            }
          }
          continue;
        }

        // In convert reach:
        if (headAct?.kind === "move") {
          dequeueCurrentActivity(combatant.queue);
          combatant.dirty = true;
        }

        // Must have full faith (default 100) to cast
        const faith =
          (comps as Partial<FaithComponents>).faithId !== undefined
            ? getFaith(world, comps as FaithComponents, combatant.eid)
            : 100;
        const maxFaith = combatant.def.maxFaith ?? 100;
        if (faith < maxFaith) {
          if ((comps as Partial<FaithComponents>).faithId !== undefined) {
            clearConversion(world, comps as FaithComponents, combatant.eid);
          }
          continue;
        }

        // Interruption: Monk took damage this tick
        if (damageThisTick.has(combatant.eid)) {
          dropEngagement(combatant);
          continue;
        }

        // Advance cast progress
        const currentProgress =
          (comps as Partial<FaithComponents>).faithId !== undefined
            ? getConversionProgress(
                world,
                comps as FaithComponents,
                combatant.eid,
              )
            : 0;
        const nextProgress = currentProgress + 1;
        const castTicks = combatant.def.castTicks ?? 25;

        if ((comps as Partial<FaithComponents>).faithId !== undefined) {
          setConversion(
            world,
            comps as FaithComponents,
            combatant.eid,
            targetEid,
            nextProgress,
          );
        }

        if (nextProgress >= castTicks) {
          // Conversion complete!
          const targetCombatant = combatantByEid.get(targetEid);
          if (targetCombatant) {
            targetCombatant.row[1] = combatant.owner;
            if (comps.ownerId !== undefined) {
              if (combatant.owner === 0) {
                world.rowsByComponentId.get(comps.ownerId)?.delete(targetEid);
              } else {
                world.rowsByComponentId
                  .get(comps.ownerId)
                  ?.set(targetEid, [combatant.owner]);
              }
            }
            cancelActivities(targetCombatant.queue);
            targetCombatant.row[3] = 0;
            targetCombatant.dirty = true;

            // Disengage allies that were targeting targetEid
            for (const ally of combatants) {
              if (ally.owner === combatant.owner && ally.row[3] === targetEid) {
                dropEngagement(ally);
              }
            }

            if ((comps as Partial<FaithComponents>).faithId !== undefined) {
              setFaith(world, comps as FaithComponents, combatant.eid, 0);
              clearConversion(world, comps as FaithComponents, combatant.eid);
            }
            dropEngagement(combatant);
            world.visibility.markDirty("spawned", targetEid);
          }
        }
        continue;
      }

      let techSet = techCodesByOwner.get(combatant.owner);
      if (techSet === undefined) {
        techSet = new Set(
          researchedCodesLenient(world, comps, combatant.owner),
        );
        techCodesByOwner.set(combatant.owner, techSet);
      }
      const hasTechs = techSet.size > 0;
      const effectiveRange = hasTechs
        ? statsOf(combatant).range
        : (combatant.def.range ?? MELEE_RANGE);

      // #107: ranged units gain +1 range when shooting downhill.
      const targetCombatant_ = combatantByEid.get(combatant.row[3]!);
      const targetElev_ =
        targetCombatant_ !== undefined ? targetCombatant_.elev : combatant.elev;
      const rangeBonus =
        maxElevation > 0 && effectiveRange > MELEE_RANGE
          ? elevationRangeBonus(combatant.elev, targetElev_)
          : 0;
      const effectiveRangeWithElev = effectiveRange + rangeBonus;

      combatant.row[4] = Math.max(0, combatant.row[4]! - 1);

      const dx = targetBody.x - combatant.posRow[0]!;
      const dy = targetBody.y - combatant.posRow[1]!;
      const distSq = dx * dx + dy * dy;
      const reach = reachOf(combatant, targetBody, effectiveRangeWithElev);
      const minRange = combatant.def.minRange;
      if (distSq <= reach * reach) {
        if (minRange !== undefined && distSq < minRange * minRange) {
          continue;
        }
        if (combatant.row[4]! <= 0) {
          if (structures.has(targetEid)) {
            strikeStructure(combatant, targetEid);
          } else {
            strike(combatant, targetEid);
          }
          combatant.row[4] = hasTechs
            ? statsOf(combatant).reloadTicks
            : (combatant.def.reloadTicks ?? DEFAULT_RELOAD_TICKS);
        }
        continue;
      }

      // Immobile units (e.g. unpacked trebuchet) cannot chase targets
      if (combatant.def.speed === 0) {
        continue;
      }

      // Out of reach: check stance pursuit rules!
      const stance = getStance(world, comps, combatant.eid);
      if (stance === "stand-ground") {
        dropEngagement(combatant);
        continue;
      }
      if (stance === "defensive") {
        if (distSq > 16.0) {
          dropEngagement(combatant);
          continue;
        }
      }

      // Out of reach: keep a Move approach leg ahead of the Attack head.
      const standPoint = passableApproachPoint(
        standPointOf(combatant, targetBody, reach),
      );
      const head = peekActivity(combatant.queue);
      if (head === undefined || head.kind === "attack") {
        combatant.queue.unshift(moveActivity([standPoint.x, standPoint.y]));
        world.rowsByComponentId
          .get(comps.moveTargetId)
          ?.set(combatant.eid, [standPoint.x, standPoint.y]);
        resetSteeringBookkeeping(combatant.velRow);
        combatant.dirty = true;
        continue;
      }
      if (
        head.kind === "move" ||
        head.kind === "attackMove" ||
        head.kind === "patrol"
      ) {
        const second = combatant.queue[1];
        if (second === undefined || second.kind !== "attack") continue;
        const tailX = head.waypoints[head.waypoints.length - 2]!;
        const tailY = head.waypoints[head.waypoints.length - 1]!;
        const driftX = tailX - standPoint.x;
        const driftY = tailY - standPoint.y;
        if (
          driftX * driftX + driftY * driftY >
          APPROACH_REFRESH_DISTANCE * APPROACH_REFRESH_DISTANCE
        ) {
          head.waypoints = [standPoint.x, standPoint.y];
          head.cursor = 0;
          world.rowsByComponentId
            .get(comps.moveTargetId)
            ?.set(combatant.eid, [standPoint.x, standPoint.y]);
          combatant.dirty = true;
        }
      }
    }

    // ---- 6b) Defensive structure strikes (Watch Towers, Castles, Town Centers):
    // Finished buildings with attack > 0 (or garrisoned units) acquire the nearest
    // enemy unit in range and fire on reloadTicks cadence.
    for (const [buildingEid, structure] of structures) {
      if (structure.kind !== "finished") continue;
      const bDef = buildingDefOf(buildingIdOfCode(structure.defCode));
      if (!bDef.attack && !bDef.garrisonCapacity) continue;

      const garrisonCount =
        comps.garrisonId !== undefined
          ? getGarrisonCount(world, comps, buildingEid)
          : 0;
      const garrisonUnits =
        garrisonCount > 0 && comps.garrisonId !== undefined
          ? readGarrison(world, comps, buildingEid)
          : [];

      // Garrison heal over time
      const healRate = bDef.garrisonHealRate ?? 0.05;
      if (healRate > 0 && garrisonUnits.length > 0) {
        let healed = false;
        for (const gu of garrisonUnits) {
          if (gu.hp < gu.maxHp) {
            gu.hp = Math.min(gu.maxHp, gu.hp + healRate);
            healed = true;
          }
        }
        if (healed && comps.garrisonId !== undefined) {
          writeGarrison(world, comps, buildingEid, garrisonUnits);
        }
      }

      // Calculate garrison attack bonus
      let garrisonBonus = 0;
      if (garrisonUnits.length > 0 && bDef.garrisonAttackBonus !== undefined) {
        for (const gu of garrisonUnits) {
          const uDefId = unitIdOfCode(gu.unitCode);
          if (typeof bDef.garrisonAttackBonus === "number") {
            garrisonBonus += bDef.garrisonAttackBonus;
          } else {
            garrisonBonus +=
              bDef.garrisonAttackBonus[uDefId] ??
              bDef.garrisonAttackBonus["default"] ??
              1;
          }
        }
      }

      const baseAttack = bDef.attack ?? 0;
      let attack = baseAttack + garrisonBonus;
      const range = bDef.range ?? (bDef.id === "town-center" ? 6 : 8);
      if (attack <= 0 || range <= 0) continue;

      const reloadTicks = bDef.reloadTicks ?? 60;
      if ((world.tick + buildingEid) % reloadTicks !== 0) continue;

      const towerPos = positions.get(buildingEid);
      if (!towerPos) continue;

      // Determine attack stat (scale watch-tower with age: Feudal=5, Castle=7, Imperial=8)
      if (bDef.id === "watch-tower") {
        const rank = ageRankOf(world, comps, structure.owner) ?? 2;
        if (rank === 3) attack += 2;
        else if (rank >= 4) attack += 3;
      }

      // Find nearest alive enemy combatant within range
      // #107: watch towers / castles gain +1 range when shooting downhill.
      const towerElev = elevationAt(world.layers, towerPos.x, towerPos.y);
      let bestDistSq = (range + 1) * (range + 1);
      let targetEid = 0;
      for (const combatant of combatants) {
        if (!alive.has(combatant.eid)) continue;
        if (combatant.owner === structure.owner) continue;
        const dx = combatant.posRow[0]! - towerPos.x;
        const dy = combatant.posRow[1]! - towerPos.y;
        const distSq = dx * dx + dy * dy;
        const effectiveRng =
          range +
          (maxElevation > 0
            ? elevationRangeBonus(towerElev, combatant.elev)
            : 0);
        if (distSq <= effectiveRng * effectiveRng && distSq <= bestDistSq) {
          bestDistSq = distSq;
          targetEid = combatant.eid;
        }
      }

      if (targetEid === 0) continue;

      const targetCombatant = combatantByEid.get(targetEid);
      const targetRow = getCombatRow(world, comps, targetEid);
      if (!targetCombatant || !targetRow) continue;

      const defenderStats = statsOf(targetCombatant);
      const armor = effectiveArmorOf(
        defenderStats,
        targetCombatant.def.armorClasses,
      );
      const baseDmg = Math.max(1, Math.floor(attack - armor));
      const damage =
        maxElevation > 0
          ? applyElevationDamage(baseDmg, towerElev, targetCombatant.elev)
          : baseDmg;
      targetRow[2] = Math.max(0, targetRow[2]! - damage);
      diagnostics.strikes += 1;

      appendCombatEvent(world, comps, structure.owner, {
        tick: world.tick,
        kind: COMBAT_EVENT_SHOT,
        attackerEid: buildingEid,
        victimEid: targetEid,
        amount: damage,
      });
      appendCombatEvent(world, comps, targetCombatant.owner, {
        tick: world.tick,
        kind: COMBAT_EVENT_DAMAGE,
        attackerEid: buildingEid,
        victimEid: targetEid,
        amount: damage,
      });

      const wounds = applyStrikeInjuries(world, comps, targetEid, damage);
      if (targetRow[2]! <= 0 || wounds.fatal) {
        kill(targetEid, buildingEid, damage);
      }
    }

    // ---- 6c) Interruption check (V14 Issue #101): any monk damaged this tick
    // (whether by higher-eid combatants or defensive structures) drops conversion immediately.
    const faithMap =
      (comps as Partial<FaithComponents>).faithId !== undefined
        ? world.rowsByComponentId.get((comps as FaithComponents).faithId)
        : undefined;
    if (faithMap && faithMap.size > 0 && damageThisTick.size > 0) {
      for (const eid of damageThisTick.keys()) {
        if (!faithMap.has(eid)) continue;
        const combatant = combatantByEid.get(eid);
        if (!combatant || !alive.has(eid)) continue;
        const headAct = peekActivity(combatant.queue);
        const isConvert =
          headAct?.kind === "convert" ||
          ((headAct?.kind === "move" ||
            headAct?.kind === "attackMove" ||
            headAct?.kind === "patrol") &&
            combatant.queue[1]?.kind === "convert");
        if (isConvert) {
          dropEngagement(combatant);
        }
      }
    }

    // ---- 7) Acquisition: retaliation first (this tick's damage
    // ledger), then aggro for attack-marchers, patrol, guard, and stances.
    // M3-T9: ROUTERS never acquire — broken units can be attacked down
    // but don't fight back (their morale system owns the flight).
    for (const combatant of combatants) {
      if (!alive.has(combatant.eid)) continue;
      if (combatant.row[3] !== 0) continue; // already engaged
      if (isRoutingOf(world, comps, combatant.eid)) continue;
      if (combatant.def.attack <= 0) continue;

      if (combatant.def.siegeState !== undefined) {
        const head = peekActivity(combatant.queue);
        if (head?.kind === "pack") continue;
      }

      const stance = getStance(world, comps, combatant.eid);
      if (stance === "no-attack") continue;

      const attackerEid = damageThisTick.get(combatant.eid);
      if (attackerEid !== undefined && alive.has(attackerEid)) {
        const attackerPos = positions.get(attackerEid)!;
        const ddx = attackerPos.x - combatant.posRow[0]!;
        const ddy = attackerPos.y - combatant.posRow[1]!;
        const minRange = combatant.def.minRange ?? 0;
        const distSq = ddx * ddx + ddy * ddy;
        const maxRetaliate =
          stance === "stand-ground"
            ? (combatant.def.range ?? MELEE_RANGE) +
              combatant.radius +
              attackerPos.radius
            : combatant.def.sightRadius;
        if (
          distSq <= maxRetaliate * maxRetaliate &&
          (minRange === 0 || distSq >= minRange * minRange)
        ) {
          engage(combatant, attackerEid);
          diagnostics.retaliations += 1;
          continue;
        }
      }

      const head = peekActivity(combatant.queue);
      if (head?.kind === "pack") continue;

      const isGuard = head !== undefined && head.kind === "guard";
      const isPatrol = head !== undefined && head.kind === "patrol";
      const isAttackMove = head !== undefined && head.kind === "attackMove";

      if (isGuard) {
        // Guard auto-attacks anything that attacks the guarded target!
        const guardedEid = head.targetEid;
        const guardedAttacker = damageThisTick.get(guardedEid);
        if (guardedAttacker !== undefined && alive.has(guardedAttacker)) {
          engage(combatant, guardedAttacker);
          diagnostics.aggroAcquisitions += 1;
          continue;
        }
        // Also engage nearest enemy in sight
        // #107: elevated units see farther (+1 sight when ≥2 levels above reference).
        const baseSight = combatant.def.sightRadius ?? 8.0;
        const effectiveSight =
          maxElevation > 0
            ? baseSight + elevationSightBonus(combatant.elev, 0)
            : baseSight;
        const enemy = nearestEnemy(combatant, effectiveSight);
        if (enemy !== undefined) {
          engage(combatant, enemy.eid);
          diagnostics.aggroAcquisitions += 1;
          continue;
        }
      } else if (isAttackMove || isPatrol) {
        const maxRange =
          stance === "stand-ground"
            ? (combatant.def.range ?? MELEE_RANGE)
            : combatant.def.sightRadius;
        const enemy = nearestEnemy(combatant, maxRange);
        if (enemy !== undefined) {
          engage(combatant, enemy.eid);
          diagnostics.aggroAcquisitions += 1;
        }
      }
    }

    // ---- 8) Flush queue writes (row mutations above wrote through).
    for (const combatant of combatants) {
      if (combatant.dirty && alive.has(combatant.eid)) {
        writeActivityQueue(world, comps, combatant.eid, combatant.queue);
      }
    }
  };
}

/**
 * Lenient completed-tech lookup for stat derivation: worlds without the
 * player's ledger simply derive baseline stats instead of throwing.
 * The ledger entity lives where the player's Stockpile row lives; the
 * ResearchedTechs row itself is count-led, never owner-led.
 */
function researchedCodesLenient(
  world: World,
  comps: Pick<CombatComponents, "researchedTechsId"> & { stockpileId: number },
  playerId: number,
): number[] {
  const stockpileRows = world.rowsByComponentId.get(comps.stockpileId);
  if (!stockpileRows) return [];
  let ledgerEid: number | undefined;
  for (const [eid, row] of stockpileRows) {
    if (row[0] === playerId) {
      ledgerEid = eid;
      break;
    }
  }
  if (ledgerEid === undefined) return [];
  const row = world.rowsByComponentId
    .get(comps.researchedTechsId)
    ?.get(ledgerEid);
  if (!row) return [];
  return [...row.slice(1)].sort((a, b) => a - b);
}

// ---- Command application -------------------------------------------------------

function applyAttackCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  const parsed = parseAttackData(data);
  // Units AND structures (M2-T7: sites/finished buildings) are legal
  // targets; anything else is a caller bug and rejects loudly.
  const isStructure =
    getBuildingRow(world, comps, parsed.targetId) !== undefined ||
    getBuildingSiteRow(world, comps, parsed.targetId) !== undefined;
  const targetRow = getCombatRow(world, comps, parsed.targetId);
  if (!targetRow && !isStructure) {
    throw new Error(
      `attack targets entity ${String(parsed.targetId)}, which has no Combat or Building row`,
    );
  }
  for (const eid of parsed.attackerIds) {
    if (eid === parsed.targetId) {
      throw new Error(`attack attacker ${String(eid)} cannot target itself`);
    }
    const row = getCombatRow(world, comps, eid);
    if (!row) continue; // not a live combatant (mirrors gather's stance)
    // Explicit orders always win: release any held job claims.
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(attackActivity(parsed.targetId));
    writeActivityQueue(world, comps, eid, queue);
    row[3] = parsed.targetId;
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
  }
  diagnostics.attackCommands += 1;
}

function applyAttackMoveCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  paths: PathScheduler | undefined,
  data: Readonly<Record<string, unknown>>,
  size: number,
): void {
  const parsed = {
    ids: parseEntityIds(data.ids, "attackMove"),
    x: requireFiniteNumber(data.x, "attackMove x"),
    y: requireFiniteNumber(data.y, "attackMove y"),
  };

  // Explicit orders always win: release job claims + drop engagements
  // at ISSUE time (the route itself lands when the path response
  // applies, mirroring groupMove's latency contract).
  const releaseOrders = (eid: number): void => {
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const row = getCombatRow(world, comps, eid);
    if (row) row[3] = 0; // a fresh march drops any prior engagement
  };

  if (paths !== undefined) {
    // M2-T6 formation march: ONE leader A* request through the FIFO
    // scheduler; concentric-ring slots dealt on application (SPEC
    // §2.13 — military moves reuse the group slots).
    issueGroupRoute(
      world,
      comps,
      undefined, // movement diagnostics stay movement-owned
      paths,
      { entityIds: parsed.ids, x: parsed.x, y: parsed.y },
      {
        onIssue: releaseOrders,
        buildHead: attackMoveActivity,
      },
    );
    diagnostics.attackMoveCommands += 1;
    return;
  }

  // Schedulerless fallback (M2-T5 fixtures): clamp into the world and
  // steer straight at the destination.
  const x = Math.min(Math.max(parsed.x, 0.5), size - 0.5);
  const y = Math.min(Math.max(parsed.y, 0.5), size - 0.5);
  for (const eid of parsed.ids) {
    const row = getCombatRow(world, comps, eid);
    if (!row) continue;
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(attackMoveActivity([x, y]));
    writeActivityQueue(world, comps, eid, queue);
    row[3] = 0; // a fresh march drops any prior engagement
    world.rowsByComponentId.get(comps.moveTargetId)?.set(eid, [x, y]);
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
  }
  diagnostics.attackMoveCommands += 1;
}

/**
 * SPEC §2.13 "stop (S)": cancel every queued activity, drop any live
 * engagement and release job claims. Applies to every ActivityQueue
 * holder — villagers halt their gather chains exactly like soldiers
 * break off fights. Units keep their positions (no steering head ⇒ the
 * movement FSM parks them).
 */
function applyStopCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  data: Readonly<Record<string, unknown>>,
): void {
  for (const eid of parseEntityIds(data.entityIds, "stop")) {
    if (!world.rowsByComponentId.get(comps.activityQueueId)?.has(eid)) {
      continue; // not a live ordered unit (mirrors attack's stance)
    }
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    writeActivityQueue(world, comps, eid, queue);
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow) combatRow[3] = 0;
    if ((comps as Partial<FaithComponents>).faithId !== undefined) {
      clearConversion(world, comps as FaithComponents, eid);
    }
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) {
      velRow[1] = 0; // Velocity layout: cruise speed second
      resetSteeringBookkeeping(velRow);
    }
  }
  diagnostics.stopCommands += 1;
}

function applyPatrolCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const rawWaypoints = data.waypoints;
  if (!Array.isArray(rawWaypoints) || rawWaypoints.length < 2) {
    throw new Error("patrol requires at least 2 waypoints");
  }
  const flatWaypoints: number[] = [];
  for (const wp of rawWaypoints) {
    if (typeof wp === "number") {
      flatWaypoints.push(wp);
    } else if (
      typeof wp === "object" &&
      wp !== null &&
      "x" in wp &&
      "y" in wp
    ) {
      flatWaypoints.push(
        requireFiniteNumber((wp as { x: unknown }).x, "patrol waypoint x"),
        requireFiniteNumber((wp as { y: unknown }).y, "patrol waypoint y"),
      );
    }
  }
  if (flatWaypoints.length < 4 || flatWaypoints.length % 2 !== 0) {
    throw new Error("patrol requires an even number of coordinates >= 4");
  }

  const rawIds = data.ids ?? data.entityIds ?? data.attackerIds;
  const ids: number[] = rawIds ? parseEntityIds(rawIds, "patrol") : [];
  if (ids.length === 0) {
    for (const eid of world.entities) {
      if (world.rowsByComponentId.get(comps.activityQueueId)?.has(eid)) {
        ids.push(eid);
      }
    }
  }

  for (const eid of ids) {
    if (!world.rowsByComponentId.get(comps.activityQueueId)?.has(eid)) continue;
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(patrolActivity(flatWaypoints, 0, 1));
    writeActivityQueue(world, comps, eid, queue);
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow) combatRow[3] = 0;
    world.rowsByComponentId
      .get(comps.moveTargetId)
      ?.set(eid, [flatWaypoints[0]!, flatWaypoints[1]!]);
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
  }
  diagnostics.patrolCommands += 1;
}

function applyGuardCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const targetId = requirePositiveInt(
    data.targetId ?? data.targetEid,
    "guard targetId",
  );
  const rawIds = data.ids ?? data.entityIds ?? data.guardIds;
  const ids: number[] = rawIds ? parseEntityIds(rawIds, "guard") : [];
  if (ids.length === 0) {
    for (const eid of world.entities) {
      if (
        eid !== targetId &&
        world.rowsByComponentId.get(comps.activityQueueId)?.has(eid)
      ) {
        ids.push(eid);
      }
    }
  }

  for (const eid of ids) {
    if (eid === targetId) continue;
    if (!world.rowsByComponentId.get(comps.activityQueueId)?.has(eid)) continue;
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(guardActivity(targetId));
    writeActivityQueue(world, comps, eid, queue);
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow) combatRow[3] = 0;
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
  }
  diagnostics.guardCommands += 1;
}

function applySetStanceCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const stance = parseStance(data.stance);
  const rawIds = data.ids ?? data.entityIds;
  const ids: number[] = rawIds ? parseEntityIds(rawIds, "setStance") : [];
  if (ids.length === 0) {
    for (const eid of world.entities) {
      if (getCombatRow(world, comps, eid)) {
        ids.push(eid);
      }
    }
  }

  for (const eid of ids) {
    setStance(world, comps, eid, stance);
  }
  diagnostics.setStanceCommands += 1;
}

function applyGarrisonCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const rawBuildingId =
    data.targetBuildingId ?? data.buildingEid ?? data.targetId;
  if (typeof rawBuildingId !== "number" || rawBuildingId < 1) return;
  const targetBuildingId = rawBuildingId;

  const rawIds = data.ids ?? data.entityIds;
  if (!rawIds || !Array.isArray(rawIds)) return;

  for (const eid of rawIds) {
    if (typeof eid === "number" && eid > 0) {
      writeActivityQueue(world, comps, eid, [
        garrisonActivity(targetBuildingId),
      ]);
      const combatRow = getCombatRow(world, comps, eid);
      if (combatRow) combatRow[3] = 0;
    }
  }
  diagnostics.garrisonCommands += 1;
}

function applyUngarrisonCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const rawBuildingId =
    data.buildingEid ?? data.targetBuildingId ?? data.targetId;
  if (typeof rawBuildingId !== "number" || rawBuildingId < 1) return;
  const buildingEid = rawBuildingId;

  if (comps.garrisonId === undefined) return;
  const units = clearGarrison(world, comps, buildingEid);
  if (units.length === 0) return;

  const bRow = comps.buildingId
    ? world.rowsByComponentId.get(comps.buildingId)?.get(buildingEid)
    : undefined;
  const bPos = world.rowsByComponentId.get(comps.positionId)?.get(buildingEid);

  let exitX = bPos ? bPos[0]! : 10.5;
  let exitY = bPos ? bPos[1]! : 10.5;

  if (data.exitPoint && typeof data.exitPoint === "object") {
    const pt = data.exitPoint as { x?: number; y?: number };
    if (typeof pt.x === "number" && typeof pt.y === "number") {
      exitX = pt.x;
      exitY = pt.y;
    }
  } else if (bRow) {
    const def = buildingDefOf(buildingIdOfCode(bRow[1]!));
    const originX = bRow[2]!;
    const originY = bRow[3]!;
    exitX = originX + def.footprint.width / 2;
    exitY = originY + def.footprint.height + 0.5;
  } else {
    // Mobile unit (e.g. transport ship): disembark onto nearest passable land tile
    const size = world.layers.size;
    const passability = world.layers.derivedPassability;
    const sx = Math.floor(bPos ? bPos[0]! : 10.5);
    const sy = Math.floor(bPos ? bPos[1]! : 10.5);
    let foundLand: { x: number; y: number } | undefined;
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = sx + dx;
          const ty = sy + dy;
          if (
            tx >= 0 &&
            tx < size &&
            ty >= 0 &&
            ty < size &&
            passability[ty * size + tx] !== 0
          ) {
            foundLand = { x: tx + 0.5, y: ty + 0.5 };
            break;
          }
        }
        if (foundLand) break;
      }
      if (foundLand) break;
    }
    if (!foundLand) {
      // Cannot disembark into deep water without adjacent land — keep garrison intact
      writeGarrison(world, comps, buildingEid, units);
      return;
    }
    exitX = foundLand.x;
    exitY = foundLand.y;
  }

  for (const u of units) {
    const defId = unitIdOfCode(u.unitCode);
    const newEid = spawnCombatUnit(world, comps, defId, exitX, exitY, u.owner);
    const cRow = getCombatRow(world, comps, newEid);
    if (cRow) {
      cRow[2] = u.hp;
    }
    if (comps.stanceId !== undefined) {
      attachStance(world, comps, newEid, codeToStance(u.stanceCode));
    }
  }
  diagnostics.ungarrisonCommands += 1;
}

function applyPackCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const rawIds = data.ids ?? data.entityIds;
  if (!rawIds || !Array.isArray(rawIds)) return;
  for (const eid of rawIds) {
    if (typeof eid !== "number" || eid < 1) continue;
    const def = combatDefOf(world, comps, eid);
    if (!def || def.siegeState !== "unpacked" || !def.morphTargetId) continue;
    const packTicks = def.packTimeTicks ?? 90;
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(packActivity(packTicks, def.morphTargetId));
    writeActivityQueue(world, comps, eid, queue);
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow) combatRow[3] = 0; // disengage
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
  }
  diagnostics.packCommands += 1;
}

function applyUnpackCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as Record<string, unknown>;
  const rawIds = data.ids ?? data.entityIds;
  if (!rawIds || !Array.isArray(rawIds)) return;
  for (const eid of rawIds) {
    if (typeof eid !== "number" || eid < 1) continue;
    const def = combatDefOf(world, comps, eid);
    if (!def || def.siegeState !== "packed" || !def.morphTargetId) continue;
    const packTicks = def.packTimeTicks ?? 90;
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(packActivity(packTicks, def.morphTargetId));
    writeActivityQueue(world, comps, eid, queue);
    const combatRow = getCombatRow(world, comps, eid);
    if (combatRow) combatRow[3] = 0; // disengage
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
  }
  diagnostics.unpackCommands += 1;
}

function applyConvertCommand(
  world: World,
  comps: SimComponents,
  diagnostics: CombatDiagnostics,
  command: SimCommand,
): void {
  const data = (command.data ?? command) as unknown as Record<string, unknown>;
  const rawTarget = data.targetId ?? data.targetEid;
  if (typeof rawTarget !== "number" || rawTarget < 1) {
    throw new Error("convert requires a positive numeric targetId");
  }
  const targetEid = rawTarget;
  const targetRow = getCombatRow(world, comps, targetEid);
  if (!targetRow) {
    throw new Error(
      `convert targets entity ${String(targetEid)}, which has no Combat row`,
    );
  }

  const rawIds = data.monkEid ?? data.ids ?? data.attackerIds ?? data.entityIds;
  const monkIds: number[] = [];
  if (typeof rawIds === "number") {
    monkIds.push(rawIds);
  } else if (Array.isArray(rawIds)) {
    for (const id of rawIds) {
      if (typeof id === "number" && id >= 1) monkIds.push(id);
    }
  }

  if (monkIds.length === 0) {
    for (const eid of world.entities) {
      const def = combatDefOf(world, comps, eid);
      if (def?.id === "monk" || def?.armorClasses?.includes("monk")) {
        monkIds.push(eid);
      }
    }
  }

  if (monkIds.length === 0) {
    throw new Error("convert command requires at least one monk entity");
  }

  for (const eid of monkIds) {
    if (eid === targetEid) {
      throw new Error(`convert monk ${String(eid)} cannot target itself`);
    }
    const row = getCombatRow(world, comps, eid);
    if (!row) continue;
    clearAssignedNode(world, comps, eid);
    clearAssignedSite(world, comps, eid);
    const queue = readActivityQueue(world, comps, eid);
    cancelActivities(queue);
    queue.push(convertActivity(targetEid));
    writeActivityQueue(world, comps, eid, queue);
    row[3] = targetEid;
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) resetSteeringBookkeeping(velRow);
    if ((comps as Partial<FaithComponents>).faithId !== undefined) {
      clearConversion(world, comps as FaithComponents, eid);
    }
  }
  diagnostics.convertCommands += 1;
}
