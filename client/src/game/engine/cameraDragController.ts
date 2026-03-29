import Phaser from "phaser";
import {
  CAMERA_LERP,
  CAMERA_RESET_BLEND_MS,
  CAMERA_RESET_LERP,
} from "./constants";

interface CameraDragControllerOptions {
  scene: Phaser.Scene;
}

/** Handles camera drag-detach and smooth follow reset behavior. */
export class CameraDragController {
  private scene: Phaser.Scene;
  private isDragging = false;
  private isDetached = false;
  private dragLastX = 0;
  private dragLastY = 0;

  constructor(options: CameraDragControllerOptions) {
    this.scene = options.scene;
  }

  /** Stop active dragging without changing detached/follow state. */
  stopDragging() {
    this.isDragging = false;
  }

  /** Wire pointer listeners to support camera dragging. */
  enable(isInteractionBlocked: () => boolean) {
    this.scene.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (isInteractionBlocked()) return;
      this.isDragging = true;
      this.isDetached = true;
      this.dragLastX = pointer.x;
      this.dragLastY = pointer.y;
      this.scene.cameras.main.stopFollow();
    });

    this.scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.isDragging || !pointer.isDown) return;
      const camera = this.scene.cameras.main;
      const dragDeltaX = (pointer.x - this.dragLastX) / camera.zoom;
      const dragDeltaY = (pointer.y - this.dragLastY) / camera.zoom;
      camera.scrollX -= dragDeltaX;
      camera.scrollY -= dragDeltaY;
      this.dragLastX = pointer.x;
      this.dragLastY = pointer.y;
    });

    const stopDrag = () => {
      this.isDragging = false;
    };
    this.scene.input.on("pointerup", stopDrag);
    this.scene.input.on("pointerupoutside", stopDrag);
  }

  /** Re-attach camera follow smoothly after drag mode ends. */
  resetFollowToPlayer(playerContainer: Phaser.GameObjects.Container) {
    if (!this.isDetached) return;
    const camera = this.scene.cameras.main;
    this.isDragging = false;
    camera.startFollow(
      playerContainer,
      true,
      CAMERA_RESET_LERP,
      CAMERA_RESET_LERP,
    );
    this.isDetached = false;
    this.scene.time.delayedCall(CAMERA_RESET_BLEND_MS, () => {
      if (this.isDetached) return;
      camera.setLerp(CAMERA_LERP, CAMERA_LERP);
    });
  }
}
