import Phaser from "phaser";

type PromptStyle = Phaser.Types.GameObjects.Text.TextStyle;

interface BottomPromptOptions {
  cameraZoom: number;
  text: string;
  style: PromptStyle;
  depth?: number;
}

interface CloseHitOptions {
  cameraZoom: number;
  depth: number;
  onClose: () => void;
}

interface PanelCloseAreaOptions {
  panel: Phaser.GameObjects.Container;
  panelWidth: number;
  panelHeight: number;
  onClose: () => void;
}

/** Creates a fixed-screen prompt text element shared by interactions. */
export function createBottomPrompt(
  scene: Phaser.Scene,
  options: BottomPromptOptions,
) {
  const promptDepth = options.depth ?? 49_999;
  return scene.add
    .text(0, 0, options.text, options.style)
    .setOrigin(0.5, 0.5)
    .setDepth(promptDepth)
    .setScrollFactor(0)
    .setScale(1 / options.cameraZoom)
    .setVisible(false);
}

/** Anchors a fixed-screen prompt near the lower center of the viewport. */
export function positionBottomPrompt(
  scene: Phaser.Scene,
  prompt: Phaser.GameObjects.Text,
  bottomOffsetPx = 210,
) {
  prompt.setPosition(scene.scale.width / 2, scene.scale.height - bottomOffsetPx);
}

/** Creates a transparent top-layer hit target for reliable close taps/clicks. */
export function createCloseHit(
  scene: Phaser.Scene,
  options: CloseHitOptions,
): Phaser.GameObjects.Arc {
  const closeHit = scene.add
    .circle(0, 0, 18, 0x000000, 0.001)
    .setDepth(options.depth)
    .setScrollFactor(0)
    .setScale(1 / options.cameraZoom)
    .setInteractive({ useHandCursor: true })
    .setVisible(false);
  closeHit.on("pointerdown", options.onClose);
  return closeHit;
}

/** Adds panel-local pointer hit testing for the top-right close button area. */
export function wirePanelCornerClose(options: PanelCloseAreaOptions) {
  const { panel, panelWidth, panelHeight, onClose } = options;
  panel.setSize(panelWidth, panelHeight);
  panel.setInteractive(
    new Phaser.Geom.Rectangle(
      -panelWidth / 2,
      -panelHeight / 2,
      panelWidth,
      panelHeight,
    ),
    Phaser.Geom.Rectangle.Contains,
  );
  panel.on(
    "pointerdown",
    (_pointer: Phaser.Input.Pointer, localX: number, localY: number) => {
      if (
        localX >= panelWidth / 2 - 39 &&
        localX <= panelWidth / 2 - 2 &&
        localY >= -panelHeight / 2 + 2 &&
        localY <= -panelHeight / 2 + 39
      ) {
        onClose();
      }
    },
  );
}

/** Positions a panel in screen center and keeps close-hit in sync with panel scale. */
export function positionCenteredPanel(
  scene: Phaser.Scene,
  panel: Phaser.GameObjects.Container,
  closeHit: Phaser.GameObjects.Arc | undefined,
  closeOffsetXPx: number,
  closeOffsetYPx: number,
) {
  const panelX = scene.scale.width / 2;
  const panelY = scene.scale.height / 2;
  panel.setPosition(panelX, panelY);

  if (!closeHit) return;
  const scale = panel.scaleX;
  closeHit.setPosition(
    panelX + closeOffsetXPx * scale,
    panelY + closeOffsetYPx * scale,
  );
}
