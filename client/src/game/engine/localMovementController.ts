import type Phaser from "phaser";
import GameBridge from "../GameBridge";
import type { Direction, PlayerInputState } from "../../types";
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

interface PendingInput extends PlayerInputState {
  sentAtMs: number;
}

interface LocalMovementControllerOptions {
  getContainer: () => Phaser.GameObjects.Container;
  setAvatarFrame: (frame: number) => void;
  resetCameraFollowToPlayer: () => void;
}

/** Owns local movement prediction, reconciliation, animation stepping, and input send cadence. */
export class LocalMovementController {
  private static readonly MOVE_SPEED_PX_PER_SECOND = TILE_PX * 4.6;
  private static readonly MAX_SIMULATION_STEP_SECONDS = 0.05;
  private static readonly INPUT_SEND_INTERVAL_MS = Math.floor(1000 / 30);
  private static readonly INPUT_IDLE_HEARTBEAT_MS = 120;
  private static readonly MAX_PENDING_INPUTS = 120;
  private static readonly RECONCILE_IGNORE_DISTANCE_PX = 1;
  private static readonly RECONCILE_SNAP_DISTANCE_PX = 12;
  private static readonly CORRECTION_BLEND_SECONDS = 0.1;

  private getContainer: () => Phaser.GameObjects.Container;
  private setAvatarFrame: (frame: number) => void;
  private resetCameraFollowToPlayer: () => void;

  private worldX = 0;
  private worldY = 0;
  private dir: Direction = "down";
  private isMoving = false;
  private animFrame = 0;
  private animTimer = 0;
  private prevAnimMoving = false;
  private prevAnimDir: Direction = "down";
  private serverSpawnApplied = false;

  private inputSeq = 0;
  private pendingInputs: PendingInput[] = [];
  private lastInputEmitAtMs = 0;
  private lastSentInputX = 0;
  private lastSentInputY = 0;
  private lastSentMoving = false;
  private lastSentFacing: Direction = "down";

  private lastReconciledServerTimeMs = 0;
  private lastReconciledSeq = -1;

  private correctionRemainingX = 0;
  private correctionRemainingY = 0;
  private correctionTimeLeftSeconds = 0;

  constructor(options: LocalMovementControllerOptions) {
    this.getContainer = options.getContainer;
    this.setAvatarFrame = options.setAvatarFrame;
    this.resetCameraFollowToPlayer = options.resetCameraFollowToPlayer;
  }

  /** Set initial authoritative or fallback spawn for local movement state. */
  applySpawn(col: number, row: number, serverSpawnApplied: boolean) {
    this.serverSpawnApplied = serverSpawnApplied;
    const world = tileCenter(col, row);
    this.worldX = world.x;
    this.worldY = world.y;

    const container = this.getContainer();
    container.x = this.worldX;
    container.y = this.worldY;

    this.inputSeq = 0;
    this.pendingInputs = [];
    this.lastInputEmitAtMs = 0;
    this.lastSentInputX = 0;
    this.lastSentInputY = 0;
    this.lastSentMoving = false;
    this.lastSentFacing = this.dir;
    this.lastReconciledServerTimeMs = 0;
    this.lastReconciledSeq = -1;
    this.correctionRemainingX = 0;
    this.correctionRemainingY = 0;
    this.correctionTimeLeftSeconds = 0;

    GameBridge.positionRef.current = {
      x: this.worldX / TILE_PX,
      y: this.worldY / TILE_PX,
      z: 0,
    };
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
    this.applySpawn(spawn.col, spawn.row, true);
  }

  /** Advance local movement, prediction, reconciliation, and animation by one frame. */
  update(dt: number, input: LocalMovementInput) {
    if (!this.serverSpawnApplied) {
      this.updateLocalAnimation(dt);
      return;
    }

    this.reconcileFromAuthoritativeState();

    const clampedDt = Math.min(
      dt,
      LocalMovementController.MAX_SIMULATION_STEP_SECONDS,
    );

    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      this.isMoving = false;
      this.applySmoothingCorrection(clampedDt);
      this.emitInputIfNeeded(0, 0, false);
      this.updateVisualPosition();
      this.updateLocalAnimation(dt);
      return;
    }

