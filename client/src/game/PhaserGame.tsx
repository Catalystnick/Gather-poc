import { useEffect, useRef } from "react";
import Phaser from "phaser";
import GameScene from "./scenes/GameScene";

interface Props {
  style?: React.CSSProperties;
}

/** Mount a single Phaser game instance into React and clean it up on unmount. */
export default function PhaserGame({ style }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: "#1a1a2e",
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: "100%",
        height: "100%",
      },
      scene: [GameScene],
      render: {
        antialias: false,
        pixelArt: true,
      },
    });

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", ...style }}
    />
  );
}
