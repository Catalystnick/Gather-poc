import type Phaser from "phaser";
import GameBridge, { type MoveState } from "../GameBridge";
import { getZoneKey } from "../../utils/zoneDetection";
import type { Direction } from "../../types";
import {
  IDLE_FPS,
  IDLE_FRAMES,
  TILE_PX,
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

/** Owns local movement, collision checks, camera-reset trigger, and animation stepping. */
export class LocalMovementController {
  private static readonly MOVE_SPEED_PX_PER_SECOND = TILE_PX * 4.6;
  private static readonly MAX_SIMULATION_STEP_SECONDS = 0.05;

  private getContainer: () => Phaser.GameObjects.Container;
  private setAvatarFrame: (frame: number) => void;
  private resetCameraFollowToPlayer: () => void;

  private worldX = 0;
  private worldY = 0;
  private gridCol = 0;
  private gridRow = 0;
  private previousGridCol = 0;
  private previousGridRow = 0;
  private dir: Direction = "down";
  private isMoving = false;
  private wasMovingLastFrame = false;
  private lastSentDirection: Direction = "down";
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
    this.gridCol = col;
    this.gridRow = row;
    this.previousGridCol = col;
    this.previousGridRow = row;

    const world = tileCenter(col, row);
    this.worldX = world.x;
    this.worldY = world.y;

    const container = this.getContainer();
    container.x = this.worldX;
    container.y = this.worldY;

    this.wasMovingLastFrame = false;
    this.lastSentDirection = this.dir;

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

    this.gridCol = spawn.col;
    this.gridRow = spawn.row;
    this.previousGridCol = spawn.col;
    this.previousGridRow = spawn.row;
    this.isMoving = false;

    const world = tileCenter(spawn.col, spawn.row);
    this.worldX = world.x;
    this.worldY = world.y;
    const container = this.getContainer();
    container.x = this.worldX;
    container.y = this.worldY;

    this.wasMovingLastFrame = false;
    this.lastSentDirection = this.dir;

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
    if (tag === "INPUT" || tag === "TEXTAREA") {
      this.isMoving = false;
      this.emitNetworkMoveIfNeeded();
      this.updateLocalAnimation(dt);
      return;
    }

    const clampedDt = Math.min(
      dt,
      LocalMovementController.MAX_SIMULATION_STEP_SECONDS,
    );

    const upPressed = input.cursors.up.isDown || input.wKey.isDown;
    const downPressed = input.cursors.down.isDown || input.sKey.isDown;
    const leftPressed = input.cursors.left.isDown || input.aKey.isDown;
    const rightPressed = input.cursors.right.isDown || input.dKey.isDown;

    let moveX =
      (rightPressed ? 1 : 0) - (leftPressed ? 1 : 0);
    let moveY =
      (downPressed ? 1 : 0) - (upPressed ? 1 : 0);

    if (moveX !== 0 || moveY !== 0) {
      this.resetCameraFollowToPlayer();
      const vectorLength = Math.hypot(moveX, moveY);
      moveX /= vectorLength;
      moveY /= vectorLength;
      this.dir = this.resolveFacingDirection(moveX, moveY);
    }

    this.simulateFreeMovement(moveX, moveY, clampedDt);
    this.refreshGridPositionFromWorld();
    this.emitNetworkMoveIfNeeded();
    GameBridge.positionRef.current = { x: this.gridCol, y: this.gridRow, z: 0 };
    this.updateLocalAnimation(dt);
  }

  /** Convert input vector into one of our 4-direction sprite facings. */
  private resolveFacingDirection(moveX: number, moveY: number): Direction {
    if (Math.abs(moveX) > Math.abs(moveY)) {
      return moveX > 0 ? "right" : "left";
    }
    return moveY > 0 ? "down" : "up";
  }

  /** Apply smooth per-frame movement with axis-separated collision checks. */
  private simulateFreeMovement(moveX: number, moveY: number, dt: number) {
    const startWorldX = this.worldX;
    const startWorldY = this.worldY;
    const speed = LocalMovementController.MOVE_SPEED_PX_PER_SECOND;
    const deltaX = moveX * speed * dt;
    const deltaY = moveY * speed * dt;
    let nextWorldX = this.worldX;
    let nextWorldY = this.worldY;

    if (deltaX !== 0) {
      const candidateX = this.worldX + deltaX;
      if (this.canOccupyWorld(candidateX, this.worldY)) {
        nextWorldX = candidateX;
      }
    }
    if (deltaY !== 0) {
      const candidateY = this.worldY + deltaY;
      if (this.canOccupyWorld(nextWorldX, candidateY)) {
        nextWorldY = candidateY;
      }
    }

    this.worldX = nextWorldX;
    this.worldY = nextWorldY;
    const container = this.getContainer();
    container.x = this.worldX;
    container.y = this.worldY;
    this.isMoving =
      Math.abs(this.worldX - startWorldX) > 0.0001 ||
      Math.abs(this.worldY - startWorldY) > 0.0001;
  }

  /** Refresh current tile coordinates from pixel world position. */
  private refreshGridPositionFromWorld() {
    this.previousGridCol = this.gridCol;
    this.previousGridRow = this.gridRow;
    this.gridCol = Math.floor(this.worldX / TILE_PX);
    this.gridRow = Math.floor(this.worldY / TILE_PX);
  }

  /** Check if the avatar feet point can occupy a world-space pixel position. */
  private canOccupyWorld(worldX: number, worldY: number) {
    const mapData = GameBridge.mapData;
    if (!mapData) return false;
    const col = Math.floor(worldX / TILE_PX);
    const row = Math.floor(worldY / TILE_PX);
    if (col < 0 || col >= mapData.gridWidth || row < 0 || row >= mapData.gridHeight) {
      return false;
    }
    return mapData.collisionCsv[row * mapData.gridWidth + col] === 0;
  }

  /** Emit server movement only on tile changes, movement stop, or direction changes. */
  private emitNetworkMoveIfNeeded() {
    const tileChanged =
      this.gridCol !== this.previousGridCol || this.gridRow !== this.previousGridRow;
    const stoppedMoving = this.wasMovingLastFrame && !this.isMoving;
    const directionChanged = this.lastSentDirection !== this.dir;
    if (!tileChanged && !stoppedMoving && !directionChanged) {
      this.wasMovingLastFrame = this.isMoving;
      return;
    }
    this.emitMove(this.isMoving);
    this.lastSentDirection = this.dir;
    this.wasMovingLastFrame = this.isMoving;
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

  private emitMove(moving: boolean) {
    const mapData = GameBridge.mapData;
    if (!mapData) return;
    const state: MoveState = {
      col: this.gridCol,
      row: this.gridRow,
      direction: this.dir,
      moving,
      zoneKey: getZoneKey(this.gridCol, this.gridRow, mapData.zones),
    };
    GameBridge.onPlayerMove?.(state);
  }
}
