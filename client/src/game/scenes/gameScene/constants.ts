import type { Direction } from "../../../types";

export const TILE_PX = 16; // pixels per tile
export const TWEEN_DUR = 0.15; // seconds per tile tween
export const HOLD_DELAY = 0.1; // seconds before auto-walk starts
export const STEP_INT = 0.13; // seconds between auto-walk steps
export const CAMERA_LERP = 0.12;
export const CAMERA_RESET_LERP = 0.5;
export const CAMERA_RESET_BLEND_MS = 380;
export const CAMERA_ZOOM = 2;
export const IDLE_FPS = 2;
export const WALK_FPS = 12;
export const GRAVE_READ_RANGE_PX = TILE_PX * 3.5;
export const GRAVE_DISCOVER_RANGE_PX = TILE_PX * 6;
export const NPC_TALK_RANGE_PX = TILE_PX * 3;
export const NPC_DISCOVER_RANGE_PX = TILE_PX * 6;
export const STATUE_READ_RANGE_PX = TILE_PX * 4;
export const STATUE_DISCOVER_RANGE_PX = TILE_PX * 7;

// LDtk tileset uid -> Phaser texture key
export const UID_TO_KEY: Record<number, string> = {
  13: "ts-house",
  14: "ts-graveyard",
  15: "ts-boxes",
  16: "ts-tents",
  17: "ts-fences",
  18: "ts-plant",
  19: "ts-grass",
  50: "ts-dev-trader",
  51: "ts-design-trader",
  53: "ts-game-trader",
};

// Layers baked into a single RenderTexture (flat ground, no Y-sort needed)
export const BAKED = new Set(["Grass_tiles"]);
// Layers rendered as individual sprites for Y-sort
export const YSORTED = new Set([
  "Trees",
  "Bushes",
  "House_tiles",
  "Graveyard",
  "Fences",
]);

// Player sprite sheet: 8 cols x 12 rows, 64 x 64 px per frame
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
