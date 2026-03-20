import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useKeyboardControls } from "@react-three/drei";
import type { Group } from "three";
import AvatarMesh from "./AvatarMesh";
import PlayerLabel from "./PlayerLabel";
import StatusRing from "./StatusRing";
import type { Direction, Player } from "../types";

const SPEED = 5;

interface Props {
  player: Player;
  onMove: (position: { x: number; y: number; z: number }) => void;
  positionRef: React.MutableRefObject<{ x: number; y: number; z: number }>;
  isSpeaking?: boolean;
}

export default function LocalPlayer({ player, onMove, positionRef, isSpeaking }: Props) {
  const ref          = useRef<Group>(null);
  const lastEmit     = useRef(0);
  const directionRef = useRef<Direction>('down');
  const isMovingRef  = useRef(false);
  const [, getKeys]  = useKeyboardControls();

  useFrame((_, delta) => {
    if (!ref.current) return;
    const { forward, backward, left, right } = getKeys();

    const dx = (right ? 1 : 0) - (left ? 1 : 0);
    const dz = (backward ? 1 : 0) - (forward ? 1 : 0);

    ref.current.position.x += dx * SPEED * delta;
    ref.current.position.z += dz * SPEED * delta;

    isMovingRef.current = dx !== 0 || dz !== 0;
    if (dx !== 0 || dz !== 0) {
      if (Math.abs(dx) >= Math.abs(dz)) {
        directionRef.current = dx > 0 ? 'right' : 'left';
      } else {
        // dz > 0 = moving +Z = screen-down = facing down
        // dz < 0 = moving -Z = screen-up   = facing up
        directionRef.current = dz > 0 ? 'down' : 'up';
      }
    }

    const { x, y, z } = ref.current.position;
    positionRef.current = { x, y, z };

    const now = performance.now();
    if (now - lastEmit.current > 50) {
      lastEmit.current = now;
      onMove({ x, y, z });
    }
  });

  return (
    <group ref={ref} position={[0, 0.5, 0]}>
      <AvatarMesh avatar={player.avatar} directionRef={directionRef} isMovingRef={isMovingRef} />
      <PlayerLabel name={player.name} />
      <StatusRing speaking={isSpeaking} />
    </group>
  );
}
