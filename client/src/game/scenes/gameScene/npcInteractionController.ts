import Phaser from "phaser";
import type { LdtkEntityInstance } from "../../../types/mapTypes";
import { NPC_DISCOVER_RANGE_PX, NPC_TALK_RANGE_PX, TILE_PX } from "./constants";
import { getEntityCenter, getEntityTopLeft } from "./entityPlacement";
import type { TraderNote } from "./types";

// Tune these two values to move the NPC exclamation/E bubble.
const NPC_HINT_OFFSET_X_PX = 0;
const NPC_HINT_OFFSET_Y_PX = -TILE_PX * 0.65;

interface ControllerOptions {
  scene: Phaser.Scene;
  getPlayerWorldPosition: () => { x: number; y: number };
  getLevelWorldOffset: () => { worldX: number; worldY: number };
  onPanelOpen?: (traderIid: string) => void;
  onPanelClose?: () => void;
}

/** Handles trader proximity hints and a simple talk panel. */
export class NpcInteractionController {
  private scene: Phaser.Scene;
  private getPlayerWorldPosition: () => { x: number; y: number };
  private onPanelOpen?: (traderIid: string) => void;
  private onPanelClose?: () => void;

  private traders: TraderNote[] = [];
  private activeTraderIid: string | null = null;
  private talkPrompt!: Phaser.GameObjects.Text;
  private worldHint!: Phaser.GameObjects.Container;
  private hintBubble!: Phaser.GameObjects.Arc;
  private hintText!: Phaser.GameObjects.Text;
  private talkPanel!: Phaser.GameObjects.Container;
  private talkPanelTitle!: Phaser.GameObjects.Text;
  private talkPanelBody!: Phaser.GameObjects.Text;
  private talkCloseHit!: Phaser.GameObjects.Arc;

  constructor(options: ControllerOptions) {
    this.scene = options.scene;
    this.getPlayerWorldPosition = options.getPlayerWorldPosition;
    this.onPanelOpen = options.onPanelOpen;
    this.onPanelClose = options.onPanelClose;
  }

  /** Registers trader entities and their talk text from LDtk. */
  registerTrader(entity: LdtkEntityInstance) {
    const isNpcLike = /(trader|merchant|npc)/i.test(entity.__identifier);
    if (!isNpcLike) return;
    const welcome =
      this.getEntityText(entity, "Welcome") ||
      this.getEntityText(entity, "welcome") ||
      this.getEntityText(entity, "String") ||
      this.getEntityText(entity, "text");
    if (!welcome) return;
    const center = getEntityCenter(entity);
    const drawnBounds = this.getNpcDrawBounds(entity);
    const hintX = drawnBounds.centerX + NPC_HINT_OFFSET_X_PX;
    const hintY = drawnBounds.topY + NPC_HINT_OFFSET_Y_PX;

    this.traders.push({
      iid: entity.iid,
      x: center.x,
      y: center.y,
      hintOffsetX: hintX - center.x,
      hintOffsetY: hintY - center.y,
      label: entity.__identifier.replace(/_/g, " "),
      welcome,
    });
  }

  /** Mirrors GameScene NPC width-fit draw math so hints track rendered sprite heads. */
  private getNpcDrawBounds(entity: LdtkEntityInstance): {
    centerX: number;
    topY: number;
  } {
    const entityTopLeft = getEntityTopLeft(entity);
    const tile = entity.__tile;
    if (!tile) {
      return {
        centerX: entityTopLeft.x + entity.width / 2,
        topY: entityTopLeft.y,
      };
    }

    const widthFitScale = entity.width / tile.w;
    const drawW = tile.w * widthFitScale;
    const drawH = tile.h * widthFitScale;
    const drawX = entityTopLeft.x + (entity.width - drawW) / 2;
    const drawY = entityTopLeft.y + (entity.height - drawH) / 2;
    return {
      centerX: drawX + drawW / 2,
      topY: drawY,
    };
  }

  /** Creates all HUD/world hint UI pieces once after camera/input setup. */
  createUi(cameraZoom: number) {
    this.destroyUi();
    this.createTalkPrompt(cameraZoom);
    this.createWorldHint();
    this.createTalkPanel(cameraZoom);
  }

  /** Returns true while NPC panel is open, used to block camera drag. */
  isPanelVisible() {
    return !!this.talkPanel?.visible;
  }

  /** Closes trader panel and any visible hints. */
  hidePanel() {
    this.hideTalkPanel();
  }

