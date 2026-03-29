import type Phaser from "phaser";
import GameBridge, { type MoveState } from "../GameBridge";
import { getZoneKey } from "../../utils/zoneDetection";
import type { Direction } from "../../types";
import {
  HOLD_DELAY,
  IDLE_FPS,
  IDLE_FRAMES,
  STEP_INT,
  TWEEN_DUR,
  WALK_FPS,
  WALK_FRAMES,
  tileCenter,
} from "./constants";

interface LocalMovementInput {
  cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  wKey: Phaser.Input.Keyboard.Key;
  sKey: Phaser.Input.Keyboard.Key;
  aKey: Phaser.Input.Keyboard.Key;
  dKey: Phaser.Input.Keyboard.Key;
}

interface LocalMovementControllerOptions {
  getContainer: () => Phaser.GameObjects.Container;
  setAvatarFrame: (frame: number) => void;
  resetCameraFollowToPlayer: () => void;
}

/** Owns local grid movement, tweening, camera-reset trigger, and animation stepping. */
export class LocalMovementController {
  private getContainer: () => Phaser.GameObjects.Container;
  private setAvatarFrame: (frame: number) => void;
  private resetCameraFollowToPlayer: () => void;

  private gridCol = 30;
  private gridRow = 30;
  private isTween = false;
  private tweenProg = 0;
  private tweenFX = 0;
  private tweenFY = 0;
  private tweenTX = 0;
  private tweenTY = 0;
  private tweenTC = 30;
  private tweenTR = 30;
  private tweenLin = false;
  private dir: Direction = "down";
  private isMoving = false;
  private prevActive: Direction | null = null;
  private justPress = false;
  private holdTimer = 0;
  private stepAcc = 0;
  private bufDir: Direction | null = null;
  private prevKeys = { up: false, down: false, left: false, right: false };
  private lastKey: Direction | null = null;
  private animFrame = 0;
  private animTimer = 0;
  private prevAnimMoving = false;
  private prevAnimDir: Direction = "down";
  private serverSpawnApplied = false;

  constructor(options: LocalMovementControllerOptions) {
    this.getContainer = options.getContainer;
    this.setAvatarFrame = options.setAvatarFrame;
    this.resetCameraFollowToPlayer = options.resetCameraFollowToPlayer;
  }

  /** Set initial authoritative or fallback spawn for local movement state. */
  applySpawn(col: number, row: number, serverSpawnApplied: boolean) {
    this.serverSpawnApplied = serverSpawnApplied;
    this.gridCol = this.tweenTC = col;
    this.gridRow = this.tweenTR = row;

    const world = tileCenter(col, row);
    this.tweenFX = this.tweenTX = world.x;
    this.tweenFY = this.tweenTY = world.y;

    const container = this.getContainer();
    container.x = world.x;
    container.y = world.y;

    GameBridge.positionRef.current = { x: col, y: row, z: 0 };
  }

  /** Allow scene to reset spawn-applied state when server spawn is absent. */
  setServerSpawnApplied(applied: boolean) {
    this.serverSpawnApplied = applied;
  }

  /** Snap to authoritative spawn once server spawn arrives. */
  reconcileServerSpawnIfNeeded() {
    if (this.serverSpawnApplied) return;
    const spawn = GameBridge.serverSpawn;
    if (!spawn) return;

    this.gridCol = this.tweenTC = spawn.col;
    this.gridRow = this.tweenTR = spawn.row;
    this.isTween = false;
    this.isMoving = false;
    this.tweenProg = 0;
    this.bufDir = null;

    const world = tileCenter(spawn.col, spawn.row);
    this.tweenFX = this.tweenTX = world.x;
    this.tweenFY = this.tweenTY = world.y;
    const container = this.getContainer();
    container.x = world.x;
    container.y = world.y;

    GameBridge.positionRef.current = { x: spawn.col, y: spawn.row, z: 0 };
    this.serverSpawnApplied = true;
  }

