import type Phaser from "phaser";
import type { Direction } from "../../types";

export interface RemoteSnapshotFrame {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: Direction;
  moving: boolean;
}

export interface RemotePlayerObject {
  container: Phaser.GameObjects.Container;
  base: Phaser.GameObjects.Image;
  shoes: Phaser.GameObjects.Image;
  shirt: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  muteIcon: Phaser.GameObjects.Text;
  snapshots: RemoteSnapshotFrame[];
  lastSnapshotTimeMs: number;
  renderFacing: Direction;
  renderMoving: boolean;
  renderVx: number;
  renderVy: number;
  animFrame: number;
  animTimer: number;
  prevAnimMoving: boolean;
  prevAnimDir: Direction;
}
