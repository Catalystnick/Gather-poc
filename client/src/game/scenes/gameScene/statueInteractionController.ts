import Phaser from "phaser";
import type { LdtkEntityInstance } from "../../../types/mapTypes";
import {
  STATUE_DISCOVER_RANGE_PX,
  STATUE_READ_RANGE_PX,
  TILE_PX,
} from "./constants";
import { getEntityCenter } from "./entityPlacement";
import type { StatueLore } from "./types";

interface ControllerOptions {
  scene: Phaser.Scene;
  getPlayerWorldPosition: () => { x: number; y: number };
  onPanelOpen?: () => void;
}

/** Handles statue discovery prompt and lore panel UI. */
export class StatueInteractionController {
  private scene: Phaser.Scene;
  private getPlayerWorldPosition: () => { x: number; y: number };
  private onPanelOpen?: () => void;

  private statueLore: StatueLore[] = [];
  private activeStatueIid: string | null = null;
  private prompt!: Phaser.GameObjects.Text;
  private worldHint!: Phaser.GameObjects.Container;
  private hintRing!: Phaser.GameObjects.Arc;
  private hintGlyph!: Phaser.GameObjects.Text;
  private panel!: Phaser.GameObjects.Container;
  private panelTitle!: Phaser.GameObjects.Text;
  private panelBody!: Phaser.GameObjects.Text;
  private closeHit!: Phaser.GameObjects.Arc;

  constructor(options: ControllerOptions) {
    this.scene = options.scene;
    this.getPlayerWorldPosition = options.getPlayerWorldPosition;
    this.onPanelOpen = options.onPanelOpen;
  }

  /** Register statue lore from LDtk field text. */
  registerStatue(entity: LdtkEntityInstance) {
    if (entity.__identifier !== "Statue") return;
    const text =
      this.getEntityText(entity, "God_text") ||
      this.getEntityText(entity, "god_text") ||
      this.getEntityText(entity, "god text");
    if (!text) return;
    const center = getEntityCenter(entity);
    this.statueLore.push({
      iid: entity.iid,
      x: center.x,
      y: center.y,
      text,
    });
  }

  /** Create UI objects once after scene input/camera setup. */
  createUi(cameraZoom: number) {
    this.createPrompt(cameraZoom);
    this.createWorldHint();
    this.createPanel(cameraZoom);
  }

  /** Returns whether lore panel is currently open. */
  isPanelVisible() {
    return !!this.panel?.visible;
  }

  /** Hide lore panel and hint UI. */
  hidePanel() {
    this.hideLorePanel();
  }

  /** Update statue hint/panel interaction state each frame. */
  update(eKey: Phaser.Input.Keyboard.Key) {
    if (!this.prompt || !this.worldHint || !this.panel) return;
    if (this.prompt.visible) this.positionPrompt();
    if (this.panel.visible) this.positionPanel();

    const nearest = this.findNearestStatue();
    if (!nearest) {
      this.prompt.setVisible(false);
      this.worldHint.setVisible(false);
      if (this.panel.visible) this.hideLorePanel();
      return;
    }

    const discoverSq = STATUE_DISCOVER_RANGE_PX * STATUE_DISCOVER_RANGE_PX;
    const readSq = STATUE_READ_RANGE_PX * STATUE_READ_RANGE_PX;
    if (nearest.sq > discoverSq) {
      this.prompt.setVisible(false);
      this.worldHint.setVisible(false);
      if (this.panel.visible) this.hideLorePanel();
      return;
    }

    this.worldHint.setPosition(nearest.wx, nearest.wy - TILE_PX * 4.6);
    this.worldHint.setVisible(true);

    if (nearest.sq > readSq) {
      this.setHintMode("discover");
      this.prompt.setVisible(false);
      if (this.panel.visible) this.hideLorePanel();
      return;
    }

    this.setHintMode("read");
    this.prompt.setText("Press E to invoke");
    this.positionPrompt();
    this.prompt.setVisible(true);

    if (this.panel.visible) {
      this.prompt.setVisible(false);
      if (this.activeStatueIid !== nearest.note.iid)
        this.showLorePanel(nearest.note);
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(eKey)) {
      this.prompt.setVisible(false);
      this.showLorePanel(nearest.note);
    }
  }

  private getEntityText(entity: LdtkEntityInstance, key: string): string {
    const textField = entity.fieldInstances.find(
      (fieldInstance) => fieldInstance.__identifier === key,
    );
    return typeof textField?.__value === "string"
      ? textField.__value.trim()
      : "";
  }

