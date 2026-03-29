import type Phaser from "phaser";
import type { Direction, RemotePlayer } from "../../types";
import { IDLE_FPS, IDLE_FRAMES, TILE_PX, TWEEN_DUR, WALK_FPS, WALK_FRAMES, tileCenter } from "./constants";
import { makeAvatarLayers, makeMuteIcon, makeNameLabel, setAvatarFrame, shirtTint } from "./avatarVisualFactory";
import type { RemotePlayerObject } from "./types";

interface RemotePlayerControllerOptions {
  scene: Phaser.Scene;
}

/** Manages remote player create/update/tween/animation/mute/depth lifecycle. */
export class RemotePlayerController {
  private scene: Phaser.Scene;
  private remoteObjects = new Map<string, RemotePlayerObject>();
  private remoteSnapshots = new Map<string, { col: number; row: number; direction: Direction }>();

  constructor(options: RemotePlayerControllerOptions) {
    this.scene = options.scene;
  }

  /** Create, update, or destroy remote player visuals for the latest socket state. */
  sync(remotePlayers: Map<string, RemotePlayer>) {
    for (const [playerId, remoteObject] of this.remoteObjects) {
      if (!remotePlayers.has(playerId)) {
        remoteObject.tween?.stop();
        remoteObject.container.destroy(true);
        this.remoteObjects.delete(playerId);
        this.remoteSnapshots.delete(playerId);
      }
    }

    for (const [playerId, remotePlayer] of remotePlayers) {
      const snapshot = this.remoteSnapshots.get(playerId);
      if (!this.remoteObjects.has(playerId)) {
        this.addRemote(playerId, remotePlayer);
      } else if (!snapshot || snapshot.col !== remotePlayer.col || snapshot.row !== remotePlayer.row) {
        this.tweenRemote(playerId, remotePlayer);
      } else if (snapshot.direction !== remotePlayer.direction) {
        const remoteObject = this.remoteObjects.get(playerId)!;
        setAvatarFrame(
          remoteObject.base,
          remoteObject.shoes,
          remoteObject.shirt,
          IDLE_FRAMES[remotePlayer.direction]?.[0] ?? IDLE_FRAMES.down[0],
        );
      }

      const remoteObject = this.remoteObjects.get(playerId);
      if (remoteObject) remoteObject.shirt.setTint(shirtTint(remotePlayer.avatar?.shirt));
      this.remoteSnapshots.set(playerId, {
        col: remotePlayer.col,
        row: remotePlayer.row,
        direction: remotePlayer.direction,
      });
    }
  }

  /** Advance remote walk/idle animation frames using replicated state. */
  updateAnimations(dt: number, remotePlayers: Map<string, RemotePlayer>) {
    for (const [playerId, remoteObject] of this.remoteObjects) {
      const remotePlayer = remotePlayers.get(playerId);
      if (!remotePlayer) continue;

      if (
        remoteObject.prevAnimMoving !== remotePlayer.moving ||
        remoteObject.prevAnimDir !== remotePlayer.direction
      ) {
        remoteObject.animFrame = 0;
        remoteObject.animTimer = 0;
        remoteObject.prevAnimMoving = remotePlayer.moving;
        remoteObject.prevAnimDir = remotePlayer.direction;
      }

      if (remotePlayer.moving) {
        const frames = WALK_FRAMES[remotePlayer.direction];
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
        const frames = IDLE_FRAMES[remotePlayer.direction];
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
    const { x, y } = tileCenter(remotePlayer.col, remotePlayer.row);
    const { base, shoes, shirt, label, muteIcon, setShirt } = this.makePlayerVisuals(
      remotePlayer.name,
      remotePlayer.avatar?.shirt,
    );
    const container = this.scene.add.container(x, y, [
      base,
      shoes,
      shirt,
      label,
      muteIcon,
    ]);

    setShirt(remotePlayer.avatar?.shirt);
    setAvatarFrame(
      base,
      shoes,
      shirt,
      IDLE_FRAMES[remotePlayer.direction]?.[0] ?? IDLE_FRAMES.down[0],
    );

    this.remoteObjects.set(playerId, {
      container,
      base,
      shoes,
      shirt,
      label,
      muteIcon,
      tween: null,
      lastCol: remotePlayer.col,
      lastRow: remotePlayer.row,
      animFrame: 0,
      animTimer: 0,
      prevAnimMoving: remotePlayer.moving,
      prevAnimDir: remotePlayer.direction,
    });
  }

  private tweenRemote(playerId: string, remotePlayer: RemotePlayer) {
    const remoteObject = this.remoteObjects.get(playerId)!;
    const { x, y } = tileCenter(remotePlayer.col, remotePlayer.row);

    remoteObject.tween?.stop();
    remoteObject.tween = this.scene.tweens.add({
      targets: remoteObject.container,
      x,
      y,
      duration: TWEEN_DUR * 1000,
      ease: "Linear",
    });

    remoteObject.shirt.setTint(shirtTint(remotePlayer.avatar?.shirt));
    setAvatarFrame(
      remoteObject.base,
      remoteObject.shoes,
      remoteObject.shirt,
      IDLE_FRAMES[remotePlayer.direction]?.[0] ?? IDLE_FRAMES.down[0],
    );
    remoteObject.lastCol = remotePlayer.col;
    remoteObject.lastRow = remotePlayer.row;
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
