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
  moveActivity,
  peekActivity,
  type ActivityQueue,
} from "../activities";
import {
  appendCombatEvent,
  combatDefOf,
  COMBAT_EVENT_DAMAGE,
  COMBAT_EVENT_DEATH,
  COMBAT_EVENT_SHOT,
  getCombatRow,
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
import { clearAssignedNode } from "../components/economy";
import { clearProductionJob, getProductionJob } from "../components/production";
import { equipmentCountsOf } from "../components/equipment";
import {
  readActivityQueue,
  writeActivityQueue,
  type SimComponents,
} from "../components";
import { MELEE_RANGE, type UnitDefinition } from "../../data/schema";
import {
  deriveUnitStats,
  strikeDamage,
  strikeDamageOnBuilding,
  type DerivedStats,
  type StatContext,
} from "../combat/stats";
import type { SimCommand } from "../core/inbox";
import {
  createEntitySpatialHash,
  type EntitySpatialHash,
} from "../core/spatialHash";
import { despawnEntity, type SimSystem, type World } from "../core/world";
import { PASSABLE } from "../world/layers";
import { issueGroupRoute, resetSteeringBookkeeping } from "./movement";
import type { PathScheduler } from "../path/scheduler";

/** Command kinds owned by this system. */
export const ATTACK_COMMAND_KIND = "attack";
export const ATTACK_MOVE_COMMAND_KIND = "attackMove";
export const STOP_COMMAND_KIND = "stop";

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
      readonly def: UnitDefinition;
      readonly owner: number;
      readonly radius: number;
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
        def,
        owner: row[1]!,
        radius,
        queue: readActivityQueue(world, comps, eid),
        dirty: false,
      };
      combatants.push(combatant);
      positions.set(eid, { x: posRow[0]!, y: posRow[1]!, radius });
      alive.add(eid);
    }
    if (combatants.length === 0) return;
    const combatantByEid = new Map<number, Combatant>();
    for (const combatant of combatants) {
      combatantByEid.set(combatant.eid, combatant);
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
    for (const eid of world.entities) {
      const posRow = world.rowsByComponentId.get(comps.positionId)?.get(eid);
      if (!posRow) continue;
      const siteRow = getBuildingSiteRow(world, comps, eid);
      const buildingRow = getBuildingRow(world, comps, eid);
      if (siteRow !== undefined) {
        positions.set(eid, {
          x: posRow[0]!,
          y: posRow[1]!,
          radius: buildingTargetRadius(siteRow[1]!),
        });
        alive.add(eid);
        structures.set(eid, {
          eid,
          row: siteRow as number[],
          kind: "site",
          owner: siteRow[0]!,
          defCode: siteRow[1]!,
          hpIndex: 3,
        });
      } else if (buildingRow !== undefined) {
        positions.set(eid, {
          x: posRow[0]!,
          y: posRow[1]!,
          radius: buildingTargetRadius(buildingRow[1]!),
        });
        alive.add(eid);
        structures.set(eid, {
          eid,
          row: buildingRow as number[],
          kind: "finished",
          owner: buildingRow[0]!,
          defCode: buildingRow[1]!,
          hpIndex: 4,
        });
      }
    }

    // ---- 3) Per-tick stat derivation memo. Keys are defCode×owner×
    // equipment — identical inputs collapse to one computation, nothing
    // survives the tick (SPEC §2.5: derived, never stored). Equipped
    // Forge commodities fold in here so an equipped and a default-fisted
    // twin of the same definition derive DIFFERENT numbers.
    const techCodesByOwner = new Map<number, ReadonlySet<number>>();
    const statsMemo = new Map<string, DerivedStats>();
    const statsOf = (combatant: Combatant): DerivedStats => {
      let codes = techCodesByOwner.get(combatant.owner);
      if (codes === undefined) {
        codes = new Set(researchedCodesLenient(world, comps, combatant.owner));
        techCodesByOwner.set(combatant.owner, codes);
      }
      const equipment = equipmentCountsOf(world, comps, combatant.eid);
      const key = `${combatant.row[0]}:${combatant.owner}:${equipment.weapons}w${equipment.armor}a`;
      let stats = statsMemo.get(key);
      if (!stats) {
        const ctx: StatContext = {
          researchedTechCodes: codes,
          equipment,
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
      let best: Combatant | undefined;
      let bestDistSq = Number.POSITIVE_INFINITY;
      for (const [owner, hash] of hashByOwner) {
        if (owner === self.owner) continue;
        const hit = hash.nearest(self.posRow[0]!, self.posRow[1]!, radius);
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
      if (head.kind === "attack") return head.targetEid === target;
      if (head.kind === "move" || head.kind === "attackMove") {
        const second = combatant.queue[1];
        return second !== undefined && second.kind === "attack"
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
      if (
        head === undefined ||
        (head.kind !== "move" && head.kind !== "attackMove")
      ) {
        return;
      }
      const tailX = head.waypoints[head.waypoints.length - 2]!;
      const tailY = head.waypoints[head.waypoints.length - 1]!;
      world.rowsByComponentId
        .get(comps.moveTargetId)
        ?.set(combatant.eid, [tailX, tailY]);
    };

    const dropEngagement = (combatant: Combatant): void => {
      const head = combatant.queue[0];
      if (head !== undefined && head.kind === "attack") {
        // A stale paired approach leg in front of a dropped head is
        // orphaned with it — remove one Move directly behind the head.
        combatant.queue.shift();
        const prev = combatant.queue[0];
        if (prev !== undefined && prev.kind === "move") {
          combatant.queue.shift();
        }
      }
      combatant.row[3] = 0;
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
            activity.kind !== "attack" ||
            activity.targetEid !== deadEid
          ) {
            continue;
          }
          combatant.queue.splice(i, 1);
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
        kind: COMBAT_EVENT_DEATH,
        attackerEid: killerEid,
        victimEid,
        amount: blow,
      });
      purgeReferencesToDead(victimEid);
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
      despawnEntity(world, victimEid);
      alive.delete(victimEid);
      structures.delete(victimEid);
      diagnostics.buildingsDestroyed += 1;
    };

    const strike = (attacker: Combatant, targetEid: number): void => {
      const targetRow = getCombatRow(world, comps, targetEid);
      const targetPos = positions.get(targetEid);
      const targetDef = combatantByEid.get(targetEid)?.def;
      if (!targetRow || !targetPos || !targetDef) return; // died this tick
      const attackerStats = statsOf(attacker);
      const defenderStats = statsOf(combatantByEid.get(targetEid)!);
      const damage = strikeDamage(
        attacker.def,
        attackerStats,
        targetDef,
        defenderStats,
      );
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
      // First striker this tick owns retaliation credit (ascending-eid
      // order makes the pick deterministic).
      if (!damageThisTick.has(targetEid)) {
        damageThisTick.set(targetEid, attacker.eid);
      }
      if (targetRow[2]! <= 0) kill(targetEid, attacker.eid, damage);
    };

    /**
     * Strike a structure (M2-T7): the SAME reload cadence and the SAME
     * counter formula resolved against the canonical `building` armor
     * class — siege→building multipliers apply from the §2.5 table.
     * Ranged strikes log SHOT events exactly like unit duels; at 0 hp
     * the destruction pipeline tears the site/building down.
     */
    const strikeStructure = (attacker: Combatant, targetEid: number): void => {
      const structure = structures.get(targetEid);
      const targetPos = positions.get(targetEid);
      if (!structure || !targetPos) return; // destroyed this tick
      const attackerStats = statsOf(attacker);
      const damage = strikeDamageOnBuilding(attacker.def, attackerStats);
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
    };

    // ---- 5) Engagement validation: foreign orders disengage, stale
    // targets clear (deaths already purge proactively; this is the
    // replay-safe backstop).
    for (const combatant of combatants) {
      if (!alive.has(combatant.eid)) continue;
      if (combatant.row[3] === 0) continue;
      if (!engagementIntact(combatant)) dropEngagement(combatant);
      else if (!alive.has(combatant.row[3]!)) dropEngagement(combatant);
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
      const stats = statsOf(combatant);
      combatant.row[4] = Math.max(0, combatant.row[4]! - 1);

      const dx = targetBody.x - combatant.posRow[0]!;
      const dy = targetBody.y - combatant.posRow[1]!;
      const distSq = dx * dx + dy * dy;
      const reach = reachOf(combatant, targetBody, stats.range);
      if (distSq <= reach * reach) {
        if (combatant.row[4]! <= 0) {
          if (structures.has(targetEid)) {
            strikeStructure(combatant, targetEid);
          } else {
            strike(combatant, targetEid);
          }
          combatant.row[4] = stats.reloadTicks;
        }
        continue;
      }

      // Out of reach: keep a Move approach leg ahead of the Attack head.
      const standPoint = standPointOf(combatant, targetBody, reach);
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
      if (head.kind === "move" || head.kind === "attackMove") {
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

    // ---- 7) Acquisition: retaliation first (this tick's damage
    // ledger), then aggro for attack-marchers — both pause-and-resume.
    for (const combatant of combatants) {
      if (!alive.has(combatant.eid)) continue;
      if (combatant.row[3] !== 0) continue; // already engaged

      const attackerEid = damageThisTick.get(combatant.eid);
      if (attackerEid !== undefined && alive.has(attackerEid)) {
        const attackerPos = positions.get(attackerEid)!;
        const ddx = attackerPos.x - combatant.posRow[0]!;
        const ddy = attackerPos.y - combatant.posRow[1]!;
        const aggroRange = combatant.def.sightRadius;
        if (ddx * ddx + ddy * ddy <= aggroRange * aggroRange) {
          engage(combatant, attackerEid);
          diagnostics.retaliations += 1;
          continue;
        }
      }

      const head = peekActivity(combatant.queue);
      if (head !== undefined && head.kind === "attackMove") {
        const enemy = nearestEnemy(combatant, combatant.def.sightRadius);
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
    const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
    if (velRow) {
      velRow[1] = 0; // Velocity layout: cruise speed second
      resetSteeringBookkeeping(velRow);
    }
  }
  diagnostics.stopCommands += 1;
}
