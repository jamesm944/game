/**
 * Fog-of-war visibility seam — SPEC §2.9 / M1-T11.
 *
 * M1 ships ONLY the interface plus the all-visible stub: every tile is
 * explored and visible to every player, so gameplay rules that consult
 * fog (building placement requires `explored`, §2.9) are trivially
 * satisfied while still flowing through the seam. The real plane set
 * (`explored[]` / `visible[]` / contributor counts, dirty-entity
 * stamps, memory ghosts, KnowledgeView) lands in M2 behind THIS
 * interface — consumers never change, only the implementation handed
 * to world creation does.
 *
 * Coordinates are integer tile coordinates (SPEC §2.1 grid); tiles off
 * the [0,size) grid answer false for both queries even in the stub,
 * because "everything visible" must not license off-map placement.
 *
 * Purity: like everything under sim/, implementations may not read the
 * clock or Math.random — fog state is deterministic simulation state.
 */

/** Why an entity was flagged for the next dirty flush (SPEC §2.9). */
export type FogDirtyReason = "spawned" | "moved" | "removed";

/**
 * The one visibility seam (§2.9 planes + §2.8 KnowledgeView share this
 * surface in M2). Consumers ask questions; producers are notified of
 * entity changes through the markDirty hooks and drain them with
 * flushDirty() after movement, before the tick-boundary commit.
 */
export interface VisibilityProvider {
  /** Stable label for telemetry/diagnostics (e.g. "all-visible"). */
  readonly id: string;
  /** True when `player` currently sees tile (tileX, tileY). */
  isVisible(tileX: number, tileY: number, player: number): boolean;
  /** True when `player` has ever seen tile (tileX, tileY). */
  isExplored(tileX: number, tileY: number, player: number): boolean;
  /** Queue a spawned/moved/removed entity for the next flush. */
  markDirty(reason: FogDirtyReason, eid: number): void;
  /**
   * Apply all queued dirty stamps/un-stamps. Called by the sim once per
   * tick after movement; implementations MUST tolerate being called
   * with nothing queued.
   */
  flushDirty(): void;
}

/**
 * The M1 stub: every on-grid tile explored + visible for every player;
 * dirty hooks accept anything and discard it. Stateless, so one shared
 * instance per world size is safe across runs and fixtures.
 */
export function createAllVisibleProvider(size: number): VisibilityProvider {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `fog grid size must be a positive integer, got ${String(size)}`,
    );
  }
  const onGrid = (tileX: number, tileY: number): boolean =>
    Number.isInteger(tileX) &&
    Number.isInteger(tileY) &&
    tileX >= 0 &&
    tileY >= 0 &&
    tileX < size &&
    tileY < size;
  return {
    id: "all-visible",
    isVisible: (tileX, tileY) => onGrid(tileX, tileY),
    isExplored: (tileX, tileY) => onGrid(tileX, tileY),
    markDirty: () => {},
    flushDirty: () => {},
  };
}
