import Phaser from "phaser";
import type { LdtkEntityInstance } from "../../../../types/mapTypes";
import {
  GRAVE_DISCOVER_RANGE_PX,
  GRAVE_READ_RANGE_PX,
} from "./constants";
import { TILE_PX } from "../../../engine/constants";
import { getEntityCenter } from "../../../engine/entityPlacement";
import {
  createBottomPrompt,
  createCloseHit,
  positionBottomPrompt,
  positionCenteredPanel,
  wirePanelCornerClose,
} from "../../../engine/interactionUi";
import { findNearestPoint, getEntityStringField } from "../../../engine/interactionUtils";
import type { GraveNote } from "./types";

interface ControllerOptions {
  scene: Phaser.Scene;
  getPlayerWorldPosition: () => { x: number; y: number };
  onPanelOpen?: () => void;
}

/** Handles gravestone prompts + readable panel UI outside the main scene class. */
export class GraveInteractionController {
  private scene: Phaser.Scene;
  private getPlayerWorldPosition: () => { x: number; y: number };
  private onPanelOpen?: () => void;

  private graveNotes: GraveNote[] = [];
  private activeGraveIid: string | null = null;
  private gravePanel!: Phaser.GameObjects.Container;
  private gravePanelTitle!: Phaser.GameObjects.Text;
  private gravePanelBody!: Phaser.GameObjects.Text;
  private graveCloseHit!: Phaser.GameObjects.Arc;
  private gravePrompt!: Phaser.GameObjects.Text;
  private graveWorldHint!: Phaser.GameObjects.Container;

  constructor(options: ControllerOptions) {
    this.scene = options.scene;
    this.getPlayerWorldPosition = options.getPlayerWorldPosition;
    this.onPanelOpen = options.onPanelOpen;
  }

  /** Register gravestone text payloads from LDtk entities. */
  registerGravestone(entity: LdtkEntityInstance) {
    const headline = getEntityStringField(entity, "Grave_Text");
    const subline = getEntityStringField(entity, "text");
    const isGraveLike = /grave/i.test(entity.__identifier) || !!headline;
    if (!isGraveLike) return;
    if (!headline && !subline) return;
    const center = getEntityCenter(entity);

    this.graveNotes.push({
      iid: entity.iid,
      x: center.x,
      y: center.y,
      headline,
      subline,
    });
  }

  /** Create all gravestone UI objects once after input/camera are initialized. */
  createUi(cameraZoom: number) {
    this.createGravePanel(cameraZoom);
    this.createGravePrompt(cameraZoom);
    this.createGraveWorldHint();
  }

  /** Returns true while the read panel is open (used to block camera dragging). */
  isPanelVisible() {
    return !!this.gravePanel?.visible;
  }

  /** Close the read panel, prompt, and world hint. */
  hidePanel() {
    this.hideGravePanel();
  }

  /** Update gravestone prompt/panel state every frame. */
  update(eKey: Phaser.Input.Keyboard.Key) {
    if (!this.gravePanel || !this.gravePrompt || !this.graveWorldHint) return;
    if (this.gravePanel.visible) this.positionGravePanel();
    if (this.gravePrompt.visible) this.positionGravePrompt();

    const nearest = this.findNearestGravestone();
    const nearby = this.findNearbyGravestone();
    if (!nearby) {
      this.graveWorldHint.setVisible(false);
      if (!nearest) {
        this.gravePrompt.setVisible(false);
      } else {
        const discoverSq = GRAVE_DISCOVER_RANGE_PX * GRAVE_DISCOVER_RANGE_PX;
        if (nearest.sq <= discoverSq) {
          this.positionGravePrompt();
          this.gravePrompt.setText("Move closer to read");
          this.gravePrompt.setVisible(true);
        } else {
          this.gravePrompt.setVisible(false);
        }
      }
      if (this.gravePanel.visible) this.hideGravePanel();
      return;
    }

    if (this.gravePanel.visible) {
      this.gravePrompt.setVisible(false);
      this.graveWorldHint.setVisible(false);
      if (this.activeGraveIid !== nearby.iid) this.showGravePanel(nearby);
      return;
    }

    if (nearest) {
      this.graveWorldHint.setPosition(nearest.wx, nearest.wy - TILE_PX * 1.2 - 10);
      this.graveWorldHint.setVisible(true);
    }
    this.positionGravePrompt();
    this.gravePrompt.setText("Press E to read");
    this.gravePrompt.setVisible(true);
    if (Phaser.Input.Keyboard.JustDown(eKey)) {
      this.gravePrompt.setVisible(false);
      this.showGravePanel(nearby);
    }
  }

