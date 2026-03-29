import Phaser from "phaser";
import GameBridge from "../GameBridge";
import type {
  LdtkEntityInstance,
  LdtkLayerInstance,
} from "../../types/mapTypes";
import {
  makeAvatarLayers,
  makeMuteIcon,
  makeNameLabel,
  setAvatarFrame,
} from "./gameScene/avatarVisualFactory";
import {
  BAKED,
  CAMERA_LERP,
  CAMERA_ZOOM,
  TILE_PX,
  UID_TO_KEY,
  YSORTED,
  tileCenter,
} from "./gameScene/constants";
import { CameraDragController } from "./gameScene/cameraDragController";
import { getEntityTopLeft } from "./gameScene/entityPlacement";
import { GraveInteractionController } from "./gameScene/graveInteractionController";
import { LocalMovementController } from "./gameScene/localMovementController";
import { NpcInteractionController } from "./gameScene/npcInteractionController";
import { RemotePlayerController } from "./gameScene/remotePlayerController";
import { StatueInteractionController } from "./gameScene/statueInteractionController";

const TRADER_IDLE_FRAME_SECONDS = 0.24;
const TRADER_STRIP_FRAME_STEP_PX = 128;
const TRADER_SET_TRANSITION_HOLD_FRAMES = 3;

interface AnimatedTraderRender {
  iid: string;
  renderTexture: Phaser.GameObjects.RenderTexture;
  tileRect: NonNullable<LdtkEntityInstance["__tile"]>;
  scale: number;
  idleFrames: Array<{ textureKey: string; srcOffsetX: number }>;
  dialogFrames: Array<{ textureKey: string; srcOffsetX: number }>;
  frames: Array<{ textureKey: string; srcOffsetX: number }>;
  frameCursor: number;
}

export default class GameScene extends Phaser.Scene {
  // â”€â”€ Input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wKey!: Phaser.Input.Keyboard.Key;
  private sKey!: Phaser.Input.Keyboard.Key;
  private aKey!: Phaser.Input.Keyboard.Key;
  private dKey!: Phaser.Input.Keyboard.Key;
  private eKey!: Phaser.Input.Keyboard.Key;

  // â”€â”€ Local player visuals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private lContainer!: Phaser.GameObjects.Container;
  private lBase!: Phaser.GameObjects.Image;
  private lShoes!: Phaser.GameObjects.Image;
  private lShirt!: Phaser.GameObjects.Image;
  private lLabel!: Phaser.GameObjects.Text;
  private lMuteIcon!: Phaser.GameObjects.Text;

  // â”€â”€ Local player movement state (mirrors old LocalPlayer.tsx) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // â”€â”€ Remote players â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private tilesetCols = new Map<string, number>();
  private cameraDrag!: CameraDragController;
  private graveInteraction!: GraveInteractionController;
  private npcInteraction!: NpcInteractionController;
  private statueInteraction!: StatueInteractionController;
  private localMovement!: LocalMovementController;
  private remotePlayers!: RemotePlayerController;
  private animatedTraderRenders: AnimatedTraderRender[] = [];
  private traderIdleTimer = 0;

  constructor() {
    super({ key: "GameScene" });
  }

  // â”€â”€ Preload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  preload() {
    const tile = (key: string, path: string) =>
      this.load.spritesheet(key, path, {
        frameWidth: TILE_PX,
        frameHeight: TILE_PX,
      });

    // URL-encode spaces in the folder name
    const atlas = (name: string) =>
      `/sprite%20sheet%20atlases/${encodeURIComponent(name)}`;

