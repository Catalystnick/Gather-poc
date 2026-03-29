import type { Direction } from "../../types";

export const TILE_PX = 16;
export const TWEEN_DUR = 0.15;
export const HOLD_DELAY = 0.1;
export const STEP_INT = 0.13;
export const CAMERA_LERP = 0.12;
export const CAMERA_RESET_LERP = 0.5;
export const CAMERA_RESET_BLEND_MS = 380;
export const CAMERA_ZOOM = 2;
export const IDLE_FPS = 2;
export const WALK_FPS = 12;

export const IDLE_FRAMES: Record<Direction, number[]> = {
  down: [0, 1],
  up: [8, 9],
  right: [16, 17],
  left: [24, 25],
};

export const WALK_FRAMES: Record<Direction, number[]> = {
  down: [32, 33, 34, 35, 36, 37, 38, 39],
  up: [40, 41, 42, 43, 44, 45, 46, 47],
  right: [48, 49, 50, 51, 52, 53, 54, 55],
  left: [56, 57, 58, 59, 60, 61, 62, 63],
};

/** Pixel center of a tile (Phaser uses top-left origin for world coords). */
export function tileCenter(col: number, row: number) {
  return { x: col * TILE_PX + TILE_PX / 2, y: row * TILE_PX + TILE_PX / 2 };
}
