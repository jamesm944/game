/**
 * Pop card read-row exporter — SPEC §2.13 / M3-T9 (issue #54).
 *
 * One pure function, {@link buildPopCard}, folds every per-Pop row the
 * card shows into a plain data object: identity (name/age/origin/life
 * stage), trait chips, skill bars with the knowledge-vs-practice split,
 * six-part body injury status, hp, the morale meter with its derived
 * break point and routing flag, and the current-activity string.
 *
 * The UI (ui/popCard.ts) renders whatever this returns and nothing else
 * — every value comes from the same digest-visible rows the golden
 * digests hash, so chrome and sim cannot disagree ("derived stats,
 * never stored" applied to UI reads). Undefined for entities without an
 * Identity row: buildings and legacy units have no card.
 */

import { peekActivity, type Activity } from "./activities";
import {
  BODY_PART_SLUGS,
  injuryImpairmentOf,
  readInjuries,
  readScars,
  type BodyPartSlug,
  type ImpairmentMultipliers,
  type InjuryReadout,
  type ScarReadout,
} from "./components/body";
import { getCombatRow, combatDefOf } from "./components/combat";
import {
  LEISURE_VENUE_BROTHEL,
  LEISURE_VENUE_MASS,
  LEISURE_VENUE_SHRINE,
  LEISURE_VENUE_STUDY,
  LEISURE_VENUE_TAVERN,
  LEISURE_VENUE_VISIT,
} from "./activities";
import type { SimComponents } from "./components";
import { isRoutingOf, type MoraleComponents } from "./components/morale";
import {
  POP_ORIGIN_BIRTH,
  popNameOf,
  readIdentity,
  readTraits,
} from "./components/pop";
import { readNeeds } from "./components/needs";
import { readSkillEntries } from "./components/skills";
import { levelOfTotalXp } from "./data/skills";
import { readActivityQueue } from "./components";
import {
  effectiveAgeOf,
  lifeStageOf,
  LIFE_STAGE_CHILD,
  type LifecycleConfig,
  type LifeStage,
  DEFAULT_LIFECYCLE_CONFIG,
} from "./systems/lifecycle";
import { moraleBreakPointOf } from "./systems/morale";
import type { World } from "./core/world";

/** One skill bar's row: derived level plus the knowledge XP share. */
export interface PopCardSkill {
  readonly slug: string;
  readonly level: number;
  /** knowledgeXp / totalXp ∈ [0,1] — the bar's theory-vs-practice split. */
  readonly knowledgeShare01: number;
}

/** Per-part body status line for the card's injury strip. */
export interface PopCardBodyPart {
  readonly part: BodyPartSlug;
  readonly status: "healthy" | "injured" | "scarred";
  /** Active severity on this part (0 when none). */
  readonly severity: number;
}

/** The morale section: undefined when the Pop has no Needs row. */
export interface PopCardMorale {
  readonly value: number;
  /** Derived break point (undefined without a Morale row). */
  readonly breakPoint?: number | undefined;
  readonly routing: boolean;
}

/** Everything one selected Pop's card shows, straight off sim rows. */
export interface PopCardData {
  readonly eid: number;
  readonly name: string;
  /** Effective age in whole days (fractional, one decimal). */
  readonly ageDays: number;
  readonly lifestage: LifeStage;
  readonly originLabel: string;
  readonly traits: readonly string[];
  /** Top skills by level (level desc, slug asc tiebreak). */
  readonly skills: readonly PopCardSkill[];
  /** Combat hp; undefined for non-combatant Pops. */
  readonly hp?: { readonly current: number; readonly max: number } | undefined;
  readonly bodyParts: readonly PopCardBodyPart[];
  readonly injuries: readonly InjuryReadout[];
  readonly scars: readonly ScarReadout[];
  /**
   * Derived-on-read impairment factors from open wounds (§2.13:
   * "injury must have visible mechanical meaning") — the exact
   * multipliers the movement/work/combat systems apply.
   */
  readonly impairments: ImpairmentMultipliers;
  readonly morale?: PopCardMorale | undefined;
  readonly activity: string;
}

/** Max skill bars on one card (the prototype showed five). */
export const POP_CARD_SKILL_COUNT = 5;

/**
 * Human-readable current activity for one queue head. Routers override
 * with "Fleeing!" — the card must show the panic over the leg.
 */
