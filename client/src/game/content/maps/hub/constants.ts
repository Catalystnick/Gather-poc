import { TILE_PX } from "../../../engine/constants";

export const GRAVE_READ_RANGE_PX = TILE_PX * 3.5;
export const GRAVE_DISCOVER_RANGE_PX = TILE_PX * 6;
export const NPC_TALK_RANGE_PX = TILE_PX * 3;
export const NPC_DISCOVER_RANGE_PX = TILE_PX * 6;
export const STATUE_READ_RANGE_PX = TILE_PX * 4;
export const STATUE_DISCOVER_RANGE_PX = TILE_PX * 7;

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