  /** Destroy existing UI objects to avoid duplicate overlays on scene re-create. */
  private destroyUi() {
    if (this.talkPrompt) this.talkPrompt.destroy();
    if (this.worldHint) this.worldHint.destroy();
    if (this.talkPanel) this.talkPanel.destroy();
    if (this.talkCloseHit) this.talkCloseHit.destroy();
  }

  /** Updates NPC proximity hints and handles talk panel open/close flow. */
  update(eKey: Phaser.Input.Keyboard.Key) {
    if (!this.talkPrompt || !this.worldHint || !this.talkPanel) return;
    if (this.talkPrompt.visible) this.positionTalkPrompt();
    if (this.talkPanel.visible) this.positionTalkPanel();

    const nearest = this.findNearestTrader();
    if (!nearest) {
      this.talkPrompt.setVisible(false);
      this.worldHint.setVisible(false);
      if (this.talkPanel.visible) this.hideTalkPanel();
      return;
    }

    const discoverSq = NPC_DISCOVER_RANGE_PX * NPC_DISCOVER_RANGE_PX;
    const talkSq = NPC_TALK_RANGE_PX * NPC_TALK_RANGE_PX;
    if (nearest.sq > discoverSq) {
      this.talkPrompt.setVisible(false);
      this.worldHint.setVisible(false);
      if (this.talkPanel.visible) this.hideTalkPanel();
      return;
    }

    this.worldHint.setPosition(nearest.hintWx, nearest.hintWy);
    this.worldHint.setVisible(true);

    if (nearest.sq > talkSq) {
      this.setHintMode("discover");
      this.talkPrompt.setVisible(false);
      if (this.talkPanel.visible) this.hideTalkPanel();
      return;
    }

    this.setHintMode("talk");
    this.talkPrompt.setText("Press E to talk");
    this.positionTalkPrompt();
    this.talkPrompt.setVisible(true);

    if (this.talkPanel.visible) {
      if (this.activeTraderIid !== nearest.note.iid)
        this.showTalkPanel(nearest.note);
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(eKey)) {
      this.talkPrompt.setVisible(false);
      this.showTalkPanel(nearest.note);
    }
  }

  private getEntityText(entity: LdtkEntityInstance, key: string): string {
    const field = entity.fieldInstances.find(
      (fieldInstance) => fieldInstance.__identifier === key,
    );
    return typeof field?.__value === "string" ? field.__value.trim() : "";
  }

