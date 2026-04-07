import type Phaser from "phaser";
import type { RemotePlayer } from "../../types";
import {
  IDLE_FPS,
  IDLE_FRAMES,
  TILE_PX,
  WALK_FPS,
  WALK_FRAMES,
} from "./constants";
import {
  makeAvatarLayers,
  makeMuteIcon,
  makeNameLabel,
  setAvatarFrame,
  shirtTint,
} from "./avatarVisualFactory";
import type { RemotePlayerObject, RemoteSnapshotFrame } from "./types";

const INTERPOLATION_DELAY_MS = 100;
const MAX_EXTRAPOLATION_MS = 100;
const MAX_BUFFER_SPAN_MS = 1500;
const MOVING_EPSILON_PX_PER_SECOND = 2;

interface RemotePlayerControllerOptions {
  scene: Phaser.Scene;
}

/** Manages remote player create/update/interpolation/animation/mute/depth lifecycle. */
export class RemotePlayerController {
  private scene: Phaser.Scene;
  private remoteObjects = new Map<string, RemotePlayerObject>();

  constructor(options: RemotePlayerControllerOptions) {
    this.scene = options.scene;
  }

  /** Create or destroy remote player visuals to match current socket state. */
  sync(remotePlayers: Map<string, RemotePlayer>) {
    for (const [playerId, remoteObject] of this.remoteObjects) {
      if (!remotePlayers.has(playerId)) {
        remoteObject.container.destroy(true);
        this.remoteObjects.delete(playerId);
      }
    }

    for (const [playerId, remotePlayer] of remotePlayers) {
      if (!this.remoteObjects.has(playerId)) {
        this.addRemote(playerId, remotePlayer);
      } else {
        this.pushSnapshot(playerId, remotePlayer);
      }
    }
  }

  /** Interpolate remote players at now-100ms with short extrapolation fallback. */
  updatePositions(_dt: number) {
    const renderTimeMs = performance.now() - INTERPOLATION_DELAY_MS;
    for (const remoteObject of this.remoteObjects.values()) {
      if (remoteObject.snapshots.length === 0) continue;
      this.pruneSnapshots(remoteObject, renderTimeMs);
      const rendered = this.resolveRenderFrame(remoteObject, renderTimeMs);
      remoteObject.container.x = rendered.x;
      remoteObject.container.y = rendered.y;
      remoteObject.renderFacing = rendered.facing;
      remoteObject.renderVx = rendered.vx;
      remoteObject.renderVy = rendered.vy;
      remoteObject.renderMoving =
        Math.hypot(rendered.vx, rendered.vy) > MOVING_EPSILON_PX_PER_SECOND;
    }
  }

  /** Advance remote walk/idle animation from interpolated speed + facing. */
  updateAnimations(dt: number) {
    for (const remoteObject of this.remoteObjects.values()) {
      const animMoving = remoteObject.renderMoving;
      const animDir = remoteObject.renderFacing;

      if (
        remoteObject.prevAnimMoving !== animMoving ||
        remoteObject.prevAnimDir !== animDir
      ) {
        remoteObject.animFrame = 0;
        remoteObject.animTimer = 0;
        remoteObject.prevAnimMoving = animMoving;
        remoteObject.prevAnimDir = animDir;
      }

      if (animMoving) {
        const frames = WALK_FRAMES[animDir];
        remoteObject.animTimer += dt;
        const frameStep = 1 / WALK_FPS;
        while (remoteObject.animTimer >= frameStep) {
          remoteObject.animTimer -= frameStep;
          remoteObject.animFrame = (remoteObject.animFrame + 1) % frames.length;
        }
        setAvatarFrame(
          remoteObject.base,
          remoteObject.shoes,
          remoteObject.shirt,
          frames[remoteObject.animFrame],
        );
      } else {
        const frames = IDLE_FRAMES[animDir];
        remoteObject.animTimer += dt;
        const frameStep = 1 / IDLE_FPS;
        while (remoteObject.animTimer >= frameStep) {
          remoteObject.animTimer -= frameStep;
          remoteObject.animFrame = (remoteObject.animFrame + 1) % frames.length;
        }
        setAvatarFrame(
          remoteObject.base,
          remoteObject.shoes,
          remoteObject.shirt,
          frames[remoteObject.animFrame],
        );
      }
    }
  }

  /** Refresh remote mute icon visibility from voice state. */
  updateMuteIndicators(remotePlayers: Map<string, RemotePlayer>) {
    for (const [playerId, remoteObject] of this.remoteObjects) {
      const remotePlayer = remotePlayers.get(playerId);
      remoteObject.muteIcon.setVisible(!!remotePlayer?.muted);
    }
  }

  /** Keep remote depth sorted by feet Y for top-down occlusion. */
  updateDepths() {
    for (const remoteObject of this.remoteObjects.values()) {
      remoteObject.container.setDepth(remoteObject.container.y + TILE_PX / 2);
    }
  }

