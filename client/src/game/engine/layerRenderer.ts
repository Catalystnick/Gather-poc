import Phaser from "phaser";
import type { LdtkEntityInstance, LdtkLayerInstance } from "../../types/mapTypes";
import { TILE_PX } from "./constants";

/** Renders tiled layers/entity tile regions with cached source-to-frame lookup. */
export class LayerRenderer {
  private scene: Phaser.Scene;
  private tilesetColumnsByTexture = new Map<string, number>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Read texture source width used for strip-based frame slicing. */
  getTextureWidth(textureKey: string) {
    const texture = this.scene.textures.get(textureKey);
    const sourceImage = texture.getSourceImage() as { width?: number };
    return sourceImage?.width ?? 0;
  }

  /** Draw an LDtk entity tile region into an existing render texture. */
  redrawEntityRenderTexture(
    renderTexture: Phaser.GameObjects.RenderTexture,
    textureKey: string,
    tileRect: NonNullable<LdtkEntityInstance["__tile"]>,
    scale: number,
    srcOffsetX = 0,
  ) {
    renderTexture.clear();
    renderTexture.beginDraw();
    for (let offsetY = 0; offsetY < tileRect.h; offsetY += TILE_PX) {
      for (let offsetX = 0; offsetX < tileRect.w; offsetX += TILE_PX) {
        const frame = this.frameFromSrc(
          textureKey,
          tileRect.x + srcOffsetX + offsetX,
          tileRect.y + offsetY,
        );
        const image = this.scene.make.image({
          x: offsetX * scale,
          y: offsetY * scale,
          key: textureKey,
          frame,
          add: false,
        });
        image.setOrigin(0, 0);
        image.setScale(scale, scale);
        renderTexture.batchDraw(image);
        image.destroy();
      }
    }
    renderTexture.endDraw();
  }

  /** Render a flat layer into one render texture (fast path without per-tile depth). */
  bakeLayer(layer: LdtkLayerInstance, textureKey: string, worldWidth: number, worldHeight: number) {
    const renderTexture = this.scene.add.renderTexture(0, 0, worldWidth, worldHeight);
    renderTexture.setOrigin(0, 0).setDepth(0);

    renderTexture.beginDraw();
    for (const tile of layer.gridTiles) {
      const frame = this.frameFromSrc(textureKey, tile.src[0], tile.src[1]);
      const image = this.scene.make.image({
        x: tile.px[0],
        y: tile.px[1],
        key: textureKey,
        frame,
        add: false,
      });
      image.setOrigin(0, 0);
      image.setFlipX(!!(tile.f & 1));
      image.setFlipY(!!(tile.f & 2));
      renderTexture.batchDraw(image);
      image.destroy();
    }
    renderTexture.endDraw();
  }

  /**
   * Render Y-sorted tiles by contiguous vertical segments per column so depth
   * is derived from each local object bottom.
   */
  buildYSortLayer(layer: LdtkLayerInstance, textureKey: string) {
    if (layer.gridTiles.length === 0) return;

    const tilesByColumn = new Map<number, typeof layer.gridTiles>();
    for (const tile of layer.gridTiles) {
      const columnTiles = tilesByColumn.get(tile.px[0]);
      if (columnTiles) columnTiles.push(tile);
      else tilesByColumn.set(tile.px[0], [tile]);
    }

    for (const [columnX, tiles] of tilesByColumn) {
      tiles.sort((leftTile, rightTile) => leftTile.px[1] - rightTile.px[1]);

      let segmentStartIndex = 0;
      while (segmentStartIndex < tiles.length) {
        let segmentEndIndex = segmentStartIndex;
        while (
          segmentEndIndex + 1 < tiles.length &&
          tiles[segmentEndIndex + 1].px[1] - tiles[segmentEndIndex].px[1] === TILE_PX
        ) {
          segmentEndIndex++;
        }

        const segmentMinY = tiles[segmentStartIndex].px[1];
        const segmentMaxY = tiles[segmentEndIndex].px[1];
        const renderTextureHeight = segmentMaxY - segmentMinY + TILE_PX;

        const renderTexture = this.scene.add.renderTexture(
          columnX,
          segmentMinY,
          TILE_PX,
          renderTextureHeight,
        );
        renderTexture.setOrigin(0, 0);
        renderTexture.setDepth(segmentMaxY + TILE_PX);

        renderTexture.beginDraw();
        for (
          let tileIndex = segmentStartIndex;
          tileIndex <= segmentEndIndex;
          tileIndex++
        ) {
          const tile = tiles[tileIndex];
          const frame = this.frameFromSrc(textureKey, tile.src[0], tile.src[1]);
          const image = this.scene.make.image({
            x: 0,
            y: tile.px[1] - segmentMinY,
            key: textureKey,
            frame,
            add: false,
          });
          image.setOrigin(0, 0);
          image.setFlipX(!!(tile.f & 1));
          image.setFlipY(!!(tile.f & 2));
          renderTexture.batchDraw(image);
          image.destroy();
        }
        renderTexture.endDraw();

        segmentStartIndex = segmentEndIndex + 1;
      }
    }
  }

  /** Resolve tileset source coordinates to a spritesheet frame index. */
  private frameFromSrc(textureKey: string, sourceX: number, sourceY: number): number {
    let columnCount = this.tilesetColumnsByTexture.get(textureKey);
    if (!columnCount) {
      const texture = this.scene.textures.get(textureKey);
      const sourceImage = texture.getSourceImage() as { width?: number };
      const textureWidth = sourceImage?.width ?? TILE_PX;
      columnCount = Math.floor(textureWidth / TILE_PX);
      this.tilesetColumnsByTexture.set(textureKey, columnCount);
    }
    return Math.floor(sourceY / TILE_PX) * columnCount + Math.floor(sourceX / TILE_PX);
  }
}
