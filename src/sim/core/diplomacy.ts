/**
 * Diplomacy & Stance Matrix — SPEC §2.8 / Issue #86 / Milestone S1 (#111).
 *
 * Provides pairwise diplomatic stance tracking between players in multi-player
 * skirmish simulations (FFA, 2v2 Teams, or asymmetric custom alignments).
 *
 * Stances:
 *   - ALLY (0): Units never auto-acquire or fire upon allies; shared vision / passage.
 *   - NEUTRAL (1): Non-hostile; units do not auto-attack, but don't share vision.
 *   - ENEMY (2): Hostile; units auto-acquire, towers fire, aggro scans trigger.
 *
 * Invariant: Self is always ALLY with self (a === b => ALLY).
 */

export const DIPLOMACY_STANCE_ALLY = 0;
export const DIPLOMACY_STANCE_NEUTRAL = 1;
export const DIPLOMACY_STANCE_ENEMY = 2;

export type DiplomacyStance = 0 | 1 | 2;

export type DiplomacyMode = "ffa" | "teams" | "custom";

export interface DiplomacyMatrix {
  readonly playerCount: number;
  readonly mode: DiplomacyMode;
  getStance(playerA: number, playerB: number): DiplomacyStance;
  setStance(playerA: number, playerB: number, stance: DiplomacyStance): void;
  isAllied(playerA: number, playerB: number): boolean;
  isHostile(playerA: number, playerB: number): boolean;
  isNeutral(playerA: number, playerB: number): boolean;
  getAllies(player: number): readonly number[];
  getEnemies(player: number): readonly number[];
}

export function createDiplomacyMatrix(
  playerCount = 4,
  mode: DiplomacyMode = "ffa",
): DiplomacyMatrix {
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    throw new Error(
      `playerCount must be an integer >= 1, got ${String(playerCount)}`,
    );
  }

  const size = playerCount * playerCount;
  const stances = new Uint8Array(size);

  for (let a = 0; a < playerCount; a++) {
    for (let b = 0; b < playerCount; b++) {
      const idx = a * playerCount + b;
      if (a === b) {
        stances[idx] = DIPLOMACY_STANCE_ALLY;
      } else if (mode === "teams") {
        // Team 0: Players 0 & 1; Team 1: Players 2 & 3 (Math.floor(p / 2))
        stances[idx] =
          Math.floor(a / 2) === Math.floor(b / 2)
            ? DIPLOMACY_STANCE_ALLY
            : DIPLOMACY_STANCE_ENEMY;
      } else {
        stances[idx] = DIPLOMACY_STANCE_ENEMY; // FFA default
      }
    }
  }

  const inBounds = (p: number): boolean => p >= 0 && p < playerCount;

  return {
    playerCount,
    mode,
    getStance: (a, b): DiplomacyStance => {
      if (a === b) return DIPLOMACY_STANCE_ALLY;
      if (!inBounds(a) || !inBounds(b)) return DIPLOMACY_STANCE_ENEMY;
      return stances[a * playerCount + b] as DiplomacyStance;
    },
    setStance: (a, b, stance): void => {
      if (a === b) return; // Self is always ALLY
      if (!inBounds(a) || !inBounds(b)) return;
      stances[a * playerCount + b] = stance;
    },
    isAllied: (a, b): boolean => {
      if (a === b) return true;
      if (!inBounds(a) || !inBounds(b)) return false;
      return stances[a * playerCount + b] === DIPLOMACY_STANCE_ALLY;
    },
    isHostile: (a, b): boolean => {
      if (a === b) return false;
      if (!inBounds(a) || !inBounds(b)) return true;
      return stances[a * playerCount + b] === DIPLOMACY_STANCE_ENEMY;
    },
    isNeutral: (a, b): boolean => {
      if (a === b) return false;
      if (!inBounds(a) || !inBounds(b)) return false;
      return stances[a * playerCount + b] === DIPLOMACY_STANCE_NEUTRAL;
    },
    getAllies: (player): readonly number[] => {
      const allies: number[] = [];
      for (let other = 0; other < playerCount; other++) {
        if (
          other === player ||
          (inBounds(player) &&
            stances[player * playerCount + other] === DIPLOMACY_STANCE_ALLY)
        ) {
          allies.push(other);
        }
      }
      return allies;
    },
    getEnemies: (player): readonly number[] => {
      const enemies: number[] = [];
      if (!inBounds(player)) return enemies;
      for (let other = 0; other < playerCount; other++) {
        if (
          other !== player &&
          stances[player * playerCount + other] === DIPLOMACY_STANCE_ENEMY
        ) {
          enemies.push(other);
        }
      }
      return enemies;
    },
  };
}
