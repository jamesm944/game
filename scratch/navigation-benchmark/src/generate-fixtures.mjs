import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SIZE = 64;

function makeMap(id, description) {
  const cells = new Array(SIZE * SIZE).fill(1);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) cells[y * SIZE + x] = 0;
    }
  }
  return {
    id,
    description,
    width: SIZE,
    height: SIZE,
    coordinateSystem: 'row-major x/y tile indices; world query points are tile centers (x+0.5,y+0.5); Recast uses (x,height,z=y)',
    walkable: cells,
    vertexHeights: new Array((SIZE + 1) * (SIZE + 1)).fill(0),
    requests: [],
    mutations: [],
  };
}
function block(map, x, y, w = 1, h = 1) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) map.walkable[yy * SIZE + xx] = 0;
}
function open(map, x, y, w = 1, h = 1) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) map.walkable[yy * SIZE + xx] = 1;
}
function request(map, id, sx, sy, gx, gy, expectedReachable = true) {
  if (!map.walkable[sy * SIZE + sx] || !map.walkable[gy * SIZE + gx]) throw new Error(`${map.id}/${id}: endpoint not walkable`);
  map.requests.push({ id, start: [sx, sy], goal: [gx, gy], expectedReachable });
}
function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function shuffle(values, random) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

const maps = [];
const openMap = makeMap('open', 'Open floor with a two-tile blocked perimeter.');
request(openMap, 'diagonal', 4, 4, 58, 54);
request(openMap, 'horizontal', 4, 32, 58, 32);
request(openMap, 'reverse', 58, 54, 4, 4);
request(openMap, 'short', 20, 20, 27, 24);
maps.push(openMap);

const maze = makeMap('maze', 'Perfect maze on a 12x12 logical grid; five-tile cells and three-tile corridors, seeded recursive backtracker.');
block(maze, 2, 2, 60, 60);
const random = xorshift32(0x162a57a1);
const logicalSize = 12;
const visited = new Set(['0,0']);
const stack = [[0, 0]];
open(maze, 3, 3, 3, 3);
while (stack.length) {
  const [cx, cy] = stack[stack.length - 1];
  const candidates = shuffle([[1,0],[-1,0],[0,1],[0,-1]], random).filter(([dx,dy]) => {
    const nx = cx + dx, ny = cy + dy;
    return nx >= 0 && ny >= 0 && nx < logicalSize && ny < logicalSize && !visited.has(`${nx},${ny}`);
  });
  if (!candidates.length) { stack.pop(); continue; }
  const [dx, dy] = candidates[0];
  const nx = cx + dx, ny = cy + dy;
  open(maze, 3 + nx * 5, 3 + ny * 5, 3, 3);
  if (dx) open(maze, 3 + (dx > 0 ? cx * 5 + 3 : nx * 5 + 3), 3 + cy * 5, 2, 3);
  else open(maze, 3 + cx * 5, 3 + (dy > 0 ? cy * 5 + 3 : ny * 5 + 3), 3, 2);
  visited.add(`${nx},${ny}`);
  stack.push([nx, ny]);
}
request(maze, 'opposite', 4, 4, 59, 59);
request(maze, 'cross', 59, 4, 4, 59);
request(maze, 'middle', 4, 29, 59, 34);
request(maze, 'reverse', 59, 59, 4, 4);
maps.push(maze);

const choke = makeMap('dense-chokepoints', 'Three full-height partitions with five-tile staggered gates plus dense rectangular obstacles away from the gates.');
for (const [x, gateY] of [[17,10],[32,45],[47,25]]) {
  block(choke, x, 2, 2, 60);
  open(choke, x, gateY, 2, 5);
}
for (const [x,y,w,h] of [[7,22,5,12],[22,8,5,17],[22,34,5,8],[37,20,5,17],[52,7,5,17],[52,39,5,13]]) block(choke,x,y,w,h);
request(choke, 'all-gates', 5, 7, 58, 56);
request(choke, 'reverse-gates', 58, 56, 5, 7);
request(choke, 'middle-gate', 5, 48, 58, 30);
request(choke, 'local-obstacles', 20, 55, 44, 55);
maps.push(choke);

const ramp = makeMap('ramps-elevation', 'Flat approaches, a 0.15 height/tile ramp from x=12..40, and a 4.2-high plateau. Only Recast consumes heights.');
for (let y = 0; y <= SIZE; y++) {
  for (let x = 0; x <= SIZE; x++) {
    const height = x <= 12 ? 0 : x >= 40 ? 4.2 : (x - 12) * 0.15;
    ramp.vertexHeights[y * (SIZE + 1) + x] = height;
  }
}
request(ramp, 'up-ramp', 5, 20, 58, 20);
request(ramp, 'down-ramp', 58, 40, 5, 40);
request(ramp, 'diagonal-ramp', 5, 5, 58, 55);
request(ramp, 'plateau-local', 43, 10, 58, 50);
maps.push(ramp);

const unreachable = makeMap('unreachable', 'Walkable target islands sealed by blocked tiles; expected exact-goal failure.');
block(unreachable, 25, 20, 16, 2);
block(unreachable, 25, 36, 16, 2);
block(unreachable, 25, 22, 2, 14);
block(unreachable, 39, 22, 2, 14);
block(unreachable, 5, 42, 12, 2);
block(unreachable, 5, 54, 12, 2);
block(unreachable, 5, 44, 2, 10);
block(unreachable, 15, 44, 2, 10);
request(unreachable, 'sealed-center', 5, 5, 33, 29, false);
request(unreachable, 'sealed-small', 50, 50, 10, 49, false);
request(unreachable, 'outside-control', 5, 5, 58, 58, true);
maps.push(unreachable);

const dynamic = makeMap('dynamic-mutation', 'Open map split by a wall with an eight-tile gate; the mutation fills the gate and disconnects the sides.');
block(dynamic, 30, 2, 2, 60);
open(dynamic, 30, 28, 2, 8);
request(dynamic, 'through-gate', 8, 32, 56, 32, true);
request(dynamic, 'diagonal-gate', 8, 20, 56, 44, true);
dynamic.mutations.push({ id: 'seal-gate', operation: 'add-box-or-block-cells', rect: { x: 28, y: 27, width: 6, height: 12 }, expectedReachableAfter: false });
maps.push(dynamic);

const fixtureSet = {
  schema: 'wayfinder-navigation-fixtures-v1',
  tileSize: 1,
  maps,
  movementScenario: {
    status: 'unmeasured',
    reason: 'No fair shared movement/collision simulation is defined by these path-request fixtures.'
  }
};
const output = join(here, '..', 'fixtures', 'fixtures.json');
writeFileSync(output, JSON.stringify(fixtureSet, null, 2) + '\n');
console.log(`Wrote ${output}: ${maps.length} maps, ${maps.reduce((n,m) => n + m.requests.length, 0)} requests`);