  private createPrompt(cameraZoom: number) {
    this.prompt = this.scene.add
      .text(0, 0, "Press E to invoke", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "15px",
        color: "#fef3c7",
        backgroundColor: "#120b1a",
        padding: { left: 12, right: 12, top: 7, bottom: 7 },
      })
      .setOrigin(0.5, 0.5)
      .setDepth(49_999)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setStroke("#09090b", 4)
      .setVisible(false);
  }

  private createWorldHint() {
    const ring = this.scene.add.circle(0, 0, 13, 0x1a1026, 0.95);
    ring.setStrokeStyle(2, 0xfacc15, 1);
    const glyph = this.scene.add
      .text(0, 0, "?", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "16px",
        color: "#fde68a",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    this.worldHint = this.scene.add
      .container(0, 0, [ring, glyph])
      .setDepth(40_500)
      .setVisible(false);
    this.hintRing = ring;
    this.hintGlyph = glyph;
  }

  private setHintMode(mode: "discover" | "read") {
    if (mode === "discover") {
      this.hintRing
        .setRadius(13)
        .setFillStyle(0x1a1026, 0.95)
        .setStrokeStyle(2, 0xfacc15, 1);
      this.hintGlyph.setText("?").setFontSize(16).setColor("#fde68a");
      return;
    }

    this.hintRing
      .setRadius(14)
      .setFillStyle(0x1e3a5f, 0.98)
      .setStrokeStyle(2, 0x93c5fd, 1);
    this.hintGlyph.setText("E").setFontSize(13).setColor("#dbeafe");
  }

  private createPanel(cameraZoom: number) {
    const panelW = 420;
    const panelH = 190;

    const shadow = this.scene.add.rectangle(
      5,
      6,
      panelW,
      panelH,
      0x000000,
      0.42,
    );
    const bg = this.scene.add
      .rectangle(0, 0, panelW, panelH, 0x0a0712, 0.97)
      .setStrokeStyle(2, 0xfacc15, 0.95);
    const topBar = this.scene.add.rectangle(
      0,
      -panelH / 2 + 9,
      panelW - 16,
      4,
      0xeab308,
      1,
    );
    const subtitle = this.scene.add
      .text(0, -panelH / 2 + 24, "Forgotten God", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "12px",
        color: "#fde68a",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);
    const title = this.scene.add
      .text(0, -panelH / 2 + 48, "Relic Whisper", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "18px",
        color: "#f8fafc",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);
    const body = this.scene.add.text(-panelW / 2 + 24, -panelH / 2 + 76, "", {
      fontFamily: "Verdana, Arial, sans-serif",
      fontSize: "14px",
      color: "#e2e8f0",
      wordWrap: { width: panelW - 48, useAdvancedWrap: true },
      lineSpacing: 5,
    });

    const closeBg = this.scene.add
      .circle(panelW / 2 - 19, -panelH / 2 + 19, 14, 0x7f1d1d, 1)
      .setStrokeStyle(2, 0xfca5a5, 1);
    const closeTxt = this.scene.add
      .text(panelW / 2 - 19, -panelH / 2 + 19, "X", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "13px",
        color: "#ffffff",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    this.panel = this.scene.add.container(0, 0, [
      shadow,
      bg,
      topBar,
      subtitle,
      title,
      body,
      closeBg,
      closeTxt,
    ]);
    this.panel
      .setDepth(50_300)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setVisible(false);
    this.panel.setSize(panelW, panelH);
    this.panel.setInteractive(
      new Phaser.Geom.Rectangle(-panelW / 2, -panelH / 2, panelW, panelH),
      Phaser.Geom.Rectangle.Contains,
    );
    this.panel.on(
      "pointerdown",
      (_pointer: Phaser.Input.Pointer, localX: number, localY: number) => {
        if (
          localX >= panelW / 2 - 39 &&
          localX <= panelW / 2 - 3 &&
          localY >= -panelH / 2 + 2 &&
          localY <= -panelH / 2 + 39
        ) {
          this.hideLorePanel();
        }
      },
    );

    this.closeHit = this.scene.add
      .circle(0, 0, 18, 0x000000, 0.001)
      .setDepth(50_310)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    this.closeHit.on("pointerdown", () => {
      this.hideLorePanel();
    });

    this.panelTitle = title;
    this.panelBody = body;
  }

  private positionPrompt() {
    this.prompt.setPosition(
      this.scene.scale.width / 2,
      this.scene.scale.height - 210,
    );
  }

  private positionPanel() {
    const panelX = this.scene.scale.width / 2;
    const panelY = this.scene.scale.height / 2;
    this.panel.setPosition(panelX, panelY);
    if (this.closeHit) {
      const scale = this.panel.scaleX;
      this.closeHit.setPosition(panelX + 191 * scale, panelY - 76 * scale);
    }
  }

  private findNearestStatue(): {
    note: StatueLore;
    sq: number;
    wx: number;
    wy: number;
  } | null {
    let nearest: StatueLore | null = null;
    let nearestSq = Number.POSITIVE_INFINITY;
    let nearestWx = 0;
    let nearestWy = 0;
    const playerPosition = this.getPlayerWorldPosition();

    for (const note of this.statueLore) {
      const dx = note.x - playerPosition.x;
      const dy = note.y - playerPosition.y;
      const sq = dx * dx + dy * dy;
      if (sq < nearestSq) {
        nearestSq = sq;
        nearest = note;
        nearestWx = note.x;
        nearestWy = note.y;
      }
    }

    return nearest
      ? { note: nearest, sq: nearestSq, wx: nearestWx, wy: nearestWy }
      : null;
  }

  private showLorePanel(note: StatueLore) {
    this.activeStatueIid = note.iid;
    this.onPanelOpen?.();
    this.panelTitle.setText("Relic Whisper");
    this.panelBody.setText(note.text);
    this.positionPanel();
    this.panel.setVisible(true);
    if (this.closeHit) this.closeHit.setVisible(true);
  }

  private hideLorePanel() {
    this.activeStatueIid = null;
    this.panel.setVisible(false);
    if (this.closeHit) this.closeHit.setVisible(false);
    if (this.worldHint) this.worldHint.setVisible(false);
  }
}
