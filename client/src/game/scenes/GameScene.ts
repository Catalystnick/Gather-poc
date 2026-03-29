import Phaser from "phaser";
import GameBridge from "../GameBridge";
import type { LdtkEntityInstance, LdtkLayerInstance } from "../../types/mapTypes";
import {
  makeAvatarLayers,
  makeMuteIcon,
  makeNameLabel,
  setAvatarFrame,
} from "../engine/avatarVisualFactory";
import {
  BAKED,
  YSORTED,
} from "../content/maps/test/constants";
import { CAMERA_LERP, CAMERA_ZOOM, TILE_PX, tileCenter } from "../engine/constants";
import {
  applyNearestTextureFilters,
  preloadSceneAssets,
} from "../content/maps/test/assetPipeline";
import { CameraDragController } from "../engine/cameraDragController";
import { getEntityTopLeft } from "../engine/entityPlacement";
import { GraveInteractionController } from "../content/maps/test/graveInteractionController";
import { LayerRenderer } from "../engine/layerRenderer";
import { LocalMovementController } from "../engine/localMovementController";
import { NpcInteractionController } from "../content/maps/test/npcInteractionController";
import { RemotePlayerController } from "../engine/remotePlayerController";
import { StatueInteractionController } from "../content/maps/test/statueInteractionController";
import {
  TraderAnimationController,
  getTraderDialogTextureKey,
  getTraderIdleTextureKeys,
} from "../content/maps/test/traderAnimationController";

export default class GameScene extends Phaser.Scene {
  // Input
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wKey!: Phaser.Input.Keyboard.Key;
  private sKey!: Phaser.Input.Keyboard.Key;
  private aKey!: Phaser.Input.Keyboard.Key;
  private dKey!: Phaser.Input.Keyboard.Key;
  private eKey!: Phaser.Input.Keyboard.Key;

  // Local player visuals
  private lContainer!: Phaser.GameObjects.Container;
  private lBase!: Phaser.GameObjects.Image;
  private lShoes!: Phaser.GameObjects.Image;
  private lShirt!: Phaser.GameObjects.Image;
  private lLabel!: Phaser.GameObjects.Text;
  private lMuteIcon!: Phaser.GameObjects.Text;

  // Scene systems
  private layerRenderer!: LayerRenderer;
  private cameraDrag!: CameraDragController;
  private graveInteraction!: GraveInteractionController;
  private npcInteraction!: NpcInteractionController;
  private statueInteraction!: StatueInteractionController;
  private localMovement!: LocalMovementController;
  private remotePlayers!: RemotePlayerController;
  private traderAnimation!: TraderAnimationController;

  constructor() {
    super({ key: "GameScene" });
  }

  preload() {
    preloadSceneAssets(this, GameBridge.mapData);
  }

  create() {
    if (!GameBridge.mapData) return;

    this.setupRenderPipeline();
    this.setupControllers();
    this.buildWorldFromMap();
    this.spawnLocalPlayer();
    this.setupCamera();
    this.setupInput();
    this.setupMouseDragControls();
    this.setupInteractionUi();
  }

  /** Prepare texture filters and low-level tile/entity render helpers. */
  private setupRenderPipeline() {
    applyNearestTextureFilters(this, GameBridge.mapData);
    this.layerRenderer = new LayerRenderer(this);
    this.cameraDrag = new CameraDragController({ scene: this });
  }

  /** Resolve a tileset uid to its runtime texture key from loaded LDtk metadata. */
  private getTilesetTextureKey(tilesetUid: number) {
    return GameBridge.mapData?.tilesetTextureKeys.get(tilesetUid) ?? null;
  }

  /** Initialize movement, remote sync, trader animation, and interaction systems. */
  private setupControllers() {
    this.traderAnimation = new TraderAnimationController({
      getTextureWidth: (textureKey) =>
        this.layerRenderer.getTextureWidth(textureKey),
      redraw: (renderTexture, textureKey, tileRect, scale, srcOffsetX = 0) =>
        this.layerRenderer.redrawEntityRenderTexture(
          renderTexture,
          textureKey,
          tileRect,
          scale,
          srcOffsetX,
        ),
    });
    this.traderAnimation.clear();

    this.localMovement = new LocalMovementController({
      getContainer: () => this.lContainer,
      setAvatarFrame: (frame) =>
        setAvatarFrame(this.lBase, this.lShoes, this.lShirt, frame),
      resetCameraFollowToPlayer: () => this.resetCameraFollowToPlayer(),
    });
    this.remotePlayers = new RemotePlayerController({ scene: this });

    this.graveInteraction = new GraveInteractionController({
      scene: this,
      getPlayerWorldPosition: () => ({ x: this.lContainer.x, y: this.lContainer.y }),
      onPanelOpen: () => this.cameraDrag.stopDragging(),
    });
    this.npcInteraction = new NpcInteractionController({
      scene: this,
      getPlayerWorldPosition: () => ({ x: this.lContainer.x, y: this.lContainer.y }),
      onPanelOpen: (traderIid) => {
        this.cameraDrag.stopDragging();
        this.traderAnimation.activateDialog(traderIid);
      },
      onPanelClose: () => this.traderAnimation.resetIdle(),
    });
    this.statueInteraction = new StatueInteractionController({
      scene: this,
      getPlayerWorldPosition: () => ({ x: this.lContainer.x, y: this.lContainer.y }),
      onPanelOpen: () => this.cameraDrag.stopDragging(),
    });
  }

  /** Build tile layers and entity visuals from current LDtk level data. */
  private buildWorldFromMap() {
    const layers = GameBridge.mapData?.level.layerInstances ?? [];
    this.buildMap(layers);
    this.buildEntities(layers);
  }

