import type Phaser from "phaser";
import type { Direction } from "../../../types";

export interface RpObj {
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

export interface GraveNote {
  iid: string;
  x: number;
  y: number;
  headline: string;
  subline: string;
}

export interface TraderNote {
  iid: string;
  x: number;
  y: number;
  hintOffsetX: number;
  hintOffsetY: number;
  label: string;
  welcome: string;
}

export interface StatueLore {
  iid: string;
  x: number;
  y: number;
  text: string;
}
