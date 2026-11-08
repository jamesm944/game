import { hasLineOfSight } from "../../../src/sim/path/astar";

export interface CorridorPoint {
  readonly x: number;
  readonly z: number;
}

const BOUNDARY_EPSILON = 1e-9;

/**
 * Convert actual continuous Detour straight-path segments to the existing
 * integer waypoint protocol without flooring isolated portal points.
 *
 * Every crossed tile is visited with a parametric voxel walk. Simultaneous
 * axis crossings require both orthogonal tiles and the diagonal destination,
 * matching production no-corner-cutting LOS. A final greedy string pull only
 * removes waypoints when production hasLineOfSight accepts the whole segment.
 * No grid search or A* fallback is involved.
 */
export function convertCorridorToGrid(
  points: readonly CorridorPoint[],
  passable: Uint8Array,
  width: number,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
): Int16Array | null {
  if (points.length === 0) return null;
  const raw: number[] = [startX, startY];

  const isOpen = (x: number, y: number): boolean => (
    x >= 0 && y >= 0 && x < width && y < width && passable[y * width + x] === 1
  );
  const append = (x: number, y: number): boolean => {
    if (!isOpen(x, y)) return false;
    const previousX = raw[raw.length - 2]!;
    const previousY = raw[raw.length - 1]!;
    if (previousX === x && previousY === y) return true;
    if (!hasLineOfSight(passable, width, previousX, previousY, x, y)) return false;
    raw.push(x, y);
    return true;
  };

  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (![from.x, from.z, to.x, to.z].every(Number.isFinite)) return null;
    const ax = from.x;
    const ay = from.z;
    const bx = to.x;
    const by = to.z;
    const dx = bx - ax;
    const dy = by - ay;
    if (Math.abs(dx) + Math.abs(dy) <= BOUNDARY_EPSILON) continue;

    let x = Math.floor(ax);
    let y = Math.floor(ay);
    if (!append(x, y)) return null;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const deltaX = stepX === 0 ? Infinity : 1 / Math.abs(dx);
    const deltaY = stepY === 0 ? Infinity : 1 / Math.abs(dy);
    let maxX = stepX > 0
      ? (x + 1 - ax) / dx
      : stepX < 0 ? (ax - x) / -dx : Infinity;
    let maxY = stepY > 0
      ? (y + 1 - ay) / dy
      : stepY < 0 ? (ay - y) / -dy : Infinity;

    for (;;) {
      const next = Math.min(maxX, maxY);
      // An intermediate segment ends on its portal. Do not enter the tile
      // beyond that portal until the next actual corridor segment does so.
      if (!Number.isFinite(next) || next >= 1 - BOUNDARY_EPSILON) break;
      const crossX = Math.abs(maxX - next) <= BOUNDARY_EPSILON;
      const crossY = Math.abs(maxY - next) <= BOUNDARY_EPSILON;
      if (crossX && crossY) {
        if (!isOpen(x + stepX, y) || !isOpen(x, y + stepY)) return null;
        x += stepX;
        y += stepY;
        maxX += deltaX;
        maxY += deltaY;
      } else if (crossX) {
        x += stepX;
        maxX += deltaX;
      } else {
        y += stepY;
        maxY += deltaY;
      }
      if (!append(x, y)) return null;
    }
  }

  if (!append(goalX, goalY)) return null;
  const pulled: number[] = [raw[0]!, raw[1]!];
  let anchor = 0;
  const count = raw.length / 2;
  while (anchor < count - 1) {
    let next = anchor + 1;
    for (let probe = count - 1; probe > next; probe -= 1) {
      if (hasLineOfSight(
        passable,
        width,
        raw[anchor * 2]!,
        raw[anchor * 2 + 1]!,
        raw[probe * 2]!,
        raw[probe * 2 + 1]!,
      )) {
        next = probe;
        break;
      }
    }
    pulled.push(raw[next * 2]!, raw[next * 2 + 1]!);
    anchor = next;
  }
  return Int16Array.from(pulled);
}
