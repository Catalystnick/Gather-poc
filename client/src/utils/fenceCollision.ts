// Axis-aligned collision resolver built from WORLD_FENCES.
//
// Each fence entry sits on a tile edge. We derive blocking line segments:
//   offsetZ === 0 | 1  →  horizontal wall at z = OZ + row + offsetZ
//   offsetX === 0 | 1  →  vertical wall   at x = OX + col + offsetX
//
// Entrance gaps (tiles with no fence) produce no segments, so the player
// can cross freely in those columns/rows.
//
// resolveCollision() is called once per frame in LocalPlayer — zero allocs.

import { COLS, ROWS } from "../components/scene/FloorMap";
import { WORLD_FENCES } from "../data/worldMap";

const TILE_SIZE = 1;
const OX = -(COLS * TILE_SIZE) / 2;
const OZ = -(ROWS * TILE_SIZE) / 2;

// How far the player centre stops from a wall surface.
// South/east approach (player walks toward the fence from the open side).
export const PLAYER_RADIUS = 0.3;
// North/west approach (player walks down into the fence from behind).
const R_NORTH = 0.8;

type HWall = { axis: "z"; coord: number; xMin: number; xMax: number };
type VWall = { axis: "x"; coord: number; zMin: number; zMax: number };
type Wall = HWall | VWall;

function buildWalls(): Wall[] {
  const walls: Wall[] = [];
  for (const f of WORLD_FENCES) {
    const wx = OX + f.col;
    const wz = OZ + f.row;
    // top/bottom edge → horizontal wall
    if (f.offsetZ === 0 || f.offsetZ === 1) {
      walls.push({ axis: "z", coord: wz + f.offsetZ, xMin: wx, xMax: wx + 1 });
    }
    // left/right edge → vertical wall
    if (f.offsetX === 0 || f.offsetX === 1) {
      walls.push({ axis: "x", coord: wx + f.offsetX, zMin: wz, zMax: wz + 1 });
    }
  }
  return walls;
}

// Computed once at module load — never changes at runtime.
const WALLS = buildWalls();

/**
 * Given the player's old position (ox, oz) and their intended new position
 * (nx, nz), returns a clamped [nx, nz] that respects all fence walls.
 *
 * No allocations — suitable for use inside useFrame.
 */
export function resolveCollision(ox: number, oz: number, nx: number, nz: number): [number, number] {
  const R = PLAYER_RADIUS;

  for (const w of WALLS) {
    if (w.axis === "z") {
      // Skip wall if player x is outside the segment's x range (+ radius slop).
      if (nx < w.xMin - R || nx > w.xMax + R) continue;
      // Push back using the appropriate radius for the side the player came from.
      if (oz >= w.coord && nz < w.coord + R)
        nz = w.coord + R; // from south
      else if (oz < w.coord && nz > w.coord - R_NORTH) nz = w.coord - R_NORTH; // from north
    } else {
      if (nz < w.zMin - R || nz > w.zMax + R) continue;
      if (ox >= w.coord && nx < w.coord + R)
        nx = w.coord + R; // from east
      else if (ox < w.coord && nx > w.coord - R_NORTH) nx = w.coord - R_NORTH; // from west
    }
  }

  return [nx, nz];
}