  private addRemote(playerId: string, remotePlayer: RemotePlayer) {
    const x = remotePlayer.worldX;
    const y = remotePlayer.worldY;
    const { base, shoes, shirt, label, muteIcon, setShirt } = this.makePlayerVisuals(
      remotePlayer.name,
      remotePlayer.avatar?.shirt,
    );
    const container = this.scene.add.container(x, y, [base, shoes, shirt, label, muteIcon]);

    setShirt(remotePlayer.avatar?.shirt);
    setAvatarFrame(
      base,
      shoes,
      shirt,
      IDLE_FRAMES[remotePlayer.direction]?.[0] ?? IDLE_FRAMES.down[0],
    );

    const firstSnapshot: RemoteSnapshotFrame = {
      t: remotePlayer.snapshotTimeMs,
      x: remotePlayer.worldX,
      y: remotePlayer.worldY,
      vx: remotePlayer.vx,
      vy: remotePlayer.vy,
      facing: remotePlayer.direction,
      moving: remotePlayer.moving,
    };

    this.remoteObjects.set(playerId, {
      container,
      base,
      shoes,
      shirt,
      label,
      muteIcon,
      snapshots: [firstSnapshot],
      lastSnapshotTimeMs: remotePlayer.snapshotTimeMs,
      renderFacing: remotePlayer.direction,
      renderMoving: remotePlayer.moving,
      renderVx: remotePlayer.vx,
      renderVy: remotePlayer.vy,
      animFrame: 0,
      animTimer: 0,
      prevAnimMoving: remotePlayer.moving,
      prevAnimDir: remotePlayer.direction,
    });
  }

  private pushSnapshot(playerId: string, remotePlayer: RemotePlayer) {
    const remoteObject = this.remoteObjects.get(playerId);
    if (!remoteObject) return;

    const snapshotTimeMs = remotePlayer.snapshotTimeMs;
    if (snapshotTimeMs <= remoteObject.lastSnapshotTimeMs) {
      remoteObject.shirt.setTint(shirtTint(remotePlayer.avatar?.shirt));
      return;
    }

    remoteObject.snapshots.push({
      t: snapshotTimeMs,
      x: remotePlayer.worldX,
      y: remotePlayer.worldY,
      vx: remotePlayer.vx,
      vy: remotePlayer.vy,
      facing: remotePlayer.direction,
      moving: remotePlayer.moving,
    });
    remoteObject.lastSnapshotTimeMs = snapshotTimeMs;
    remoteObject.shirt.setTint(shirtTint(remotePlayer.avatar?.shirt));
  }

  private pruneSnapshots(remoteObject: RemotePlayerObject, renderTimeMs: number) {
    const minKeepTime = renderTimeMs - MAX_BUFFER_SPAN_MS;
    while (
      remoteObject.snapshots.length > 2 &&
      remoteObject.snapshots[1].t < minKeepTime
    ) {
      remoteObject.snapshots.shift();
    }
  }

  private resolveRenderFrame(
    remoteObject: RemotePlayerObject,
    renderTimeMs: number,
  ): RemoteSnapshotFrame {
    const snapshots = remoteObject.snapshots;
    if (snapshots.length === 1) return snapshots[0];

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    if (renderTimeMs <= first.t) return first;

    for (let idx = 0; idx < snapshots.length - 1; idx++) {
      const a = snapshots[idx];
      const b = snapshots[idx + 1];
      if (renderTimeMs < a.t || renderTimeMs > b.t) continue;
      const denom = b.t - a.t;
      const alpha = denom <= 0 ? 1 : (renderTimeMs - a.t) / denom;
      const interpX = a.x + (b.x - a.x) * alpha;
      const interpY = a.y + (b.y - a.y) * alpha;
      const interpVx = a.vx + (b.vx - a.vx) * alpha;
      const interpVy = a.vy + (b.vy - a.vy) * alpha;
      return {
        t: renderTimeMs,
        x: interpX,
        y: interpY,
        vx: interpVx,
        vy: interpVy,
        facing: alpha >= 0.5 ? b.facing : a.facing,
        moving: a.moving || b.moving,
      };
    }

    const elapsedMs = renderTimeMs - last.t;
    if (elapsedMs <= MAX_EXTRAPOLATION_MS) {
      const dt = elapsedMs / 1000;
      return {
        t: renderTimeMs,
        x: last.x + last.vx * dt,
        y: last.y + last.vy * dt,
        vx: last.vx,
        vy: last.vy,
        facing: last.facing,
        moving: last.moving,
      };
    }

    return {
      t: renderTimeMs,
      x: last.x,
      y: last.y,
      vx: 0,
      vy: 0,
      facing: last.facing,
      moving: false,
    };
  }

  private makePlayerVisuals(name: string, shirtHex: string | undefined): {
    base: Phaser.GameObjects.Image;
    shoes: Phaser.GameObjects.Image;
    shirt: Phaser.GameObjects.Image;
    label: Phaser.GameObjects.Text;
    muteIcon: Phaser.GameObjects.Text;
    setShirt: (hex: string | undefined) => void;
  } {
    const layers = makeAvatarLayers(this.scene, shirtHex ?? "#ffffff");
    const { base, shoes, shirt } = layers;
    const label = makeNameLabel(this.scene, name);
    const muteIcon = makeMuteIcon(this.scene);
    return {
      base,
      shoes,
      shirt,
      label,
      muteIcon,
      setShirt: (hex: string | undefined) => shirt.setTint(shirtTint(hex)),
    };
  }
}
