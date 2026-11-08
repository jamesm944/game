import { RecastNavigation } from '../../donor-audit/browser/voidstrike/src/engine/pathfinding/RecastNavigation';
import { findPath } from '../../../src/sim/path/astar';
import PF from 'pathfinding';

const grid = new Uint8Array(16).fill(1);
console.log('project', findPath({ passability: grid, width: 4, startX: 0, startY: 0, goalX: 3, goalY: 3 }));
const pfGrid = new PF.Grid(4, 4);
console.log('pathfinding.js', new PF.AStarFinder({ diagonalMovement: PF.DiagonalMovement.OnlyWhenNoObstacles }).findPath(0, 0, 3, 3, pfGrid));
const positions = new Float32Array([0,0,0, 4,0,0, 4,0,4, 0,0,4]);
const indices = new Uint32Array([0,2,1, 0,3,2]);
const navigation = RecastNavigation.getInstance();
console.log('generated', await navigation.generateFromGeometry(positions, indices, 4, 4));
console.log('recast', navigation.findPath(0.5, 0.5, 3.5, 3.5));
RecastNavigation.resetInstance();
