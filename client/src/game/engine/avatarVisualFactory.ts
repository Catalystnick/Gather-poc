import type Phaser from "phaser";
import { IDLE_FRAMES, TILE_PX } from "./constants";

/** Parse avatar shirt hex color into Phaser tint value. */
export function shirtTint(hex: string | undefined): number {
  if (!hex) return 0xffffff;
  const hexMatch = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!hexMatch) return 0xffffff;
  return parseInt(hexMatch[1], 16);
}

/** Create the nameplate text shown above each player. */
export function makeNameLabel(
  scene: Phaser.Scene,
  name: string,
): Phaser.GameObjects.Text {
  return scene.add
    .text(0, -TILE_PX * 1.25, name, {
      fontFamily: "Verdana, Arial, sans-serif",
      fontSize: "8px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 1,
    })
    .setOrigin(0.5, 1)
    .setResolution(3);
}

/** Create muted icon text shown above player labels when muted. */
export function makeMuteIcon(scene: Phaser.Scene): Phaser.GameObjects.Text {
  return scene.add
    .text(0, -TILE_PX * 1.45, "🎤✕", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#ff6b6b",
      stroke: "#000000",
      strokeThickness: 4,
    })
    .setOrigin(0.5, 1)
    .setScale(0.5)
    .setResolution(2)
    .setVisible(false);
}

/** Build local avatar image layers (base/shoes/shirt) with consistent sizing. */
export function makeAvatarLayers(scene: Phaser.Scene, shirtHex: string) {
  const base = scene.add.image(
    0,
    -TILE_PX / 2,
    "p-template",
    IDLE_FRAMES.down[0],
  );
  const shoes = scene.add.image(
    0,
    -TILE_PX / 2,
    "p-shoes",
    IDLE_FRAMES.down[0],
  );
  const shirt = scene.add.image(
    0,
    -TILE_PX / 2,
    "p-shirt",
    IDLE_FRAMES.down[0],
  );

  base.setDisplaySize(TILE_PX * 3, TILE_PX * 3);
  shoes.setDisplaySize(TILE_PX * 3, TILE_PX * 3);
  shirt.setDisplaySize(TILE_PX * 3, TILE_PX * 3);
  shirt.setTint(shirtTint(shirtHex));

  return { base, shoes, shirt };
}

export function setAvatarFrame(
  base: Phaser.GameObjects.Image,
  shoes: Phaser.GameObjects.Image,
  shirt: Phaser.GameObjects.Image,
  frame: number,
) {
  base.setFrame(frame);
  shoes.setFrame(frame);
  shirt.setFrame(shirtFrameFor(frame));
}

/**
 * Shirt spritesheet row layout differs from template/shoes.
 * Template rows are grouped by motion (idle rows 0-3, walk rows 4-7),
 * while shirt rows are grouped by direction (down/up/right/left), each
 * direction containing [idle, walk, hurt]. Map template frame -> shirt frame.
 */
export function shirtFrameFor(templateFrame: number): number {
  const cols = 8;
  const templateRow = Math.floor(templateFrame / cols);
  const column = templateFrame % cols;
  const directionIndex = templateRow % 4; // 0=down, 1=up, 2=right, 3=left
  const animationType = templateRow < 4 ? 0 : 1; // 0=idle, 1=walk
  const shirtRow = directionIndex * 3 + animationType; // [idle, walk, hurt] per direction
  return shirtRow * cols + column;
}