  /** Advance local movement + animation by one frame. */
  update(dt: number, input: LocalMovementInput) {
    if (!this.serverSpawnApplied) {
      this.updateLocalAnimation(dt);
      return;
    }

    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    const up = input.cursors.up.isDown || input.wKey.isDown;
    const down = input.cursors.down.isDown || input.sKey.isDown;
    const left = input.cursors.left.isDown || input.aKey.isDown;
    const right = input.cursors.right.isDown || input.dKey.isDown;

    if (!this.prevKeys.up && up) this.lastKey = "up";
    if (!this.prevKeys.down && down) this.lastKey = "down";
    if (!this.prevKeys.left && left) this.lastKey = "left";
    if (!this.prevKeys.right && right) this.lastKey = "right";
    this.prevKeys = { up, down, left, right };

    const held = (up ? 1 : 0) + (down ? 1 : 0) + (left ? 1 : 0) + (right ? 1 : 0);
    const lastKey = this.lastKey;
    const lastKeyHeld =
      (lastKey === "up" && up) ||
      (lastKey === "down" && down) ||
      (lastKey === "left" && left) ||
      (lastKey === "right" && right);
    if (held === 0) this.lastKey = null;

    const activeDir: Direction | null =
      held === 0
        ? null
        : lastKeyHeld
          ? lastKey
          : up
            ? "up"
            : down
              ? "down"
              : left
                ? "left"
                : "right";

    if (activeDir !== this.prevActive) {
      this.prevActive = activeDir;
      this.holdTimer = 0;
      this.stepAcc = 0;
      this.justPress = activeDir !== null;
      if (activeDir !== null) this.dir = activeDir;
    }

    if (activeDir !== null) this.resetCameraFollowToPlayer();
    if (this.isTween && activeDir !== null) this.bufDir = activeDir;

    if (this.isTween) {
      this.tweenProg += dt / TWEEN_DUR;
      const container = this.getContainer();
      if (this.tweenProg >= 1) {
        this.tweenProg = 1;
        this.isTween = false;
        this.isMoving = false;
        this.gridCol = this.tweenTC;
        this.gridRow = this.tweenTR;
        const world = tileCenter(this.gridCol, this.gridRow);
        container.x = world.x;
        container.y = world.y;
        this.emitMove(false);

        const bufferedDirection = this.bufDir;
        this.bufDir = null;
        if (bufferedDirection !== null && bufferedDirection === this.prevActive) {
          this.step(bufferedDirection, true);
        }
      } else {
        const tweenProgress = this.tweenProg;
        const easingFactor = this.tweenLin
          ? tweenProgress
          : tweenProgress * tweenProgress * (3 - 2 * tweenProgress);
        container.x = this.tweenFX + (this.tweenTX - this.tweenFX) * easingFactor;
        container.y = this.tweenFY + (this.tweenTY - this.tweenFY) * easingFactor;
      }
    } else if (activeDir !== null) {
      this.holdTimer += dt;
      if (this.justPress) {
        this.justPress = false;
        this.step(activeDir, false);
      } else if (this.holdTimer >= HOLD_DELAY) {
        this.stepAcc += dt;
        if (this.stepAcc >= STEP_INT) {
          this.stepAcc -= STEP_INT;
          this.step(activeDir, true);
        }
      }
    } else {
      this.stepAcc = 0;
    }

    GameBridge.positionRef.current = { x: this.gridCol, y: this.gridRow, z: 0 };
    this.updateLocalAnimation(dt);
  }

  private updateLocalAnimation(dt: number) {
    if (this.prevAnimMoving !== this.isMoving || this.prevAnimDir !== this.dir) {
      this.animFrame = 0;
      this.animTimer = 0;
      this.prevAnimMoving = this.isMoving;
      this.prevAnimDir = this.dir;
    }

    if (this.isMoving) {
      const frames = WALK_FRAMES[this.dir];
      this.animTimer += dt;
      const frameStep = 1 / WALK_FPS;
      while (this.animTimer >= frameStep) {
        this.animTimer -= frameStep;
        this.animFrame = (this.animFrame + 1) % frames.length;
      }
      this.setAvatarFrame(frames[this.animFrame]);
      return;
    }

    const frames = IDLE_FRAMES[this.dir];
    this.animTimer += dt;
    const frameStep = 1 / IDLE_FPS;
    while (this.animTimer >= frameStep) {
      this.animTimer -= frameStep;
      this.animFrame = (this.animFrame + 1) % frames.length;
    }
    this.setAvatarFrame(frames[this.animFrame]);
  }

  private canMove(col: number, row: number, direction: Direction): boolean {
    const mapData = GameBridge.mapData;
    if (!mapData) return false;
    const { collisionCsv, gridWidth, gridHeight } = mapData;
    const deltaCol = direction === "right" ? 1 : direction === "left" ? -1 : 0;
    const deltaRow = direction === "down" ? 1 : direction === "up" ? -1 : 0;
    const targetCol = col + deltaCol;
    const targetRow = row + deltaRow;
    if (targetCol < 0 || targetCol >= gridWidth || targetRow < 0 || targetRow >= gridHeight) {
      return false;
    }
    return collisionCsv[targetRow * gridWidth + targetCol] === 0;
  }

  private step(direction: Direction, chained: boolean) {
    if (!this.canMove(this.gridCol, this.gridRow, direction)) return;

    const deltaCol = direction === "right" ? 1 : direction === "left" ? -1 : 0;
    const deltaRow = direction === "down" ? 1 : direction === "up" ? -1 : 0;
    const targetCol = this.gridCol + deltaCol;
    const targetRow = this.gridRow + deltaRow;
    const targetWorld = tileCenter(targetCol, targetRow);
    const container = this.getContainer();

    this.tweenFX = container.x;
    this.tweenFY = container.y;
    this.tweenTX = targetWorld.x;
    this.tweenTY = targetWorld.y;
    this.tweenTC = targetCol;
    this.tweenTR = targetRow;
    this.tweenProg = 0;
    this.tweenLin = chained;
    this.isTween = true;
    this.isMoving = true;
    this.dir = direction;

    this.emitMove(true);
  }

  private emitMove(moving: boolean) {
    const mapData = GameBridge.mapData;
    if (!mapData) return;
    const state: MoveState = {
      col: moving ? this.tweenTC : this.gridCol,
      row: moving ? this.tweenTR : this.gridRow,
      direction: this.dir,
      moving,
      zoneKey: getZoneKey(this.gridCol, this.gridRow, mapData.zones),
    };
    GameBridge.onPlayerMove?.(state);
  }
}
