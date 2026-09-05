/**
 * Player colour palette and sprite tint definitions.
 *
 * M4-T89 (Part of #88: Visual Parity Sprint).
 *
 * AoE2-style player colour ramp:
 * - Player 1 (Human, slot 0): Vibrant Blue
 * - Player 2 (AI, slot 1): Crimson Red
 * - Player 3 (Slot 2): Forest Green
 * - Player 4 (Slot 3): Gold / Yellow
 * - Player 5 (Slot 4): Cyan / Teal
 * - Player 6 (Slot 5): Purple / Magenta
 * - Player 7 (Slot 6): Orange
 * - Player 8 (Slot 7): Silver / Grey
 *
 * Tints are applied in the vertex/fragment shader via the instanced
 * `aTeamTint` buffer attribute with zero extra draw calls.
 */

export interface PlayerColorDef {
  readonly id: number;
  readonly name: string;
  /** RGB tint multipliers passed directly to the sprite fragment shader. */
  readonly tint: readonly [number, number, number];
  /** Hex string for UI badges, minimap dots, and selection panels. */
  readonly hex: string;
}

export const PLAYER_COLORS: readonly PlayerColorDef[] = [
  { id: 0, name: "Blue", tint: [0.7, 0.95, 1.45], hex: "#3b82f6" },
  { id: 1, name: "Red", tint: [1.45, 0.65, 0.65], hex: "#ef4444" },
  { id: 2, name: "Green", tint: [0.65, 1.4, 0.7], hex: "#22c55e" },
  { id: 3, name: "Yellow", tint: [1.4, 1.35, 0.55], hex: "#eab308" },
  { id: 4, name: "Cyan", tint: [0.65, 1.35, 1.4], hex: "#06b6d4" },
  { id: 5, name: "Magenta", tint: [1.35, 0.65, 1.35], hex: "#d946ef" },
  { id: 6, name: "Orange", tint: [1.45, 0.95, 0.55], hex: "#f97316" },
  { id: 7, name: "Grey", tint: [1.1, 1.1, 1.1], hex: "#94a3b8" },
];

export function playerColorOf(playerId: number): PlayerColorDef {
  return PLAYER_COLORS[playerId] ?? PLAYER_COLORS[0]!;
}

export function playerTintOf(playerId: number): readonly [number, number, number] {
  const p = PLAYER_COLORS[playerId];
  return p ? p.tint : PLAYER_COLORS[0]!.tint;
}
