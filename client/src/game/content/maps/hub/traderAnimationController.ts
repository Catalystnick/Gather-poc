import type Phaser from "phaser";
import type { LdtkEntityInstance } from "../../../../types/mapTypes";

const TRADER_IDLE_FRAME_SECONDS = 0.24;
const TRADER_STRIP_FRAME_STEP_PX = 128;
const TRADER_SET_TRANSITION_HOLD_FRAMES = 3;

type TileRect = NonNullable<LdtkEntityInstance["__tile"]>;

interface TraderFrame {
  textureKey: string;
  srcOffsetX: number;
}

interface AnimatedTraderRender {
  iid: string;
  renderTexture: Phaser.GameObjects.RenderTexture;
  tileRect: TileRect;
  scale: number;
  idleFrames: TraderFrame[];
  dialogFrames: TraderFrame[];
  frames: TraderFrame[];
  frameCursor: number;
}

interface RegisterTraderParams {
  iid: string;
  renderTexture: Phaser.GameObjects.RenderTexture;
  tileRect: TileRect;
  scale: number;
  idleTextureKeys: [string, string, string];
  dialogTextureKey: string | null;
}

interface TraderAnimationControllerOptions {
  getTextureWidth: (textureKey: string) => number;
  redraw: (
    renderTexture: Phaser.GameObjects.RenderTexture,
    textureKey: string,
    tileRect: TileRect,
    scale: number,
    srcOffsetX?: number,
  ) => void;
}

export function getTraderIdleTextureKeys(
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

export function getTraderDialogTextureKey(entityIdentifier: string): string | null {
  if (entityIdentifier === "Dev_trader") return "ts-dev-trader";
  if (entityIdentifier === "Design_trader") return "ts-design-trader";
  if (entityIdentifier === "Game_trader") return "ts-game-trader";
  return null;
}

/** Owns trader idle/dialog frame sequencing and render-texture swaps. */
export class TraderAnimationController {
  private renders: AnimatedTraderRender[] = [];
  private timer = 0;
  private getTextureWidth: (textureKey: string) => number;
  private redraw: TraderAnimationControllerOptions["redraw"];

  constructor(options: TraderAnimationControllerOptions) {
    this.getTextureWidth = options.getTextureWidth;
    this.redraw = options.redraw;
  }

  /** Reset all tracked trader renders (call on scene create). */
  clear() {
    this.renders = [];
    this.timer = 0;
  }

  /** Register one trader render and prime first idle frame. */
  registerTrader(params: RegisterTraderParams) {
    const idleFrames = this.buildStripFrames(params.idleTextureKeys, params.tileRect);
    if (idleFrames.length === 0) return false;
    const dialogFrames = params.dialogTextureKey
      ? this.buildStripFrames([params.dialogTextureKey], params.tileRect)
      : [];

    const firstFrame = idleFrames[0];
    this.redraw(
      params.renderTexture,
      firstFrame.textureKey,
      params.tileRect,
      params.scale,
      firstFrame.srcOffsetX,
    );

    this.renders.push({
      iid: params.iid,
      renderTexture: params.renderTexture,
      tileRect: params.tileRect,
      scale: params.scale,
      idleFrames,
      dialogFrames,
      frames: idleFrames,
      frameCursor: 0,
    });
    return true;
  }

  /** Step trader animations with fixed frame cadence. */
  update(dt: number) {
    if (this.renders.length === 0) return;
    this.timer += dt;
    if (this.timer < TRADER_IDLE_FRAME_SECONDS) return;
    this.timer = 0;

    for (const trader of this.renders) {
      if (trader.frames.length === 0) continue;
      trader.frameCursor = (trader.frameCursor + 1) % trader.frames.length;
      const frame = trader.frames[trader.frameCursor];
      this.redraw(
        trader.renderTexture,
        frame.textureKey,
        trader.tileRect,
        trader.scale,
        frame.srcOffsetX,
      );
    }
  }

  /** Switch one trader to dialog animation sequence. */
  activateDialog(traderIid: string) {
    for (const trader of this.renders) {
      if (trader.iid !== traderIid) continue;
      if (trader.dialogFrames.length === 0) return;
      trader.frames = trader.dialogFrames;
      trader.frameCursor = 0;
      const frame = trader.frames[0];
      this.redraw(
        trader.renderTexture,
        frame.textureKey,
        trader.tileRect,
        trader.scale,
        frame.srcOffsetX,
      );
      return;
    }
  }

  /** Return all traders back to idle loops. */
  resetIdle() {
    for (const trader of this.renders) {
      trader.frames = trader.idleFrames;
      trader.frameCursor = 0;
      const frame = trader.frames[0];
      if (!frame) continue;
      this.redraw(
        trader.renderTexture,
        frame.textureKey,
        trader.tileRect,
        trader.scale,
        frame.srcOffsetX,
      );
    }
  }

  /** Build flattened frame sequence from strip sheets. */
  private buildStripFrames(textureKeys: string[], tileRect: TileRect) {
    const frames: TraderFrame[] = [];
    for (let textureIndex = 0; textureIndex < textureKeys.length; textureIndex++) {
      const textureKey = textureKeys[textureIndex];
      const sourceWidth = this.getTextureWidth(textureKey);
      if (!sourceWidth) continue;

      const setFrames: TraderFrame[] = [];
      let srcX = tileRect.x;
      while (srcX + tileRect.w <= sourceWidth) {
        setFrames.push({ textureKey, srcOffsetX: srcX - tileRect.x });
        srcX += TRADER_STRIP_FRAME_STEP_PX;
      }
      if (setFrames.length === 0) continue;
      frames.push(...setFrames);

      if (textureIndex < textureKeys.length - 1) {
        const holdFrame = setFrames[setFrames.length - 1];
        for (
          let holdIndex = 0;
          holdIndex < TRADER_SET_TRANSITION_HOLD_FRAMES;
          holdIndex++
        ) {
          frames.push(holdFrame);
        }
      }
    }
    return frames;
  }
}