  private createGravePanel(cameraZoom: number) {
    const panelW = 360;
    const panelH = 150;

    const imgW = 68;
    const imgH = 108;
    const imgX = -panelW / 2 + 8 + imgW / 2;
    const imgY = 2;
    const textX = -panelW / 2 + 8 + imgW + 10;
    const textWrap = 200;

    const shadow = this.scene.add.rectangle(4, 6, panelW, panelH, 0x000000, 0.35);
    const bg = this.scene.add
      .rectangle(0, 0, panelW, panelH, 0x0f172a, 0.96)
      .setStrokeStyle(2, 0xf59e0b, 0.95);
    const accent = this.scene.add.rectangle(
      0,
      -panelH / 2 + 8,
      panelW - 14,
      4,
      0xf59e0b,
      1,
    );

    const portraitFrame = this.scene.add
      .rectangle(imgX, imgY, imgW + 4, imgH + 4, 0x1e293b, 1)
      .setStrokeStyle(1.5, 0xf59e0b, 0.7);
    const portrait = this.scene.add
      .image(imgX, imgY, "lochlin")
      .setDisplaySize(imgW, imgH);

    const title = this.scene.add.text(textX, -panelH / 2 + 14, "Gravestone", {
      fontFamily: "Verdana, Arial, sans-serif",
      fontSize: "15px",
      color: "#fde68a",
      fontStyle: "bold",
    });
    const body = this.scene.add.text(textX, -panelH / 2 + 44, "", {
      fontFamily: "Verdana, Arial, sans-serif",
      fontSize: "13px",
      color: "#f9fafb",
      wordWrap: { width: textWrap, useAdvancedWrap: true },
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

    this.gravePanel = this.scene.add.container(0, 0, [
      shadow,
      bg,
      accent,
      portraitFrame,
      portrait,
      title,
      body,
      closeBg,
      closeTxt,
    ]);
    this.gravePanel
      .setDepth(50_000)
      .setScrollFactor(0)
      .setScale(1 / cameraZoom)
      .setVisible(false);
    wirePanelCornerClose({
      panel: this.gravePanel,
      panelWidth: panelW,
      panelHeight: panelH,
      onClose: () => this.hideGravePanel(),
    });

    this.graveCloseHit = createCloseHit(this.scene, {
      cameraZoom,
      depth: 50_010,
      onClose: () => this.hideGravePanel(),
    });

    this.gravePanelTitle = title;
    this.gravePanelBody = body;
  }

  private createGravePrompt(cameraZoom: number) {
    this.gravePrompt = createBottomPrompt(this.scene, {
      cameraZoom,
      text: "Press E to read",
      style: {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "15px",
        color: "#fef3c7",
        backgroundColor: "#0f172a",
        padding: { left: 12, right: 12, top: 7, bottom: 7 },
      },
    }).setStroke("#111827", 4);
  }

  private createGraveWorldHint() {
    const cardW = 58;
    const cardH = 20;
    const keySize = 13;
    const keyX = -cardW / 2 + 4 + keySize / 2;
    const labelX = keyX + keySize / 2 + 5;

    const shadow = this.scene.add.rectangle(2, 3, cardW, cardH, 0x000000, 0.45);
    const card = this.scene.add
      .rectangle(0, 0, cardW, cardH, 0x0f172a, 0.93)
      .setStrokeStyle(1, 0xf59e0b, 0.9);

    const keyBg = this.scene.add
      .rectangle(keyX, 0, keySize, keySize, 0x1e3a5f, 1)
      .setStrokeStyle(1.5, 0xfbbf24, 1);
    const keyTxt = this.scene.add
      .text(keyX, 0, "E", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "9px",
        color: "#fbbf24",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0.5);

    const label = this.scene.add
      .text(labelX, 0.5, "Read", {
        fontFamily: "Verdana, Arial, sans-serif",
        fontSize: "9px",
        color: "#f1f5f9",
      })
      .setOrigin(0, 0.5);

    this.graveWorldHint = this.scene.add
      .container(0, 0, [shadow, card, keyBg, keyTxt, label])
      .setDepth(40_000)
      .setVisible(false);
  }

  private positionGravePrompt() {
    positionBottomPrompt(this.scene, this.gravePrompt, 210);
  }

  private positionGravePanel() {
    positionCenteredPanel(
      this.scene,
      this.gravePanel,
      this.graveCloseHit,
      162,
      -57,
    );
  }

  private findNearbyGravestone(): GraveNote | null {
    const maxSq = GRAVE_READ_RANGE_PX * GRAVE_READ_RANGE_PX;
    const nearest = this.findNearestGravestone();
    if (!nearest) return null;
    return nearest.sq <= maxSq ? nearest.note : null;
  }

  private findNearestGravestone(): {
    note: GraveNote;
    sq: number;
    wx: number;
    wy: number;
  } | null {
    const nearest = findNearestPoint(this.graveNotes, this.getPlayerWorldPosition());
    if (!nearest) return null;
    return {
      note: nearest.item,
      sq: nearest.sq,
      wx: nearest.item.x,
      wy: nearest.item.y,
    };
  }

  private showGravePanel(note: GraveNote) {
    this.activeGraveIid = note.iid;
    this.onPanelOpen?.();
    const text = [note.headline, note.subline].filter(Boolean).join("\n");
    this.gravePanelTitle.setText("Gravestone");
    this.gravePanelBody.setText(text);
    this.positionGravePanel();
    this.gravePanel.setVisible(true);
    if (this.graveCloseHit) this.graveCloseHit.setVisible(true);
  }

  private hideGravePanel() {
    this.activeGraveIid = null;
    this.gravePanel.setVisible(false);
    if (this.graveCloseHit) this.graveCloseHit.setVisible(false);
    if (this.graveWorldHint) this.graveWorldHint.setVisible(false);
  }
}