    tile("ts-grass", atlas("TX_Tileset_Grass.png"));
    tile("ts-plant", atlas("TX_Plant.png"));
    tile("ts-house", atlas("house atlas sheet.png"));
    tile("ts-graveyard", atlas("graveyard atlas.png"));
    tile("ts-boxes", atlas("boxes atlas.png"));
    tile("ts-tents", atlas("tent atlas.png"));
    tile("ts-fences", atlas("Tileset2.png"));
    tile("ts-dev-trader", "/sprite%20sheet%20atlases/Dev%20trader/Dialogue.png");
    tile("ts-design-trader", "/sprite%20sheet%20atlases/Design%20trader/Dialogue.png");
    tile("ts-game-trader", "/sprite%20sheet%20atlases/Game%20trader/Dialogue.png");
    tile("ts-dev-trader-idle-1", "/sprite%20sheet%20atlases/Dev%20trader/Idle.png");
    tile("ts-dev-trader-idle-2", "/sprite%20sheet%20atlases/Dev%20trader/Idle_2.png");
    tile("ts-dev-trader-idle-3", "/sprite%20sheet%20atlases/Dev%20trader/Idle_3.png");
    tile("ts-design-trader-idle-1", "/sprite%20sheet%20atlases/Design%20trader/Idle.png");
    tile("ts-design-trader-idle-2", "/sprite%20sheet%20atlases/Design%20trader/Idle_2.png");
    tile("ts-design-trader-idle-3", "/sprite%20sheet%20atlases/Design%20trader/Idle_3.png");
    tile("ts-game-trader-idle-1", "/sprite%20sheet%20atlases/Game%20trader/Idle.png");
    tile("ts-game-trader-idle-2", "/sprite%20sheet%20atlases/Game%20trader/Idle_2.png");
    tile("ts-game-trader-idle-3", "/sprite%20sheet%20atlases/Game%20trader/Idle_3.png");

    const player = (key: string, path: string) =>
      this.load.spritesheet(key, path, { frameWidth: 64, frameHeight: 64 });

    player("p-template", "/avatars/template.png");
    player("p-shoes", "/avatars/shoes.png");
    player("p-shirt", "/avatars/shirt.png");