  /** Create fixed-screen interaction prompts/panels with camera-aware scale. */
  private setupInteractionUi() {
    const cameraZoom = this.cameras.main.zoom;
    this.graveInteraction.createUi(cameraZoom);
    this.npcInteraction.createUi(cameraZoom);
    this.statueInteraction.createUi(cameraZoom);
  }

  private buildMap(layers: LdtkLayerInstance[]) {
    // LDtk layers are stored top->bottom; reverse to render bottom->top.
    for (const layer of [...layers].reverse()) {
      if (layer.__type !== "Tiles" || !layer.__tilesetDefUid) continue;
      const key = this.getTilesetTextureKey(layer.__tilesetDefUid);
      if (!key) continue;

      if (BAKED.has(layer.__identifier)) {
        this.layerRenderer.bakeLayer(
          layer,
          key,
          GameBridge.mapData!.level.pxWid,
          GameBridge.mapData!.level.pxHei,
        );
      } else if (YSORTED.has(layer.__identifier)) {
        this.layerRenderer.buildYSortLayer(layer, key);
      }
    }
  }

  /**
   * Render LDtk entity visuals (e.g. Statue, Gravestone) from Entities layer
   * tile rects and register interaction payloads.
   */
  private buildEntities(layers: LdtkLayerInstance[]) {
    for (const layer of layers) {
      if (layer.__type !== "Entities") continue;
      for (const entity of layer.entityInstances) {
        this.drawEntityTile(entity);
        this.graveInteraction.registerGravestone(entity);
        this.npcInteraction.registerTrader(entity);
        this.statueInteraction.registerStatue(entity);
      }
    }
  }

  /** Draw one LDtk entity tile into a render texture at its editor-aligned position. */
  private drawEntityTile(entity: LdtkEntityInstance) {
    const tile = entity.__tile;
    if (!tile) return;

    const textureKey = this.getTilesetTextureKey(tile.tilesetUid);
    if (!textureKey) return;

    const fitScale = Math.min(entity.width / tile.w, entity.height / tile.h);
    const isNpcLike = /(trader|merchant|npc)/i.test(entity.__identifier);
    const widthFitScale = entity.width / tile.w;
    const smallEntity = fitScale < 1;
    const scale = isNpcLike ? widthFitScale : fitScale;
    const drawWidth = tile.w * scale;
    const drawHeight = tile.h * scale;
    const entityTopLeft = getEntityTopLeft(entity);
    const baseX = entityTopLeft.x + (entity.width - drawWidth) / 2;
    const baseY = entityTopLeft.y + (entity.height - drawHeight) / 2;
    const renderTextureWidth = Math.ceil(drawWidth);
    const renderTextureHeight = Math.ceil(drawHeight);

    const renderTexture = this.add.renderTexture(
      baseX,
      baseY,
      renderTextureWidth,
      renderTextureHeight,
    );
    renderTexture.setOrigin(0, 0);
    const depthBoost =
      entity.__identifier === "Spade" ? TILE_PX * 3 : smallEntity ? TILE_PX : 0;
    renderTexture.setDepth(baseY + drawHeight + depthBoost);

    const traderIdleTextures = getTraderIdleTextureKeys(entity.__identifier);
    if (traderIdleTextures) {
      const didRegisterTrader = this.traderAnimation.registerTrader({
        iid: entity.iid,
        renderTexture,
        tileRect: tile,
        scale,
        idleTextureKeys: traderIdleTextures,
        dialogTextureKey: getTraderDialogTextureKey(entity.__identifier),
      });
      if (!didRegisterTrader) {
        this.layerRenderer.redrawEntityRenderTexture(
          renderTexture,
          textureKey,
          tile,
          scale,
        );
      }
      return;
    }

    this.layerRenderer.redrawEntityRenderTexture(
      renderTexture,
      textureKey,
      tile,
      scale,
    );
  }

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
    keyboard.removeCapture(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.wKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W, false);
    this.sKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S, false);
    this.aKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A, false);
    this.dKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D, false);
    this.eKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E, false);
  }

  /** Enable mouse drag panning and suspend it while interaction panels are open. */
  private setupMouseDragControls() {
    this.cameraDrag.enable(() => this.isAnyInteractionPanelOpen());
  }

  /** Re-attach camera follow smoothly after drag mode ends. */
  private resetCameraFollowToPlayer() {
    this.cameraDrag.resetFollowToPlayer(this.lContainer);
  }

  /** Returns true if any interaction panel is currently open. */
  private isAnyInteractionPanelOpen() {
    return (
      (this.graveInteraction?.isPanelVisible() ?? false) ||
      (this.npcInteraction?.isPanelVisible() ?? false) ||
      (this.statueInteraction?.isPanelVisible() ?? false)
    );
  }

  update(_time: number, delta: number) {
    if (!GameBridge.mapData) return;

    const dt = delta / 1000;
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
    this.traderAnimation.update(dt);
    this.updateVoiceIndicators(_time);
    this.graveInteraction?.update(this.eKey);
    this.npcInteraction?.update(this.eKey);
    this.statueInteraction?.update(this.eKey);
    this.updateDepths();
  }

  /** Sort local and remote players by feet Y so occlusion matches top-down depth. */
  private updateDepths() {
    this.lContainer.setDepth(this.lContainer.y + TILE_PX / 2);
    this.remotePlayers.updateDepths();
  }

  /** Refresh local/remote mute icon visibility from voice state. */
  private updateVoiceIndicators(_time: number) {
    this.lMuteIcon.setVisible(GameBridge.localMuted);
    this.remotePlayers.updateMuteIndicators(GameBridge.remotePlayers);
  }
}