  private createTalkPrompt(cameraZoom: number) {
    this.talkPrompt = this.scene.add
      .text(0, 0, "Press E to talk", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "15px",
        color: "#fff7d6",
        backgroundColor: "#1f2937",
        padding: { left: 12, right: 12, top: 7, bottom: 7 },
      })
      .setOrigin(0.5, 0.5)
      .setDepth(49_999)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setStroke("#111827", 4)
      .setVisible(false);
  }

  private createWorldHint() {
    const bubble = this.scene.add.circle(0, 0, 12, 0x7c2d12, 0.98);
    bubble.setStrokeStyle(2, 0xfbbf24, 1);
    const text = this.scene.add
      .text(0, 0, "!", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "14px",
        color: "#fef3c7",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    this.worldHint = this.scene.add
      .container(0, 0, [bubble, text])
      .setDepth(40_000)
      .setVisible(false);
    this.hintBubble = bubble;
    this.hintText = text;
  }

  private setHintMode(mode: "discover" | "talk") {
    if (mode === "discover") {
      this.hintBubble
        .setRadius(12)
        .setFillStyle(0x7c2d12, 0.98)
        .setStrokeStyle(2, 0xfbbf24, 1);
      this.hintText.setText("!").setFontSize(14).setColor("#fef3c7");
      return;
    }
    this.hintBubble
      .setRadius(14)
      .setFillStyle(0x1e3a5f, 0.98)
      .setStrokeStyle(2, 0x93c5fd, 1);
    this.hintText.setText("E").setFontSize(13).setColor("#dbeafe");
  }

  private createTalkPanel(cameraZoom: number) {
    const panelW = 350;
    const panelH = 156;
    const shadow = this.scene.add.rectangle(
      4,
      6,
      panelW,
      panelH,
      0x000000,
      0.35,
    );
    const bg = this.scene.add
      .rectangle(0, 0, panelW, panelH, 0x0b1220, 0.97)
      .setStrokeStyle(2, 0x38bdf8, 0.95);
    const accent = this.scene.add.rectangle(
      0,
      -panelH / 2 + 8,
      panelW - 14,
      4,
      0x38bdf8,
      1,
    );

    const title = this.scene.add.text(
      -panelW / 2 + 18,
      -panelH / 2 + 16,
      "Trader",
      {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "16px",
        color: "#dbeafe",
        fontStyle: "bold",
      },
    );
    const body = this.scene.add.text(-panelW / 2 + 18, -panelH / 2 + 48, "", {
      fontFamily: "Verdana, Arial, sans-serif",
      fontSize: "14px",
      color: "#f8fafc",
      wordWrap: { width: panelW - 36, useAdvancedWrap: true },
      lineSpacing: 4,
    });

    const closeBg = this.scene.add
      .circle(panelW / 2 - 18, -panelH / 2 + 18, 14, 0x7f1d1d, 1)
      .setStrokeStyle(2, 0xfca5a5, 1);
    const closeTxt = this.scene.add
      .text(panelW / 2 - 18, -panelH / 2 + 18, "X", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "13px",
        color: "#ffffff",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    this.talkPanel = this.scene.add.container(0, 0, [
      shadow,
      bg,
      accent,
      title,
      body,
      closeBg,
      closeTxt,
    ]);
    this.talkPanel
      .setDepth(50_100)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setVisible(false);
    this.talkPanel.setSize(panelW, panelH);
    this.talkPanel.setInteractive(
      new Phaser.Geom.Rectangle(-panelW / 2, -panelH / 2, panelW, panelH),
      Phaser.Geom.Rectangle.Contains,
    );
    this.talkPanel.on(
      "pointerdown",
      (_pointer: Phaser.Input.Pointer, localX: number, localY: number) => {
        if (
          localX >= panelW / 2 - 38 &&
          localX <= panelW / 2 - 2 &&
          localY >= -panelH / 2 + 2 &&
          localY <= -panelH / 2 + 38
        ) {
          this.hideTalkPanel();
        }
      },
    );

    this.talkCloseHit = this.scene.add
      .circle(0, 0, 18, 0x000000, 0.001)
      .setDepth(50_110)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    this.talkCloseHit.on("pointerdown", () => {
      this.hideTalkPanel();
    });

    this.talkPanelTitle = title;
    this.talkPanelBody = body;
  }

  private positionTalkPrompt() {
    this.talkPrompt.setPosition(
      this.scene.scale.width / 2,
      this.scene.scale.height - 210,
    );
  }

  private positionTalkPanel() {
    const panelX = this.scene.scale.width / 2;
    const panelY = this.scene.scale.height / 2;
    this.talkPanel.setPosition(panelX, panelY);
    if (this.talkCloseHit) {
      const scale = this.talkPanel.scaleX;
      this.talkCloseHit.setPosition(panelX + 157 * scale, panelY - 60 * scale);
    }
  }

  private findNearestTrader(): {
    note: TraderNote;
    sq: number;
    wx: number;
    wy: number;
    hintWx: number;
    hintWy: number;
  } | null {
    let nearest: TraderNote | null = null;
    let nearestSq = Number.POSITIVE_INFINITY;
    let nearestWx = 0;
    let nearestWy = 0;
    let nearestHintWx = 0;
    let nearestHintWy = 0;
    const playerPosition = this.getPlayerWorldPosition();

    for (const trader of this.traders) {
      const dx = trader.x - playerPosition.x;
      const dy = trader.y - playerPosition.y;
      const traderSq = dx * dx + dy * dy;
      if (traderSq < nearestSq) {
        nearestSq = traderSq;
        nearest = trader;
        nearestWx = trader.x;
        nearestWy = trader.y;
        nearestHintWx = trader.x + trader.hintOffsetX;
        nearestHintWy = trader.y + trader.hintOffsetY;
      }
    }

    return nearest
      ? {
          note: nearest,
          sq: nearestSq,
          wx: nearestWx,
          wy: nearestWy,
          hintWx: nearestHintWx,
          hintWy: nearestHintWy,
        }
      : null;
  }

  private showTalkPanel(note: TraderNote) {
    this.activeTraderIid = note.iid;
    this.onPanelOpen?.(note.iid);
    this.talkPanelTitle.setText(note.label);
    this.talkPanelBody.setText(note.welcome);
    this.positionTalkPanel();
    this.talkPanel.setVisible(true);
    if (this.talkCloseHit) this.talkCloseHit.setVisible(true);
  }

  private hideTalkPanel() {
    const wasVisible = this.talkPanel?.visible ?? false;
    this.activeTraderIid = null;
    this.talkPanel.setVisible(false);
    if (this.talkCloseHit) this.talkCloseHit.setVisible(false);
    if (wasVisible) this.onPanelClose?.();
  }
}