    this.load.image("lochlin", "/lochlin.jpeg");
  }

  // â”€â”€ Create â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  create() {
    if (!GameBridge.mapData) return;
    this.applyNearestTextureFilters();
    this.animatedTraderRenders = [];
    this.traderIdleTimer = 0;
    this.cameraDrag = new CameraDragController({ scene: this });
    this.localMovement = new LocalMovementController({
      getContainer: () => this.lContainer,
      setAvatarFrame: (frame) => setAvatarFrame(this.lBase, this.lShoes, this.lShirt, frame),
      resetCameraFollowToPlayer: () => this.resetCameraFollowToPlayer(),
    });
    this.remotePlayers = new RemotePlayerController({ scene: this });
    this.graveInteraction = new GraveInteractionController({
      scene: this,
      getPlayerWorldPosition: () => ({ x: this.lContainer.x, y: this.lContainer.y }),
      onPanelOpen: () => {
        this.cameraDrag.stopDragging();
      },
    });
    this.npcInteraction = new NpcInteractionController({
      scene: this,
      getPlayerWorldPosition: () => ({ x: this.lContainer.x, y: this.lContainer.y }),
      getLevelWorldOffset: () => ({
        worldX: GameBridge.mapData?.level.worldX ?? 0,
        worldY: GameBridge.mapData?.level.worldY ?? 0,
      }),
      onPanelOpen: (traderIid) => {
        this.cameraDrag.stopDragging();
        this.activateTraderDialogAnimation(traderIid);
      },
      onPanelClose: () => {
        this.resetTraderIdleAnimations();
      },
    });
    this.statueInteraction = new StatueInteractionController({
      scene: this,
      getPlayerWorldPosition: () => ({ x: this.lContainer.x, y: this.lContainer.y }),
      onPanelOpen: () => {
        this.cameraDrag.stopDragging();
      },
    });

    this.buildMap(GameBridge.mapData.level.layerInstances ?? []);
    this.buildEntities(GameBridge.mapData.level.layerInstances ?? []);
    this.spawnLocalPlayer();
    this.setupCamera();
    this.setupInput();
    this.setupMouseDragControls();
    this.graveInteraction.createUi(this.cameras.main.zoom);
    this.npcInteraction.createUi(this.cameras.main.zoom);
    this.statueInteraction.createUi(this.cameras.main.zoom);
  }

  // â”€â”€ Map building â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private buildMap(layers: LdtkLayerInstance[]) {
    // LDtk layers are stored topâ†’bottom; reverse to render bottomâ†’top
    for (const layer of [...layers].reverse()) {
      if (layer.__type !== "Tiles" || !layer.__tilesetDefUid) continue;
      const key = UID_TO_KEY[layer.__tilesetDefUid];
      if (!key) continue;

      if (BAKED.has(layer.__identifier)) {
        this.bakeLayer(layer, key);
      } else if (YSORTED.has(layer.__identifier)) {
        this.buildYSortLayer(layer, key);
      }
    }
  }

  /**
   * Render LDtk entity visuals (e.g. Statue, Gravestone) that live in the
   * Entities layer via __tile rects.
   */
  private buildEntities(layers: LdtkLayerInstance[]) {
    for (const layer of layers) {
      if (layer.__type !== "Entities") continue;
      for (const entity of layer.entityInstances) {
        this.drawEntityTile(entity);
        this.registerGravestoneNote(entity);
        this.registerTraderNote(entity);
        this.registerStatueLore(entity);
      }
    }
  }

  /** Register gravestone notes from LDtk entity fields for proximity reading. */
  private registerGravestoneNote(entity: LdtkEntityInstance) {
    this.graveInteraction.registerGravestone(entity);
  }

  /** Register trader notes from LDtk entity fields for proximity talking. */
  private registerTraderNote(entity: LdtkEntityInstance) {
    this.npcInteraction.registerTrader(entity);
  }

  /** Register statue lore text from LDtk for proximity interaction. */
  private registerStatueLore(entity: LdtkEntityInstance) {
    this.statueInteraction.registerStatue(entity);
  }

  /** Draw one LDtk entity tile into a render texture at its editor-aligned position. */
  private drawEntityTile(entity: LdtkEntityInstance) {
    const tile = entity.__tile;
    if (!tile) return;

    const key = UID_TO_KEY[tile.tilesetUid];
    if (!key) return;

    const fitScale = Math.min(entity.width / tile.w, entity.height / tile.h);
    const isNpcLike = /(trader|merchant|npc)/i.test(entity.__identifier);
    const widthFitScale = entity.width / tile.w;
    const smallEntity = fitScale < 1;
    const scale = isNpcLike ? widthFitScale : fitScale;
    const drawW = tile.w * scale;
    const drawH = tile.h * scale;
    const entityTopLeft = getEntityTopLeft(entity);
    const baseX = entityTopLeft.x + (entity.width - drawW) / 2;
    const baseY = entityTopLeft.y + (entity.height - drawH) / 2;
    const rtW = Math.ceil(drawW);
    const rtH = Math.ceil(drawH);

    const rt = this.add.renderTexture(baseX, baseY, rtW, rtH);
    rt.setOrigin(0, 0);
    const depthBoost =
      entity.__identifier === "Spade" ? TILE_PX * 3 : smallEntity ? TILE_PX : 0;
    rt.setDepth(baseY + drawH + depthBoost);

    const traderIdleTextures = this.getTraderIdleTextureKeys(entity.__identifier);
    if (traderIdleTextures) {
      const traderIdleFrames = this.buildTraderStripFrames(traderIdleTextures, tile);
      const dialogTextureKey = this.getTraderDialogTextureKey(entity.__identifier);
      const traderDialogFrames = dialogTextureKey
        ? this.buildTraderStripFrames([dialogTextureKey], tile)
        : [];
      if (traderIdleFrames.length === 0) {
        this.redrawEntityRenderTexture(rt, key, tile, scale);
        return;
      }
      this.redrawEntityRenderTexture(
        rt,
        traderIdleFrames[0].textureKey,
        tile,
        scale,
        traderIdleFrames[0].srcOffsetX,
      );
      this.animatedTraderRenders.push({
        iid: entity.iid,
        renderTexture: rt,
        tileRect: tile,
        scale,
        idleFrames: traderIdleFrames,
        dialogFrames: traderDialogFrames,
        frames: traderIdleFrames,
        frameCursor: 0,
      });
      return;
    }
    this.redrawEntityRenderTexture(rt, key, tile, scale);
  }

  /** Draw an LDtk entity tile region into an existing render texture. */
  private redrawEntityRenderTexture(
    renderTexture: Phaser.GameObjects.RenderTexture,
    textureKey: string,
    tileRect: NonNullable<LdtkEntityInstance["__tile"]>,
    scale: number,
    srcOffsetX = 0,
  ) {
    renderTexture.clear();
    renderTexture.beginDraw();
    for (let oy = 0; oy < tileRect.h; oy += TILE_PX) {
      for (let ox = 0; ox < tileRect.w; ox += TILE_PX) {
        const frame = this.frameFromSrc(
          textureKey,
          tileRect.x + srcOffsetX + ox,
          tileRect.y + oy,
        );
        const image = this.make.image({
          x: ox * scale,
          y: oy * scale,
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

  /** Build a flattened frame list from Idle/Idle_2/Idle_3 strip sheets. */
  private buildTraderStripFrames(
    textureKeys: string[],
    tileRect: NonNullable<LdtkEntityInstance["__tile"]>,
  ) {
    const frames: Array<{ textureKey: string; srcOffsetX: number }> = [];
    for (let textureIndex = 0; textureIndex < textureKeys.length; textureIndex++) {
      const textureKey = textureKeys[textureIndex];
      const texture = this.textures.get(textureKey);
      const sourceImage = texture.getSourceImage() as { width?: number };
      const sourceWidth = sourceImage?.width ?? 0;
      if (!sourceWidth) continue;

      const setFrames: Array<{ textureKey: string; srcOffsetX: number }> = [];
      let srcX = tileRect.x;
      while (srcX + tileRect.w <= sourceWidth) {
        setFrames.push({ textureKey, srcOffsetX: srcX - tileRect.x });
        srcX += TRADER_STRIP_FRAME_STEP_PX;
      }
      if (setFrames.length === 0) continue;
      frames.push(...setFrames);

      if (textureIndex < textureKeys.length - 1) {
        const holdFrame = setFrames[setFrames.length - 1];
        for (let holdIndex = 0; holdIndex < TRADER_SET_TRANSITION_HOLD_FRAMES; holdIndex++) {
          frames.push(holdFrame);
        }
      }
    }
    return frames;
  }

  /** Returns idle texture keys for trader entities, or null for non-traders. */
  private getTraderIdleTextureKeys(
    entityIdentifier: string,
  ): [string, string, string] | null {
    if (entityIdentifier === "Dev_trader") {
      return ["ts-dev-trader-idle-1", "ts-dev-trader-idle-2", "ts-dev-trader-idle-3"];
    }
    if (entityIdentifier === "Design_trader") {
      return [
        "ts-design-trader-idle-1",
        "ts-design-trader-idle-2",
        "ts-design-trader-idle-3",
      ];
    }
    if (entityIdentifier === "Game_trader") {
      return ["ts-game-trader-idle-1", "ts-game-trader-idle-2", "ts-game-trader-idle-3"];
    }
    return null;
  }

  /** Returns dialog strip texture key for trader entities. */
  private getTraderDialogTextureKey(entityIdentifier: string): string | null {
    if (entityIdentifier === "Dev_trader") return "ts-dev-trader";
    if (entityIdentifier === "Design_trader") return "ts-design-trader";
    if (entityIdentifier === "Game_trader") return "ts-game-trader";
    return null;
  }

  /** Switch one trader to dialog animation frames when interaction starts. */
  private activateTraderDialogAnimation(traderIid: string) {
    for (const trader of this.animatedTraderRenders) {
      if (trader.iid !== traderIid) continue;
      if (trader.dialogFrames.length === 0) return;
      trader.frames = trader.dialogFrames;
      trader.frameCursor = 0;
      const firstFrame = trader.frames[0];
      this.redrawEntityRenderTexture(
        trader.renderTexture,
        firstFrame.textureKey,
        trader.tileRect,
        trader.scale,
        firstFrame.srcOffsetX,
      );
      return;
    }
  }

  /** Reset all trader animations back to idle loops when interaction closes. */
  private resetTraderIdleAnimations() {
    for (const trader of this.animatedTraderRenders) {
      trader.frames = trader.idleFrames;
      trader.frameCursor = 0;
      const firstFrame = trader.frames[0];
      if (!firstFrame) continue;
      this.redrawEntityRenderTexture(
        trader.renderTexture,
        firstFrame.textureKey,
        trader.tileRect,
        trader.scale,
        firstFrame.srcOffsetX,
      );
    }
  }

  /** Steps trader idle animation by swapping source texture sheets. */
  private updateTraderIdleAnimations(dt: number) {
    if (this.animatedTraderRenders.length === 0) return;
    this.traderIdleTimer += dt;
    if (this.traderIdleTimer < TRADER_IDLE_FRAME_SECONDS) return;
    this.traderIdleTimer = 0;

    for (const trader of this.animatedTraderRenders) {
      if (trader.frames.length === 0) continue;
      trader.frameCursor = (trader.frameCursor + 1) % trader.frames.length;
      const nextFrame = trader.frames[trader.frameCursor];
      this.redrawEntityRenderTexture(
        trader.renderTexture,
        nextFrame.textureKey,
        trader.tileRect,
        trader.scale,
        nextFrame.srcOffsetX,
      );
    }
  }

  /** Resolve tileset source coordinates to a spritesheet frame index. */
  private frameFromSrc(key: string, srcX: number, srcY: number): number {
    let cols = this.tilesetCols.get(key);
    if (!cols) {
      const tex = this.textures.get(key);
      const src = tex.getSourceImage() as { width?: number };
      const width = src?.width ?? TILE_PX;
      cols = Math.floor(width / TILE_PX);
      this.tilesetCols.set(key, cols);
    }
    return Math.floor(srcY / TILE_PX) * cols + Math.floor(srcX / TILE_PX);
  }

  /** Keep pixel art crisp by disabling linear filtering on loaded tilesets. */
  private applyNearestTextureFilters() {
    const keys = new Set<string>([
      ...Object.values(UID_TO_KEY),
      "ts-dev-trader-idle-1",
      "ts-dev-trader-idle-2",
      "ts-dev-trader-idle-3",
      "ts-design-trader-idle-1",
      "ts-design-trader-idle-2",
      "ts-design-trader-idle-3",
      "ts-game-trader-idle-1",
      "ts-game-trader-idle-2",
      "ts-game-trader-idle-3",
      "p-template",
      "p-shoes",
      "p-shirt",
      "lochlin",
    ]);
    keys.forEach((key) => {
      const texture = this.textures.get(key);
      if (texture) texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    });
  }

  /** Render a flat layer into a single RenderTexture (fast, no Y-sort). */
  private bakeLayer(layer: LdtkLayerInstance, key: string) {
    const { pxWid, pxHei } = GameBridge.mapData!.level;
    const rt = this.add.renderTexture(0, 0, pxWid, pxHei);
    rt.setOrigin(0, 0).setDepth(0);

    rt.beginDraw();
    for (const tile of layer.gridTiles) {
      const frame = this.frameFromSrc(key, tile.src[0], tile.src[1]);
      const img = this.make.image({
        x: tile.px[0],
        y: tile.px[1],
        key,
        frame,
        add: false,
      });
      img.setOrigin(0, 0);
      img.setFlipX(!!(tile.f & 1));
      img.setFlipY(!!(tile.f & 2));
      rt.batchDraw(img);
      img.destroy();
    }
    rt.endDraw();
  }

  /**
   * Render a Y-sorted layer as individual cropped images.
   *
   * Depth is based on the bottom-most tile in each tile-column, so tall objects
   * (e.g. houses/trees) stay in front of players while the player is "behind"
   * their base row, instead of leaking the top half through upper tiles.
   */
  private buildYSortLayer(layer: LdtkLayerInstance, key: string) {
    if (layer.gridTiles.length === 0) return;

    // Batch by column, but split into contiguous vertical segments so depth is
    // derived from each local object's bottom (not the bottom-most tile across
    // the entire column). This prevents far-away fence tiles from pulling near
    // tiles in front of the player incorrectly.
    const byCol = new Map<number, typeof layer.gridTiles>();
    for (const tile of layer.gridTiles) {
      const list = byCol.get(tile.px[0]);
      if (list) list.push(tile);
      else byCol.set(tile.px[0], [tile]);
    }

    for (const [colX, tiles] of byCol) {
      tiles.sort((leftTile, rightTile) => leftTile.px[1] - rightTile.px[1]);

      let segStart = 0;
      while (segStart < tiles.length) {
        let segEnd = segStart;
        while (
          segEnd + 1 < tiles.length &&
          tiles[segEnd + 1].px[1] - tiles[segEnd].px[1] === TILE_PX
        ) {
          segEnd++;
        }

        const segMinY = tiles[segStart].px[1];
        const segMaxY = tiles[segEnd].px[1];
        const rtH = segMaxY - segMinY + TILE_PX;

        const rt = this.add.renderTexture(colX, segMinY, TILE_PX, rtH);
        rt.setOrigin(0, 0);
        rt.setDepth(segMaxY + TILE_PX);

        rt.beginDraw();
        for (let tileIndex = segStart; tileIndex <= segEnd; tileIndex++) {
          const tile = tiles[tileIndex];
          const frame = this.frameFromSrc(key, tile.src[0], tile.src[1]);
          const img = this.make.image({
            x: 0,
            y: tile.px[1] - segMinY,
            key,
            frame,
            add: false,
          });
          img.setOrigin(0, 0);
          img.setFlipX(!!(tile.f & 1));
          img.setFlipY(!!(tile.f & 2));
          rt.batchDraw(img);
          img.destroy();
        }
        rt.endDraw();

        segStart = segEnd + 1;
      }
    }
  }

  // â”€â”€ Local player spawn â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Spawn local player visuals at server spawn (or fallback random spawn). */
  private spawnLocalPlayer() {
    const { spawnCandidates } = GameBridge.mapData!;
    const fallbackSpawn =
      spawnCandidates[Math.floor(Math.random() * spawnCandidates.length)];
    const spawn = GameBridge.serverSpawn ?? fallbackSpawn;

    const { x, y } = tileCenter(spawn.col, spawn.row);

    const layers = makeAvatarLayers(this, GameBridge.playerAvatar.shirt);
    this.lBase = layers.base;
    this.lShoes = layers.shoes;
    this.lShirt = layers.shirt;

    this.lLabel = makeNameLabel(this, GameBridge.playerName);
    this.lMuteIcon = makeMuteIcon(this);

    this.lContainer = this.add.container(x, y, [
      this.lBase,
      this.lShoes,
      this.lShirt,
      this.lLabel,
      this.lMuteIcon,
    ]);

    this.localMovement.applySpawn(spawn.col, spawn.row, !!GameBridge.serverSpawn);
  }

  /** Snap local player to server-authoritative spawn when join ack arrives. */
  private reconcileServerSpawnIfNeeded() {
    this.localMovement.reconcileServerSpawnIfNeeded();
  }

  // â”€â”€ Camera & input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Configure camera zoom, bounds, follow, and pixel rounding. */
  private setupCamera() {
    const { pxWid, pxHei } = GameBridge.mapData!.level;
    this.cameras.main
      .setZoom(CAMERA_ZOOM)
      .setBounds(0, 0, pxWid, pxHei)
      .startFollow(this.lContainer, true, CAMERA_LERP, CAMERA_LERP)
      .setRoundPixels(true);
  }

  /** Register keyboard controls used by movement and interactions. */
  private setupInput() {
    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.wKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.sKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.aKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.dKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.eKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
  }

  /** Enable mouse drag panning and suspend it while interaction panels are open. */
  private setupMouseDragControls() {
    this.cameraDrag.enable(
      () =>
        (this.graveInteraction?.isPanelVisible() ?? false) ||
        (this.npcInteraction?.isPanelVisible() ?? false) ||
        (this.statueInteraction?.isPanelVisible() ?? false),
    );
  }

  /** Re-attach camera follow smoothly after drag mode ends. */
  private resetCameraFollowToPlayer() {
    this.cameraDrag.resetFollowToPlayer(this.lContainer);
  }

  
  
  
  
  // â”€â”€ Update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  update(_time: number, delta: number) {
    if (!GameBridge.mapData) return;
    const dt = delta / 1000; // ms â†’ seconds
    if (!GameBridge.serverSpawn) this.localMovement.setServerSpawnApplied(false);
    this.reconcileServerSpawnIfNeeded();
    this.localMovement.update(dt, {
      cursors: this.cursors,
      wKey: this.wKey,
      sKey: this.sKey,
      aKey: this.aKey,
      dKey: this.dKey,
    });
    this.remotePlayers.sync(GameBridge.remotePlayers);
    this.remotePlayers.updateAnimations(dt, GameBridge.remotePlayers);
    this.updateTraderIdleAnimations(dt);
    this.updateVoiceIndicators(_time);
    this.graveInteraction?.update(this.eKey);
    this.npcInteraction?.update(this.eKey);
    this.statueInteraction?.update(this.eKey);
    this.updateDepths();
  }

  // â”€â”€ Movement state machine (ported from LocalPlayer.tsx) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // â”€â”€ Remote player sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â”€â”€ Y-sort â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Sort local and remote players by feet Y so occlusion matches top-down depth. */
  private updateDepths() {
    // depth = feet pixel Y = container.y (tile centre) + half tile
    this.lContainer.setDepth(this.lContainer.y + TILE_PX / 2);
    this.remotePlayers.updateDepths();
  }
  /** Refresh local/remote mute icon visibility from voice state. */
  private updateVoiceIndicators(_time: number) {
    this.lMuteIcon.setVisible(GameBridge.localMuted);

    this.remotePlayers.updateMuteIndicators(GameBridge.remotePlayers);
  }
}
















