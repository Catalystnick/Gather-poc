import type Phaser from "phaser";
import type { Direction } from "../../types";

export interface RemotePlayerObject {
  container: Phaser.GameObjects.Container;
  base: Phaser.GameObjects.Image;
  shoes: Phaser.GameObjects.Image;
  shirt: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  muteIcon: Phaser.GameObjects.Text;
  tween: Phaser.Tweens.Tween | null;
  lastCol: number;
  lastRow: number;
  animFrame: number;
  animTimer: number;
  prevAnimMoving: boolean;
  prevAnimDir: Direction;
}