export function activityLabelOf(activity: Activity | undefined): string {
  if (activity === undefined) return "Idle";
  switch (activity.kind) {
    case "move":
      return "Walking";
    case "wait":
      return "Waiting";
    case "gather":
      return "Gathering";
    case "deliver":
      return "Delivering";
    case "attack":
      return "Fighting";
    case "attackMove":
      return "Marching to battle";
    case "eat":
      return "Eating";
    case "sleep":
      return activity.isNap ? "Napping" : "Sleeping";
    case "leisure":
      switch (activity.venueCode) {
        case LEISURE_VENUE_TAVERN:
          return "At the tavern";
        case LEISURE_VENUE_BROTHEL:
          return "At the brothel";
        case LEISURE_VENUE_SHRINE:
          return "At the shrine";
        case LEISURE_VENUE_STUDY:
          return "Studying";
        case LEISURE_VENUE_VISIT:
          return "Visiting friends";
        case LEISURE_VENUE_MASS:
          return "At Morning Mass";
        default:
          return "Taking leisure";
      }
    default:
      return "Idle";
  }
}

/**
 * Build one Pop's card data, or undefined when the entity carries no
 * Identity row (buildings, resource nodes, legacy rowless units).
 * `config` rescales age for compressed fixture clocks.
 */
export function buildPopCard(
  world: World,
  comps: SimComponents & MoraleComponents,
  eid: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): PopCardData | undefined {
  const identity = readIdentity(world, comps, eid);
  if (!identity) return undefined;
  const name = popNameOf(world, comps, eid)!;
  const ageTicks = effectiveAgeOf(world, comps, eid, config) ?? 0;
  const ageDays = Math.round((ageTicks / config.dayTicks) * 10) / 10;
  const lifestage = lifeStageOf(world, comps, eid, config) ?? LIFE_STAGE_CHILD;
  const traits = readTraits(world, comps, eid) ?? [];

  // ---- Skills: level + knowledge share per entry --------------------
  const entries = readSkillEntries(world, comps, eid);
  const skills: PopCardSkill[] = (entries ?? [])
    .map((entry) => {
      const total = entry.knowledgeXp + entry.practiceXp;
      return {
        slug: entry.slug,
        level: levelOfTotalXp(total),
        knowledgeShare01:
          total === 0 ? 0 : Math.min(1, entry.knowledgeXp / total),
      };
    })
    .sort((a, b) => b.level - a.level || a.slug.localeCompare(b.slug))
    .slice(0, POP_CARD_SKILL_COUNT);

  // ---- Body: per-part status + raw readouts --------------------------
  const injuries = readInjuries(world, comps, eid) ?? [];
  const scars = readScars(world, comps, eid) ?? [];
  const impairments = injuryImpairmentOf(world, comps, eid);
  const bodyParts: PopCardBodyPart[] = BODY_PART_SLUGS.map((part) => {
    const openSeverity = injuries
      .filter((injury) => injury.part === part)
      .reduce((sum, injury) => sum + injury.severity, 0);
    const scarred = scars.some((scar) => scar.part === part);
    return {
      part,
      status: openSeverity > 0 ? "injured" : scarred ? "scarred" : "healthy",
      severity: openSeverity,
    };
  });

  // ---- Combat hp ------------------------------------------------------
  const combatRow = getCombatRow(world, comps, eid);
  let hp: PopCardData["hp"];
  if (combatRow !== undefined) {
    const def = combatDefOf(world, comps, eid);
    if (def !== undefined) {
      hp = { current: combatRow[2]!, max: def.hp };
    }
  }

  // ---- Morale ---------------------------------------------------------
  const needs = readNeeds(world, comps, eid);
  let morale: PopCardMorale | undefined;
  if (needs !== undefined) {
    const hasMoraleRow =
      typeof comps.moraleId === "number" &&
      world.rowsByComponentId.get(comps.moraleId)?.has(eid) === true;
    morale = {
      value: needs.morale,
      breakPoint: hasMoraleRow
        ? moraleBreakPointOf(world, comps, eid)
        : undefined,
      routing: hasMoraleRow && isRoutingOf(world, comps, eid),
    };
  }

  // ---- Current activity ----------------------------------------------
  const routing = morale?.routing ?? false;
  const activity = routing
    ? "Fleeing!"
    : activityLabelOf(peekActivity(readActivityQueue(world, comps, eid)));

  return {
    eid,
    name,
    ageDays,
    lifestage,
    originLabel: identity.origin === POP_ORIGIN_BIRTH ? "born here" : "arrival",
    traits,
    skills,
    hp,
    bodyParts,
    injuries,
    scars,
    impairments,
    morale,
    activity,
  };
}