    const upPressed = input.cursors.up.isDown || input.wKey.isDown;
    const downPressed = input.cursors.down.isDown || input.sKey.isDown;
    const leftPressed = input.cursors.left.isDown || input.aKey.isDown;
    const rightPressed = input.cursors.right.isDown || input.dKey.isDown;

    let inputX = (rightPressed ? 1 : 0) - (leftPressed ? 1 : 0);
    let inputY = (downPressed ? 1 : 0) - (upPressed ? 1 : 0);

    if (inputX !== 0 || inputY !== 0) {
      this.resetCameraFollowToPlayer();
      const vectorLength = Math.hypot(inputX, inputY);
      inputX /= vectorLength;
      inputY /= vectorLength;
      this.dir = this.resolveFacingDirection(inputX, inputY);
    }

    this.simulateFreeMovement(inputX, inputY, clampedDt);
    this.applySmoothingCorrection(clampedDt);
    this.emitInputIfNeeded(inputX, inputY, inputX !== 0 || inputY !== 0);
    this.updateVisualPosition();
    this.updateLocalAnimation(dt);
  }

  /** Convert input vector into one of our 4-direction sprite facings. */
  private resolveFacingDirection(moveX: number, moveY: number): Direction {
    if (Math.abs(moveX) >= Math.abs(moveY)) {
      return moveX > 0 ? "right" : "left";
    }
    return moveY > 0 ? "down" : "up";
  }

  /** Apply smooth per-frame movement prediction with axis-separated collision checks. */
  private simulateFreeMovement(moveX: number, moveY: number, dt: number) {
    const startWorldX = this.worldX;
    const startWorldY = this.worldY;
    const next = this.integrateMovement(
      this.worldX,
      this.worldY,
      moveX,
      moveY,
      dt,
    );
    this.worldX = next.x;
    this.worldY = next.y;
    this.isMoving =
      Math.abs(this.worldX - startWorldX) > 0.0001 ||
      Math.abs(this.worldY - startWorldY) > 0.0001;
  }

  /** Apply soft reconciliation correction over 100ms for medium prediction error. */
  private applySmoothingCorrection(dt: number) {
    if (this.correctionTimeLeftSeconds <= 0) return;
    const ratio = Math.min(1, dt / this.correctionTimeLeftSeconds);
    this.worldX += this.correctionRemainingX * ratio;
    this.worldY += this.correctionRemainingY * ratio;
    this.correctionRemainingX *= (1 - ratio);
    this.correctionRemainingY *= (1 - ratio);
    this.correctionTimeLeftSeconds = Math.max(
      0,
      this.correctionTimeLeftSeconds - dt,
    );

    if (this.correctionTimeLeftSeconds === 0) {
      this.correctionRemainingX = 0;
      this.correctionRemainingY = 0;
    }
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

  private integrateMovement(
    baseX: number,
    baseY: number,
    moveX: number,
    moveY: number,
    dt: number,
  ) {
    const speed = LocalMovementController.MOVE_SPEED_PX_PER_SECOND;
    const deltaX = moveX * speed * dt;
    const deltaY = moveY * speed * dt;
    let nextWorldX = baseX;
    let nextWorldY = baseY;

    if (deltaX !== 0) {
      const candidateX = baseX + deltaX;
      if (this.canOccupyWorld(candidateX, baseY)) nextWorldX = candidateX;
    }
    if (deltaY !== 0) {
      const candidateY = baseY + deltaY;
      if (this.canOccupyWorld(nextWorldX, candidateY)) nextWorldY = candidateY;
    }

    return { x: nextWorldX, y: nextWorldY };
  }

  /** Emit input at 30Hz while moving, with idle heartbeat and immediate direction/state changes. */
  private emitInputIfNeeded(inputX: number, inputY: number, moving: boolean) {
    const now = Date.now();
    const inputChanged =
      Math.abs(inputX - this.lastSentInputX) > 0.0001 ||
      Math.abs(inputY - this.lastSentInputY) > 0.0001 ||
      moving !== this.lastSentMoving ||
      this.dir !== this.lastSentFacing;

    const minInterval = moving
      ? LocalMovementController.INPUT_SEND_INTERVAL_MS
      : LocalMovementController.INPUT_IDLE_HEARTBEAT_MS;

    if (!inputChanged && now - this.lastInputEmitAtMs < minInterval) return;

    const state: PlayerInputState = {
      seq: ++this.inputSeq,
      inputX,
      inputY,
      facing: this.dir,
      moving,
      clientTimeMs: now,
    };

    this.pendingInputs.push({ ...state, sentAtMs: now });
    if (this.pendingInputs.length > LocalMovementController.MAX_PENDING_INPUTS) {
      this.pendingInputs.splice(
        0,
        this.pendingInputs.length - LocalMovementController.MAX_PENDING_INPUTS,
      );
    }

    GameBridge.onPlayerInput?.(state);
    this.lastSentInputX = inputX;
    this.lastSentInputY = inputY;
    this.lastSentMoving = moving;
    this.lastSentFacing = this.dir;
    this.lastInputEmitAtMs = now;
  }

  /** Apply authoritative snapshot ack, drop processed inputs, and replay remaining pending inputs. */
  private reconcileFromAuthoritativeState() {
    const authoritative = GameBridge.localAuthoritativeState;
    if (!authoritative) return;

    const serverTimeMs = authoritative.serverTimeMs ?? 0;
    const ackSeq = authoritative.lastProcessedInputSeq ?? -1;
    const isNewerSnapshot =
      serverTimeMs > this.lastReconciledServerTimeMs || ackSeq > this.lastReconciledSeq;
    if (!isNewerSnapshot) return;

    this.lastReconciledServerTimeMs = Math.max(
      this.lastReconciledServerTimeMs,
      serverTimeMs,
    );
    this.lastReconciledSeq = Math.max(this.lastReconciledSeq, ackSeq);

    this.pendingInputs = this.pendingInputs.filter(
      (pending) => pending.seq > ackSeq,
    );

    const corrected = this.replayFromAuthoritative(
      authoritative.x,
      authoritative.y,
      this.pendingInputs,
    );

    this.dir = authoritative.facing;
    const dist = Math.hypot(corrected.x - this.worldX, corrected.y - this.worldY);
    if (dist < LocalMovementController.RECONCILE_IGNORE_DISTANCE_PX) return;

    if (dist > LocalMovementController.RECONCILE_SNAP_DISTANCE_PX) {
      this.worldX = corrected.x;
      this.worldY = corrected.y;
      this.correctionRemainingX = 0;
      this.correctionRemainingY = 0;
      this.correctionTimeLeftSeconds = 0;
      return;
    }

    this.correctionRemainingX = corrected.x - this.worldX;
    this.correctionRemainingY = corrected.y - this.worldY;
    this.correctionTimeLeftSeconds = LocalMovementController.CORRECTION_BLEND_SECONDS;
  }

  private replayFromAuthoritative(
    startX: number,
    startY: number,
    pendingInputs: PendingInput[],
  ) {
    let replayX = startX;
    let replayY = startY;
    const now = Date.now();

    for (let idx = 0; idx < pendingInputs.length; idx++) {
      const input = pendingInputs[idx];
      const nextSentAt = pendingInputs[idx + 1]?.sentAtMs ?? now;
      const dt = Math.min(
        LocalMovementController.MAX_SIMULATION_STEP_SECONDS,
        Math.max(0, (nextSentAt - input.sentAtMs) / 1000),
      );
      if (dt <= 0) continue;

      const next = this.integrateMovement(
        replayX,
        replayY,
        input.moving ? input.inputX : 0,
        input.moving ? input.inputY : 0,
        dt,
      );
      replayX = next.x;
      replayY = next.y;
    }

    return { x: replayX, y: replayY };
  }

  private updateVisualPosition() {
    const container = this.getContainer();
    container.x = this.worldX;
    container.y = this.worldY;
    GameBridge.positionRef.current = {
      x: this.worldX / TILE_PX,
      y: this.worldY / TILE_PX,
      z: 0,
    };
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
}
